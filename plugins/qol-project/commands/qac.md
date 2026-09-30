---
description: Run the qol-arch-code, cross-platform, cicd and logging hooks over whole files in the current repo
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/qac.mjs" lint --pretty --open $ARGUMENTS`

Print the output above verbatim. `/qac [path ...]` lints those paths, or the whole repo with none. The `qac` typed-verb prompt hook runs the same CLI with no model turn: `qac lint`, `qac lint plugins/launcher`, `qac fix <path>` (hands the findings to the session to fix).
