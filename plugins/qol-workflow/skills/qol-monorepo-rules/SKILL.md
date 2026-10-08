---
name: qol-monorepo-rules
description: Always-on delivery rules for work inside qol-tools repositories - PR opt-in, auto-merge on every PR, watching every PR until it merges, standards evolution, guest-VM verification, and the build/test gate before reporting done. Autoinjected in full at session start and after every compaction in repos that list it with `vs autoinject`; these rules must fire without a topic trigger.
---

# qol-tools delivery rules

These are unconditional. They previously lived in the monorepo's root `CLAUDE.md`,
which only Claude Code loaded. They are autoinjected at session start and after every compaction, in repos that list them with `vs autoinject`, so every agent gets them.

## PRs are opt-in. Default is commit-direct-to-main.

Default all work (tests, refactors, fixes, features, configs, docs) direct to
`main`. Open a PR, issue, or ADR **only when explicitly asked**; never offer one
as a fallback. Mechanics: `qol-workflow:git-trees`.

## Every pull request merges itself

Right after `gh pr create` in a qol-tools repository, run `gh pr merge --auto <number>`
so the merge queue lands the pull request once its checks pass. The CI and the
merge queue are the gate; do not wait for a merge go-ahead. A draft gets it right
after `gh pr ready`. The one exception: when the user says they are testing or
holding a pull request, run `gh pr merge --disable-auto <number>` and wait for
their word.

## Every pull request is watched until it merges

A pull request you open is yours until it merges. Do not report it done at
`gh pr create`; listen for its outcome and fix what fails.

<!-- inject:pr-watch:start -->
[qol-pr-watch] When this command succeeds, start the pull request watcher as one background command whose exit wakes you (Claude Code: Bash `run_in_background`; a harness with no background completion event runs it in the foreground): `node <qol-workflow>/bin/pr-watch.cjs <pr-url> --pretty`. Exit 1 is a failure with the failed steps' logs: fix it on the branch, gate locally, push, and start the watcher again. Exit 7 is review feedback from the qol-code-review bot: fix the findings it left for you, pull the branch first when the bot pushed a fix commit, then start the watcher again. Exit 0 is merged; exit 6 means arm `gh pr merge --auto`. Never poll with sleep loops or repeated `gh pr checks`. Skip only a pull request the user is testing or holding.
<!-- inject:pr-watch:end -->

The watcher polls GitHub inside its own process, so no turn is spent until
there is an outcome. It exits once: 0 merged, 1 failed (a failed check or
status on the head commit, a merge conflict, a merge queue removal, or the pull
request closed), 3 no pull request, 4 `gh` kept failing, 5 still pending after
two hours, 6 checks green but auto-merge not armed, 7 a qol-code-review or
queue-fix comment posted after the watcher started that needs you: findings
"left for you", a fix commit the bot pushed to the branch, or a failed review
or fix. A clean review, or one whose only open findings are low, keeps it
watching; the latest comment supersedes earlier ones. A push to the branch
while it runs is followed, because it always reads the latest head commit.

Pushing fixes to the branch of a pull request the user asked for is part of
that request. Re-arm `gh pr merge --auto` when the merge queue dropped the pull
request. Report to the user when it merges, or when a failure needs their
decision; a failure you cannot attribute to the change (a flake that passes on
rerun, an outage) is reported with the evidence, never silently rerun forever.

A PreToolUse hook (`pr-watch-context.cjs`) injects the paragraph above, with
the absolute path filled in, before `gh pr create`, `gh pr ready`,
`gh pr merge --auto`, and a `git push` to a branch with an open pull request.
`~/.claude/.qol-pr-watch-reminder-off` silences it. Residual: the hook cannot
see a pull request opened from the web UI or through an API call.

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
