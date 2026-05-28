---
name: qol-cicd-infra
description: >
  Use when discussing, designing, or modifying CI workflows, git hooks, or repo
  bootstrap across qol-tools. qol-cicd already owns this; read it BEFORE
  proposing anything new. Loaded automatically by a PreToolUse hook when Bash
  commands touch CI/hook keywords.
---

# qol-cicd is the source of truth

For org-wide CI, shared git hooks, and repo bootstrap inside `qol-tools`.

## Read before designing

- `qol-cicd/.github/workflows/` - reusable workflow definitions (`lib-lint`,
  `lib-tests`, `lib-version`, `plugin-lint`, `plugin-tests`, `plugin-version`,
  `plugin-release`, `file-sync`, `auto-label-plugins`, `qol-tray-release`,
  `release-plugins`, `pr-labeler`, `test-standards`).
- `qol-cicd/hooks/` - shared local hooks (`pre-commit`, `commit-msg`). Installed
  into each sibling repo by `qol-install-hooks`.
- `qol-cicd/bin/` - cross-repo commands: `qol-install-hooks`, `qol-sync`,
  `qol-repo-status`, `qol-install-merge-driver`, `qol-gh-account`. Activated by
  sourcing `bin/activate.sh`.

## How repos consume it

Each qol-* repo's `.github/workflows/lint.yml` (or `ci.yml`, `tests.yml`,
`version.yml`, `release.yml`) is a 3-line caller of the matching reusable
workflow in `qol-cicd`. Don't duplicate workflow logic per repo; extend
qol-cicd and let callers pick it up.

## Extending, not duplicating

If a desired behavior is missing:

1. Check whether an existing reusable workflow / hook covers it.
2. If a gap is real, extend the canonical file in `qol-cicd` (not in N caller
   repos). Callers stay 3 lines.
3. For local-side gaps, add a hook to `qol-cicd/hooks/` and re-run
   `qol-install-hooks` so every clone picks it up.

## Anti-patterns to refuse

- Designing a fresh CI/hook system without first reading `qol-cicd/`.
- Adding per-repo workflow logic when a reusable workflow exists.
- Proposing third-party hook managers (cargo-husky, lefthook, husky) before
  checking what `qol-install-hooks` + `qol-cicd/hooks/` already deliver.
