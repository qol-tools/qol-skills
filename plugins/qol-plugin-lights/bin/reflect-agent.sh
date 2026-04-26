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
    plugin-lights|qol-plugin-lights:plugin-lights) ;;
    *) exit 0 ;;
esac

if [ -z "$TRANSCRIPT" ] || [ ! -f "$TRANSCRIPT" ]; then
    log "no transcript at '$TRANSCRIPT'"
    exit 0
fi
if [ -z "$CWD" ]; then CWD="$(pwd)"; fi

# Claude Code stores agent memory at `.claude/agent-memory/{plugin}-{agent}/`
# (colon is not filesystem-safe), so mirror that exact naming here so the
# memory we write is the same memory the agent auto-loads on next run.
AGENT_DIR_NAME="${AGENT_TYPE//:/-}"
MEMORY_DIR="$CWD/.claude/agent-memory/$AGENT_DIR_NAME"
MEMORY_FILE="$MEMORY_DIR/MEMORY.md"
TRACE_FILE="$MEMORY_DIR/.reflect-last.log"
mkdir -p "$MEMORY_DIR"
if [ ! -f "$MEMORY_FILE" ]; then : > "$MEMORY_FILE"; fi

trace() { printf '[%s] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*" >> "$TRACE_FILE"; }
trace "fired for agent_type=$AGENT_TYPE dir=$AGENT_DIR_NAME"

# Cap by bytes not lines — tool-heavy sessions have long JSON lines that blow
# past the CLI's 200k prompt ceiling. 120k leaves headroom for the prompt
# scaffolding and existing memory.
TRANSCRIPT_TAIL=$(tail -c 120000 "$TRANSCRIPT" 2>/dev/null || true)
if [ -z "$TRANSCRIPT_TAIL" ]; then exit 0; fi

EXISTING_MEMORY=$(cat "$MEMORY_FILE" 2>/dev/null || true)
if [ -z "$EXISTING_MEMORY" ]; then EXISTING_MEMORY="(empty)"; fi

PROMPT_HEADER="You are harvesting durable lessons from a Claude Code subagent run for the agent's persistent MEMORY.md. The agent WILL see this memory on its next run in a fresh context — your job is to make sure the things that surprised it this time don't surprise it again."
PROMPT_AGENT="The agent ran as: ${AGENT_TYPE}"
PROMPT_RULES=$(printf '%s\n' \
    "Scan the transcript for signals worth remembering, then emit 0-3 bullets. Bias toward emitting — a mediocre bullet is better than losing a real lesson. Filter the output yourself; don't refuse the whole set because one candidate is borderline." \
    "" \
    "STRONG SIGNALS (emit these):" \
    "- User corrections: 'no', 'stop doing X', 'I told you already', 'why did you' — the correction rule itself is gold." \
    "- User preferences expressed with reasons: 'we do X because Y', 'always', 'never', 'ask first before'." \
    "- Gotchas the agent discovered the hard way: CSS transform breaks getBoundingClientRect, ResizeObserver doesn't fire on transformed parents, bash 3 array-expansion under set -u, hook dir name vs agent dir name, etc. Non-obvious cross-component coupling." \
    "- Repeat-offender failure modes: 'the agent tried N before realizing M'." \
    "- Tool/CLI quirks that cost the agent time: flag that doesn't exist on macOS, subcommand that silently swallows errors." \
    "" \
    "WEAK SIGNALS (skip these):" \
    "- Descriptions of what the agent built this session (that's in the PR/commit)." \
    "- File paths, line numbers, specific function names (they rot)." \
    "- Things already in existing_memory (verbatim or paraphrased)." \
    "- Generic best-practice platitudes the agent would know anyway." \
    "" \
    "FORMAT: markdown bullets starting with '- '. Each bullet ≤150 chars. Lead with the rule, then a short 'because …' clause if the reason matters. No preamble, no headings, no trailing prose." \
    "" \
    "If the transcript genuinely contains zero durable signals, output the single word NONE. But do not output NONE just because each candidate has a minor flaw — emit the best 1-3 you can." \
    "" \
    "Output now.")

if command -v timeout >/dev/null 2>&1; then
    TIMEOUT_CMD=(timeout 120)
elif command -v gtimeout >/dev/null 2>&1; then
    TIMEOUT_CMD=(gtimeout 120)
else
    TIMEOUT_CMD=()
fi

# Run the CLI, with a single automatic retry on "Prompt is too long" where we
# halve the transcript payload. This is a CLI-side truncation error, distinct
# from the model returning prose/NONE, so it deserves its own trace category
# *and* a retry because the first attempt never actually reached the model.
run_claude() {
    local prompt="$1"
    local stderr_file; stderr_file=$(mktemp)
    local out
    out=$(printf '%s' "$prompt" | ${TIMEOUT_CMD[@]+"${TIMEOUT_CMD[@]}"} claude -p --model claude-opus-4-7 --permission-mode bypassPermissions 2>"$stderr_file" || true)
    out=$(printf '%s' "$out" | sed -e 's/[[:space:]]*$//')
    CLAUDE_STDERR_TAIL=$(tr '\n' ' ' < "$stderr_file" | cut -c1-400)
    rm -f "$stderr_file"
    printf '%s' "$out"
}

build_prompt() {
    local transcript="$1"
    printf '%s\n\n%s\n\n<existing_memory>\n%s\n</existing_memory>\n\n<transcript_tail>\n%s\n</transcript_tail>\n\n%s\n' \
        "$PROMPT_HEADER" "$PROMPT_AGENT" "$EXISTING_MEMORY" "$transcript" "$PROMPT_RULES"
}

is_cli_truncation() {
    case "$1" in
        "Prompt is too long"*|*"prompt is too long"*|*"maximum context length"*) return 0 ;;
        *) return 1 ;;
    esac
}

is_cli_error() {
    case "$1" in
        "Error:"*|"error:"*|"Invalid"*|"API Error"*) return 0 ;;
        *) return 1 ;;
    esac
}

PROMPT=$(build_prompt "$TRANSCRIPT_TAIL")
RESPONSE=$(run_claude "$PROMPT")

if is_cli_truncation "$RESPONSE"; then
    trace "cli truncation on first attempt; retrying with half transcript"
    HALF_LEN=$(( ${#TRANSCRIPT_TAIL} / 2 ))
    TRANSCRIPT_TAIL=${TRANSCRIPT_TAIL: -$HALF_LEN}
    PROMPT=$(build_prompt "$TRANSCRIPT_TAIL")
    RESPONSE=$(run_claude "$PROMPT")
    if is_cli_truncation "$RESPONSE"; then
        trace "cli truncation on retry too; giving up (transcript still exceeds limit)"
        exit 0
    fi
fi

if [ -z "$RESPONSE" ]; then
    trace "claude returned empty; stderr: $CLAUDE_STDERR_TAIL"
    exit 0
fi
if is_cli_error "$RESPONSE"; then
    trace "cli error: $(printf '%s' "$RESPONSE" | cut -c1-200)"
    exit 0
fi
if [ "$RESPONSE" = "NONE" ]; then trace "claude returned NONE (no lessons proposed)"; exit 0; fi

BULLETS=$(printf '%s\n' "$RESPONSE" | grep -E '^[[:space:]]*-[[:space:]]' || true)
if [ -z "$BULLETS" ]; then
    trace "model returned prose, not bullets (first 200 chars: $(printf '%s' "$RESPONSE" | tr '\n' ' ' | cut -c1-200))"
    exit 0
fi
RESPONSE="$BULLETS"

SIZE=$(printf '%s' "$RESPONSE" | wc -c | tr -d ' ')
if [ "$SIZE" -gt 1500 ]; then
    trace "rejected: $SIZE bytes exceeds 1500"
    exit 0
fi

# Dedupe by distinctive-word overlap. Literal substring matching is too strict
# (missed paraphrases like "always use ToggleSwitch" vs "route through
# ToggleSwitch"), so normalize both sides to lowercase-alphanumeric, pull the
# ≥5-char words out of the candidate, and reject if ≥60% of those words
# already appear in the memory file as whole-word matches.
normalize() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]' | sed -e 's/[^a-z0-9 ]/ /g' -e 's/  */ /g'; }
MEMORY_NORM=$(normalize "$(cat "$MEMORY_FILE" 2>/dev/null || true)")

is_paraphrase_of_existing() {
    local line_norm total=0 hits=0 word
    line_norm=$(normalize "$1")
    for word in $line_norm; do
        [ ${#word} -lt 5 ] && continue
        case "$word" in always|never|should|would|could|really|still|plugin|plugins) continue;; esac
        total=$((total + 1))
        if printf ' %s ' "$MEMORY_NORM" | grep -qF " $word "; then
            hits=$((hits + 1))
        fi
    done
    [ "$total" -ge 4 ] && [ $((hits * 100 / total)) -ge 60 ]
}

FILTERED=""
while IFS= read -r line; do
    if [ -z "$line" ]; then continue; fi
    body=${line#*-}
    body=${body# }
    body_trim=$(printf '%s' "$body" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
    if [ -z "$body_trim" ]; then continue; fi
    if is_paraphrase_of_existing "$body_trim"; then continue; fi
    FILTERED="${FILTERED}${line}"$'\n'
done <<EOF
$(printf '%s\n' "$RESPONSE" | grep -E '^[[:space:]]*-[[:space:]]')
EOF

FILTERED=$(printf '%s' "$FILTERED" | sed -e 's/[[:space:]]*$//')
if [ -z "$FILTERED" ]; then trace "all proposed bullets were duplicates of existing memory"; exit 0; fi

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

APPENDED_LINES=$(printf '%s\n' "$FILTERED" | grep -cE '^[[:space:]]*-[[:space:]]' || true)
trace "appended $APPENDED_LINES lesson(s) to $MEMORY_FILE"
log "appended lessons to $MEMORY_FILE"
exit 0
