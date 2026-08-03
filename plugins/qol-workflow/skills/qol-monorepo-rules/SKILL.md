---
name: qol-monorepo-rules
description: Always-on delivery rules for work inside qol-tools repositories - PR opt-in, standards evolution, guest-VM verification, and the build/test gate before reporting done. Injected unconditionally by the qol-monorepo-rules-context UserPromptSubmit hook; these rules must fire without a topic trigger.
---

# qol-tools delivery rules

These are unconditional. They previously lived in the monorepo's root `CLAUDE.md`,
which only Claude Code loaded. They are injected by hook so every agent gets them.

## PRs are opt-in. Default is commit-direct-to-main.

Default all work (tests, refactors, fixes, features, configs, docs) direct to
`main`. Open a PR, issue, or ADR **only when explicitly asked**; never offer one
as a fallback. Mechanics: `qol-workflow:git-trees`.

## Standards evolution

Found a practice better than the current standard? Encode it as a skill or rule
**before** applying it, so the next session starts from the new baseline. Place
it with `qol-workflow:standards-evolution`.

## Runtime behavior verifies in a guest VM

Reproducing or verifying qol runtime desktop behavior (plugin windows, hotkeys,
previews, tray actions) happens in a disposable guest,
`qol env up <environment> --dev-worktree <worktree>`, never on the host session,
unless the user explicitly asks for host verification. This applies to bug
repros before fixing and to fix verification after. Mechanics and the agent
loop: `qol-project:qol-dev-environments`.

## Always build and test

Build, test, fmt, and clippy with real command output before reporting done or
committing. Never assume. Paste the command and its result; a type-check passing
is not evidence the feature works.

## No pushing unless asked

Commit locally; push only when explicitly told.
