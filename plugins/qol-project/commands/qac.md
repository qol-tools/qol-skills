---
description: Run the qol-arch-code, cross-platform, cicd, logging, plugin data and plugin-contract hooks over whole files in the current repo
---

!`node "${CLAUDE_PLUGIN_ROOT}/scripts/qac.mjs" lint --pretty --open $ARGUMENTS`

Print the output above verbatim. `/qac [path ...]` lints those paths, or the whole repo with none. The `qac` typed-verb prompt hook runs the same CLI with no model turn: `qac lint`, `qac lint plugins/launcher`, `qac fix <path>` (hands the findings to the session to fix), `qac slip <pattern> --from <url>` (records a pattern qac missed and forks a lane to add its rule), `qac slips` (lists them).

The judge verbs run from the terminal as `qac <verb>` (the `bin/qac` launcher) or `node "${CLAUDE_PLUGIN_ROOT}/scripts/qac.mjs" <verb>`; all print JSON, or text with `--pretty`:

- `qac gate` judges the working tree with the repo's judges and prints a verdict (`clean`, `findings`, `could_not_judge`, `flaky_only`); every flag is in `qac help --pretty`.
- `qac trust` exits 0 when the judges, setup commands and `--accept` commands are approved, 1 when anything is not; `qac trust approve` records the approval and needs a person at the keyboard.
- `qac traps` lists findings that were caught on the first attempt in several loops.
- `qac init` writes a starter `.qac/judges.json`.
- `qac slip --fingerprint <fp> --from <source>` records a gate finding that a rule should catch.

Exit codes: 0 clean, 1 findings, 2 usage, 3 not a git repository, 4 slip lane could not be forked, 5 could not judge, 6 only flaky judges failed.
