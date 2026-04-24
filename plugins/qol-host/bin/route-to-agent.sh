#!/usr/bin/env bash
# PreToolUse hook: force edits to qol-tray frontend/backend scope through the
# specialized qol-tray-frontend / qol-tray-backend subagents. Main-Claude edits
# are blocked with exit 2; the error message tells Claude which agent to route
# through and how to bypass explicitly if the edit is genuinely trivial.
#
# Bypass (Claude-side, deliberate):
#   touch .claude/bypass-agent-routing          # single Edit pass
#   echo N > .claude/bypass-agent-routing       # N Edits pass, auto-cleaned
#
# Silent on errors — a failing hook must never block the user's session in an
# unrecoverable way. If jq is missing, or the JSON is malformed, we exit 0.

set -uo pipefail

log() { printf '[route-to-agent] %s\n' "$*" >&2; }

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

# Only guard qol-tray paths. Edits outside the qol-tray repo are unaffected.
case "$PATH_ARG" in
    *"/qol-tray/ui/views/"*|*"/qol-tray/ui/components/"*|*"/qol-tray/ui/lib/"*|*"/qol-tray/ui/app/"*|*"/qol-tray/ui/palette/"*|*"/qol-tray/ui/hooks/"*|*"/qol-tray/ui/styles/"*)
        AGENT="qol-host:qol-tray-frontend"
        ;;
    *"/qol-tray/src/"*)
        AGENT="qol-host:qol-tray-backend"
        ;;
    *) exit 0 ;;
esac

# Test/memory/docs exceptions — edits to tests sit alongside implementation
# in the agent's scope, but MEMORY.md and .reflect-last.log are hook-owned
# files. Allow them unconditionally so reflection stays unblocked.
case "$PATH_ARG" in
    */MEMORY.md|*/.reflect-last.log) exit 0 ;;
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

# Block with a self-documenting message. exit 2 sends stderr back to Claude
# as a tool-result error, so the block message shows up in-context.
cat >&2 <<EOF
Edit to $PATH_ARG is blocked: qol-tray frontend/backend scope must route through the specialized agent.

Invoke the agent via:
  Agent(subagent_type="$AGENT", prompt="...")

To bypass for this change (Claude-side, deliberate):
  Bash("touch ${MARKER#"$CWD/"}")                    # single Edit pass
  Bash("echo 3 > ${MARKER#"$CWD/"}")                 # N Edits pass

The marker is auto-consumed per Edit; no cleanup needed.
EOF
exit 2
