#!/usr/bin/env bash
# PreToolUse hook (Bash matcher): when Claude is about to run `git commit`,
# inject the qol-tools `commit` skill content as additionalContext so Claude
# is reminded of the conventions BEFORE forming the commit message.
#
# This is the proactive half. The reactive half is `commit-deny-coauthor.sh`,
# which blocks commits whose message already contains an AI attribution.
#
# Silent on errors — a failing reminder must never block a commit.

set -uo pipefail

JSON=$(cat 2>/dev/null || true)
[ -z "$JSON" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

TOOL=$(printf '%s' "$JSON" | jq -r '.tool_name // .tool // empty')
[ "$TOOL" = "Bash" ] || exit 0

CMD=$(printf '%s' "$JSON" | jq -r '.tool_input.command // empty')
[ -z "$CMD" ] && exit 0

# Only fire on real commit invocations. Skip log/status/diff/etc.
printf '%s' "$CMD" | grep -qE '(^|[[:space:];&|`])git[[:space:]]+([a-z-]+[[:space:]]+)*commit([[:space:]]|$)' || exit 0

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$(realpath "$0" 2>/dev/null || readlink -f "$0")")/.." && pwd)}"
SKILL_FILE="$PLUGIN_ROOT/skills/commit/SKILL.md"
[ -f "$SKILL_FILE" ] || exit 0

# Strip frontmatter (everything between first two '---' markers)
SKILL_BODY=$(awk '
    BEGIN { p = 0 }
    /^---[[:space:]]*$/ { p++; next }
    p >= 2 { print }
' "$SKILL_FILE")

[ -z "$SKILL_BODY" ] && exit 0

CONTEXT="REMINDER from pre-commit hook (plugin:qol-host:commit skill):

$SKILL_BODY

Apply these rules to the commit you are about to make. The hard rule on no
AI attribution is enforced by a separate deny hook — do not test it."

# Emit additionalContext via PreToolUse hookSpecificOutput. If this Claude
# Code version doesn't propagate it, the deny hook is the safety net.
jq -n --arg ctx "$CONTEXT" '{
    "hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "additionalContext": $ctx
    }
}'

exit 0
