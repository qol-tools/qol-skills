#!/usr/bin/env bash
# SubagentStop hook: after a qol-host agent finishes, ask Claude (Opus, via the
# local `claude` CLI so no API key is required) to propose durable lessons for
# MEMORY.md based on the transcript. Append + auto-commit any accepted bullets.
#
# Runs headlessly. All errors are silent — a failing hook must never block
# the user's session.

set -uo pipefail

log() { printf '[reflect-agent] %s\n' "$*" >&2; }

JSON=$(cat 2>/dev/null || true)
if [ -z "$JSON" ]; then exit 0; fi

if ! command -v jq >/dev/null 2>&1; then log "jq missing — skipping"; exit 0; fi
if ! command -v claude >/dev/null 2>&1; then log "claude CLI missing — skipping"; exit 0; fi

AGENT_TYPE=$(printf '%s' "$JSON" | jq -r '.agent_type // empty')
TRANSCRIPT=$(printf '%s' "$JSON" | jq -r '.agent_transcript_path // .transcript_path // empty')
CWD=$(printf '%s' "$JSON" | jq -r '.cwd // empty')

case "$AGENT_TYPE" in
    qol-tray-frontend|qol-tray-backend|qol-host:qol-tray-frontend|qol-host:qol-tray-backend) ;;
    *) exit 0 ;;
esac

if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
    log "no transcript at '$TRANSCRIPT'"
    exit 0
fi
if [ -z "$CWD" ]; then CWD="$(pwd)"; fi

AGENT_DIR_NAME="${AGENT_TYPE#*:}"
MEMORY_DIR="$CWD/.claude/agent-memory/$AGENT_DIR_NAME"
MEMORY_FILE="$MEMORY_DIR/MEMORY.md"
mkdir -p "$MEMORY_DIR"
if [ ! -f "$MEMORY_FILE" ]; then : > "$MEMORY_FILE"; fi

TRANSCRIPT_TAIL=$(tail -n 600 "$TRANSCRIPT" 2>/dev/null || true)
if [ -z "$TRANSCRIPT_TAIL" ]; then exit 0; fi

EXISTING_MEMORY=$(cat "$MEMORY_FILE" 2>/dev/null || true)
if [ -z "$EXISTING_MEMORY" ]; then EXISTING_MEMORY="(empty)"; fi

PROMPT_HEADER="You are reviewing a Claude Code subagent run to propose durable additions to the agent's persistent MEMORY.md."
PROMPT_AGENT="The agent ran as: ${AGENT_TYPE}"
PROMPT_RULES=$(printf '%s\n' \
    "Propose 0-3 durable, non-obvious lessons that will help this agent on FUTURE tasks in a different session." \
    "" \
    "STRICT RULES — a single violation means output NONE:" \
    "- Never duplicate anything already in existing_memory." \
    "- Never add ephemeral task details (current bug, current file, current feature)." \
    "- Never add patterns derivable by reading the codebase." \
    "- Never add git history or commit-specific facts." \
    "- Only add: user preferences with why, repeat-offender failure modes, architectural constraints not obvious from a single file." \
    "- Output format: markdown bullets starting with '- ', each under 150 chars. No preamble. No headings. No trailing prose." \
    "- If nothing passes the bar, output the single word NONE." \
    "" \
    "Output now.")

PROMPT=$(printf '%s\n\n%s\n\n<existing_memory>\n%s\n</existing_memory>\n\n<transcript_tail>\n%s\n</transcript_tail>\n\n%s\n' \
    "$PROMPT_HEADER" "$PROMPT_AGENT" "$EXISTING_MEMORY" "$TRANSCRIPT_TAIL" "$PROMPT_RULES")

if command -v timeout >/dev/null 2>&1; then
    TIMEOUT_CMD=(timeout 120)
elif command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_CMD=(gtimeout 120)
else
    TIMEOUT_CMD=()
fi

RESPONSE=$(printf '%s' "$PROMPT" | ${TIMEOUT_CMD[@]+"${TIMEOUT_CMD[@]}"} claude -p --model claude-opus-4-7 --permission-mode bypassPermissions 2>/dev/null || true)
RESPONSE=$(printf '%s' "$RESPONSE" | sed -e 's/[[:space:]]*$//')

if [ -z "$RESPONSE" ] || [ "$RESPONSE" = "NONE" ]; then exit 0; fi

if printf '%s\n' "$RESPONSE" | grep -qvE '^[[:space:]]*(-[[:space:]].*|$)'; then
    log "rejected: non-bullet line present"
    exit 0
fi

SIZE=$(printf '%s' "$RESPONSE" | wc -c | tr -d ' ')
if [ "$SIZE" -gt 800 ]; then
    log "rejected: $SIZE bytes exceeds 800"
    exit 0
fi

FILTERED=""
while IFS= read -r line; do
    if [ -z "$line" ]; then continue; fi
    body=${line#*-}
    body=${body# }
    body_trim=$(printf '%s' "$body" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    if [ -n "$body_trim" ] && ! grep -qF -- "$body_trim" "$MEMORY_FILE"; then
        FILTERED="${FILTERED}${line}"$'\n'
    fi
done <<EOF
$(printf '%s\n' "$RESPONSE" | grep -E '^[[:space:]]*-[[:space:]]')
EOF

FILTERED=$(printf '%s' "$FILTERED" | sed -e 's/[[:space:]]*$//')
if [ -z "$FILTERED" ]; then exit 0; fi

{
    printf '\n## %s\n' "$(date -u +%Y-%m-%d)"
    printf '%s\n' "$FILTERED"
} >> "$MEMORY_FILE"

TMP=$(mktemp)
tail -n 200 "$MEMORY_FILE" > "$TMP" && mv "$TMP" "$MEMORY_FILE"

REPO_ROOT=$(git -C "$MEMORY_DIR" rev-parse --show-toplevel 2>/dev/null || true)
if [ -n "$REPO_ROOT" ]; then
    git -C "$REPO_ROOT" add "$MEMORY_FILE" >/dev/null 2>&1 || true
    git -C "$REPO_ROOT" -c commit.gpgsign=false commit \
        --only "$MEMORY_FILE" \
        -m "agent-memory(${AGENT_DIR_NAME}): auto-append lessons" \
        >/dev/null 2>&1 || true
fi

log "appended lessons to $MEMORY_FILE"
exit 0
