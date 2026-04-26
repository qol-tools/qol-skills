#!/usr/bin/env bash
# PreToolUse hook (Bash matcher): block any `git commit` whose message contains
# AI attribution configured in data/blocked-ai-attribution-patterns.txt.
#
# Fuzzy patterns are intentionally aggressive — false positives are cheap
# (re-write the message), false negatives are the actual problem we're guarding.
#
# Scans:
#   - the bash command itself (catches -m "..." and HEREDOCs inline)
#   - the file referenced by -F / --file (if present and readable)

set -uo pipefail

JSON=$(cat 2>/dev/null || true)
[ -z "$JSON" ] && exit 0
command -v jq >/dev/null 2>&1 || exit 0

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PLUGIN_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
PATTERN_FILE="${COMMIT_DENY_COAUTHOR_PATTERNS:-$PLUGIN_ROOT/data/blocked-ai-attribution-patterns.txt}"

TOOL=$(printf '%s' "$JSON" | jq -r '.tool_name // .tool // empty')
[ "$TOOL" = "Bash" ] || exit 0

CMD=$(printf '%s' "$JSON" | jq -r '.tool_input.command // empty')
[ -z "$CMD" ] && exit 0

# Only fire on real commit invocations.
printf '%s' "$CMD" | grep -qE '(^|[[:space:];&|`])git[[:space:]]+([a-z-]+[[:space:]]+)*commit([[:space:]]|$)' || exit 0

HAYSTACK="$CMD"

# If the commit reads from a file (-F / --file), include its contents.
FILE_ARG=$(printf '%s' "$CMD" | grep -oE -- '(-F|--file)([= ][^[:space:]]+)' | head -1 | sed -E 's/^(-F|--file)[= ]?//')
if [ -n "$FILE_ARG" ] && [ -f "$FILE_ARG" ]; then
    HAYSTACK="$HAYSTACK
$(cat "$FILE_ARG" 2>/dev/null || true)"
fi

[ -f "$PATTERN_FILE" ] || exit 0
PATTERN=$(awk '
    /^[[:space:]]*#/ { next }
    /^[[:space:]]*$/ { next }
    {
        gsub(/^[[:space:]]+|[[:space:]]+$/, "")
        if (pattern == "") {
            pattern = "(" $0 ")"
            next
        }
        pattern = pattern "|(" $0 ")"
    }
    END { print pattern }
' "$PATTERN_FILE")
[ -n "$PATTERN" ] || exit 0

if printf '%s' "$HAYSTACK" | grep -qiE "$PATTERN"; then
    cat >&2 <<'EOF'
git commit BLOCKED by qol-host:commit-deny-coauthor hook.

The commit message contains blocked AI attribution.
Blocked patterns are configured in:
  data/blocked-ai-attribution-patterns.txt

qol-tools rule (plugin:qol-host:commit skill):
  NEVER add Co-Authored-By or any AI attribution to commits.
  This has been stated repeatedly by the author. It is not negotiable.

Re-attempt the commit with a clean message — subject + optional body only.
No trailers. No emoji-attribution footer.
EOF
    exit 2
fi

exit 0
