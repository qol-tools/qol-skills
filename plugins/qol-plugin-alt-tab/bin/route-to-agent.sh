#!/usr/bin/env bash
# PreToolUse hook: force edits inside the plugin-alt-tab repo through the
# specialist subagent. Mirrors qol-host's route-to-agent.sh, but scoped to
# plugin-alt-tab paths only.
#
# Bypass (Claude-side, deliberate):
#   touch .claude/bypass-agent-routing          # single Edit pass
#   echo N > .claude/bypass-agent-routing       # N Edits pass, auto-cleaned
#
# Silent on errors — a failing hook must never block the user's session in an
# unrecoverable way.

set -uo pipefail

log() { printf '[plugin-alt-tab/route-to-agent] %s\n' "$*" >&2; }

JSON=$(cat 2>/dev/null || true)
[ -z "$JSON" ] && exit 0

if ! command -v jq >/dev/null 2>&1; then exit 0; fi

TOOL=$(printf '%s' "$JSON" | jq -r '.tool_name // .tool // empty')
case "$TOOL" in
    Edit|Write|NotebookEdit) ;;
    *) exit 0 ;;
esac

# Inside a subagent → let through. The agent is doing the work by design.
AGENT_TYPE=$(printf '%s' "$JSON" | jq -r '.agent_type // empty')
[ -n "$AGENT_TYPE" ] && exit 0

PATH_ARG=$(printf '%s' "$JSON" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')
[ -z "$PATH_ARG" ] && exit 0

# Only guard files inside the plugin-alt-tab repo.
case "$PATH_ARG" in
    *"/plugin-alt-tab/src/"*|*"/plugin-alt-tab/ui/"*|*"/plugin-alt-tab/tests/"*|*"/plugin-alt-tab/"*"plugin.toml"|*"/plugin-alt-tab/"*"Cargo.toml")
        AGENT="qol-plugin-alt-tab:plugin-alt-tab"
        ;;
    *) exit 0 ;;
esac

# Hook-owned files (memory, reflection traces, READMEs, etc.) — let through so
# the agent's own bookkeeping isn't blocked when this runs in non-subagent mode.
case "$PATH_ARG" in
    */MEMORY.md|*/.reflect-last.log|*/README.md|*/CHANGELOG.md) exit 0 ;;
esac

CWD=$(printf '%s' "$JSON" | jq -r '.cwd // empty')
[ -z "$CWD" ] && CWD="$(pwd)"
MARKER="$CWD/.claude/bypass-agent-routing"

if [ -f "$MARKER" ]; then
    COUNT=$(cat "$MARKER" 2>/dev/null | tr -d '[:space:]')
    if [[ "$COUNT" =~ ^[0-9]+$ ]] && [ "$COUNT" -gt 1 ]; then
        printf '%s' "$((COUNT - 1))" > "$MARKER"
        log "bypass consumed ($((COUNT - 1)) remaining)"
    else
        rm -f "$MARKER"
        log "bypass consumed (marker removed)"
    fi
    exit 0
fi

cat >&2 <<EOF
Edit to $PATH_ARG is blocked: plugin-alt-tab scope must route through its specialist agent.

Invoke via:
  Agent(subagent_type="$AGENT", prompt="...")

To bypass for this change (Claude-side, deliberate):
  Bash("touch ${MARKER#"$CWD/"}")                    # single Edit pass
  Bash("echo 3 > ${MARKER#"$CWD/"}")                 # N Edits pass

The marker is auto-consumed per Edit; no cleanup needed.
EOF
exit 2
