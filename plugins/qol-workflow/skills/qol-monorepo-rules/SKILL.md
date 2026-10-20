---
name: qol-monorepo-rules
description: Always-on delivery rules for work inside qol-tools repositories - every qol-monorepo change on a worktree branch delivered as a PR, qol-skills direct to main, auto-merge on every PR, watching every PR until it merges, standards evolution, guest-VM verification, and the build/test gate before reporting done. Autoinjected in full at session start and after every compaction in repos that list it with `vs autoinject`; these rules must fire without a topic trigger.
---

# qol-tools delivery rules

These are unconditional. They previously lived in the monorepo's root `CLAUDE.md`,
which only Claude Code loaded. They are autoinjected at session start and after every compaction, in repos that list them with `vs autoinject`, so every agent gets them.

## qol-monorepo: every change goes through a worktree and a pull request

In qol-monorepo, make all work (tests, refactors, fixes, features, configs,
docs) on a branch in its own worktree and deliver it as a pull request. Never
commit to its `main` unless the user explicitly asks for a direct-to-main change
or approves one when asked.

qol-skills is the exception: commit skill, hook, and plugin edits direct to
`main` in its main clone, with no worktree and no pull request.

Issues and ADRs remain opt-in. Mechanics: `qol-workflow:git-trees`.

## Commit subjects and pull request titles

Every commit subject and pull request title is `<type>(scope): imperative summary`,
at most 72 characters with type and scope included, and the scope's first token
is a workspace member or umbrella (`cli-sessions`, `sessions-engine`, `plugins`),
never a short form like `sessions`. Always pass `gh pr create --title`; `--fill`
is refused. Details: `qol-workflow:commit`.

## Every pull request merges itself

Right after `gh pr create` in a qol-tools repository, run `gh pr merge --auto <number>`
so the merge queue lands the pull request once its checks pass. The CI and the
merge queue are the gate; do not wait for a merge go-ahead. A draft gets it right
after `gh pr ready`. The one exception: when the user says they are testing or
holding a pull request, run `gh pr merge --disable-auto <number>` and wait for
their word.

## Never ask whether to push or open a pull request

Finished work on a worktree branch is pushed and opened as a pull request
without asking. Where you would otherwise hold it for the user, such as a new
feature whose design was not agreed or work a fork finished on its own, open it
as a draft with `gh pr create --draft`: no auto-merge, and the user marks it
ready. Skip the push only when the user said not to push.

## Every pull request is watched until it merges

A pull request you open is yours until it merges. Do not report it done at
`gh pr create`; listen for its outcome and fix what fails.

<!-- inject:pr-watch:start -->
[qol-pr-watch] When this command succeeds, park this session on the pull request watcher and end your turn with one line saying what you wait for: `<qol-cli-sessions> park -- node <qol-workflow>/bin/pr-watch.cjs <pr-url> --pretty`. The terminal stays open and the watcher's exit code and output are submitted into it when it exits, unless parking is on for this session: then the terminal closes once the turn ends and qol resumes this same conversation in a new tab with the result. Park's output says which applies. If park itself fails, report the error to the user; never run the watcher outside park. Exit 1 is a failure with the failed steps' logs: fix it on the branch, gate locally, push, and park on the watcher again. Exit 7 is review feedback from the qol-code-review bot: fix the findings it left for you, pull the branch first when the bot pushed a fix commit, then park on the watcher again; a finding against a decision the user made on purpose is answered in a pull request comment instead, then the review is rerun. Exit 0 is merged; exit 6 means arm `gh pr merge --auto`, except on a draft: leave it unarmed and report it ready for the user. Never poll with sleep loops or repeated `gh pr checks`. Skip only a pull request the user is testing or holding.
<!-- inject:pr-watch:end -->

The watcher polls GitHub inside its own process, so no turn is spent until
there is an outcome. Parking puts it under a detached CLI Sessions process instead of
the harness. The terminal waits open unless parking is on for the session, which
closes it for the wait and resumes it in a new tab afterwards. `qols park` toggles
it for the current terminal, and `session_fork` with `park: true` or
`qols fork --park` starts a fork with it on: `qol sessions parked`
lists parked sessions, and `qol sessions unpark <id>` stops the wait and
resumes the conversation early.

Parking is enforced by `pr-watch-park-guard.cjs`. On PreToolUse it denies a
watcher run that is not wrapped in `qol-cli-sessions park --`. On Stop it reads the
session transcript and blocks ending the turn while the latest successful
`gh pr create`, `gh pr ready`, `gh pr merge --auto`, or push to a branch with an
open pull request has no successful park after it; `gh pr merge --disable-auto`
(the testing or holding exception) releases it. It blocks once per stop, so a
park that keeps failing cannot trap the session. Residual: a harness whose
transcript it cannot read (anything but Claude Code's JSONL) is not held at Stop. It exits once: 0 merged, 1 failed (a failed check or
status on the head commit, a merge conflict, a merge queue removal, or the pull
request closed), 3 no pull request, 4 `gh` kept failing, 5 still pending after
two hours, 6 checks green but auto-merge not armed, 7 a qol-code-review or
queue-fix comment posted after the watcher started that needs you: findings
"left for you", a fix commit the bot pushed to the branch, or a failed review
or fix. Only a pass verdict or an owner override lets the pull request into the
merge queue, so every open finding of a conditional or block review is left for you. A pass
keeps it watching; the latest comment supersedes earlier ones. A push to the branch
while it runs is followed, because it always reads the latest head commit. Checks
of an older run of a workflow are ignored once a newer run of it reports, and a
failure seen in the first two minutes ends the watch only if it still holds then,
because a rerun takes that long to replace the checks it supersedes.

A finding that argues with a decision the user made on purpose, such as a look,
a layout or a scope cut, is not fixed. Answer it in a pull request comment that
states the decision, then rerun the whole review run with `gh run rerun <run-id>`
(not `--failed`): the reviewer reads the description and the comments live,
drops findings a decision of the author or the owner settles, and lists them
under Settled. The new review run reruns the tests and CodeQL runs that stopped
on the old verdict, so they wait for its verdict. When the finished review of
the head commit still blocks, the owner can comment `/review-override <sha>`
naming that commit: it records the override in a pull request comment and in the
claude review check, passes that check for that commit only, and reruns the
checks that stopped on the old verdict. An override that names another commit or
comes while the review runs is refused, and a new push is reviewed again. Post
it only when the user asks for an override.

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

## No pushing to main unless asked

Pushing a qol-monorepo worktree branch to open or update its pull request is
part of the delivery and needs no separate ask. Push to `main` only when
explicitly told.
