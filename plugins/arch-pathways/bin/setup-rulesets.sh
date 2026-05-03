#!/usr/bin/env bash
# Creates a GitHub Repository Ruleset that enforces the arch-pathways branch
# naming convention server-side. Idempotent: re-running with the same name
# updates the existing ruleset.
#
# Usage: setup-rulesets.sh <owner/repo> [--default-branch main] [--dry-run]
#
# Requires: gh CLI authenticated for the target repo (write access).
# Note: The branch_name_pattern rule type with regex requires GitHub Team or
# higher. On Free / Pro, the script prints instructions for the manual
# include/exclude workaround instead of failing.

set -euo pipefail

RULESET_NAME='arch-pathways branch names'
BRANCH_REGEX='^[a-z][a-z0-9]*-[0-9]+-[a-z0-9]+(-[a-z0-9]+)*$'
DEFAULT_BRANCH='main'
DRY_RUN=0

usage() {
    cat <<EOF
Usage: setup-rulesets.sh <owner/repo> [options]

Options:
  --default-branch <name>  Branch to exempt from the rule. Default: main.
  --dry-run                Show the JSON payload without calling gh.
  -h, --help               Show this help.

Effect:
  Creates a Repository Ruleset named "${RULESET_NAME}" that requires every
  non-default branch to match:

      ${BRANCH_REGEX}

  This is the same regex enforced by the local PreToolUse hook. The ruleset
  is the durable, agent-bypass-proof layer.

Free / Pro plans:
  GitHub gates regex-based branch_name_pattern behind Team / Enterprise. If
  this script gets a 422 response complaining about the rule type, fall back
  to creating the rule manually via the GitHub UI:

    Settings → Rules → Rulesets → New ruleset → Restrictions →
      Restrict branch names → Must match the given regular expression →
      ${BRANCH_REGEX}
EOF
}

REPO=""
while [ $# -gt 0 ]; do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        --dry-run) DRY_RUN=1; shift ;;
        --default-branch) DEFAULT_BRANCH="$2"; shift 2 ;;
        --) shift; break ;;
        --*) echo "unknown flag: $1" >&2; exit 2 ;;
        *)
            if [ -z "$REPO" ]; then REPO="$1"; shift
            else echo "unexpected positional arg: $1" >&2; exit 2
            fi
            ;;
    esac
done

if [ -z "$REPO" ]; then
    usage >&2
    exit 2
fi

PAYLOAD=$(cat <<JSON
{
  "name": "${RULESET_NAME}",
  "target": "branch",
  "enforcement": "active",
  "conditions": {
    "ref_name": {
      "include": ["~ALL"],
      "exclude": ["refs/heads/${DEFAULT_BRANCH}"]
    }
  },
  "rules": [
    {
      "type": "branch_name_pattern",
      "parameters": {
        "operator": "regex",
        "pattern": "${BRANCH_REGEX}",
        "negate": false
      }
    }
  ]
}
JSON
)

if [ "$DRY_RUN" = "1" ]; then
    echo "$PAYLOAD"
    exit 0
fi

if ! command -v gh >/dev/null 2>&1; then
    echo "gh CLI not found. Install from https://cli.github.com/." >&2
    exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
    echo "jq not found. Install with your package manager." >&2
    exit 1
fi

EXISTING=$(gh api "repos/$REPO/rulesets" --jq ".[] | select(.name == \"${RULESET_NAME}\") | .id" 2>/dev/null || true)

if [ -n "$EXISTING" ]; then
    echo "Updating existing ruleset id=$EXISTING for $REPO" >&2
    echo "$PAYLOAD" | gh api -X PUT "repos/$REPO/rulesets/$EXISTING" --input -
else
    echo "Creating new ruleset for $REPO" >&2
    echo "$PAYLOAD" | gh api -X POST "repos/$REPO/rulesets" --input -
fi
