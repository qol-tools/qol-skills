---
description: Run the qol-arch-code, cross-platform, cicd, logging and plugin data hooks over whole files in the current repo
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/qac.mjs" lint --pretty --open $ARGUMENTS`

Print the output above verbatim. `/qac [path ...]` lints those paths, or the whole repo with none. The `qac` typed-verb prompt hook runs the same CLI with no model turn: `qac lint`, `qac lint plugins/launcher`, `qac fix <path>` (hands the findings to the session to fix), `qac slip <pattern> --from <url>` (records a pattern qac missed and forks a lane to add its rule), `qac slips` (lists them).
