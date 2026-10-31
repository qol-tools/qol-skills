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
merge queue are the gate; do not wait for a merge go-ahead. A draft gets it once
the user marks it ready. The one exception: when the user says they are testing or
holding a pull request, run `gh pr merge --disable-auto <number>` and wait for
their word.

## Never ask whether to push or open a pull request

When your work leaves commits on a branch, push the branch and open a pull
request without asking, then arm auto-merge with `gh pr merge --auto`, unless the
change involves design (UI, or architecture such as a new command, a file format
or a large refactor): open that as a draft with `gh pr create --draft` and report
that it waits for the user's approval. Put `Session: <key>` as the last line of
the pull request body, where `<key>` is your spawn key in `sessions_list`. Never
force-push, and never mark a draft ready yourself. Skip the push only when the
user said not to push.

## Forks and lanes report to their parent

A terminal session with a parent (a fork or a lane) talks to the user through
that parent; a switchboard fork is a subagent and follows "Switchboard forks" below:

- When your pull request has merged, or nothing is left that anyone must do, send
  one line to your parent with `session_send` kind `report` and `done: true`, then
  end your turn; your tab closes when that turn ends.
- When only the user can decide something, send it to your parent with
  `session_send` kind `ask` instead of asking in your own terminal; the answer
  comes back as a message. `AskUserQuestion` is refused in a lane.
- When a check fails and you cannot fix it, report the pull request and what
  broke to your parent.

## Switchboard forks

A fork the switchboard starts runs as a Claude Code subagent inside the
switchboard, not in a terminal of its own. It cannot park: it watches its pull
request with the watcher in the background (Bash `run_in_background: true`, then
end the turn), reports with its final message instead of `session_send`, and asks
the user by ending its turn with the question and a recommended answer.

Claude Code drops a subagent from the agent list 30 seconds after its turn ends
unless a background command of its own still runs, and the user can then no
longer select it or type to it, so a fork that seems dead is only idle. Before a
fork ends a turn that leaves anything for the user (a question, a draft waiting
for approval, a report the user may answer, or Ready), it starts its hold once:
Bash `sleep infinity` with `run_in_background: true`, which costs nothing and
never wakes it. Once nothing is left for anyone to do, such as after its pull
request merged, it stops the hold with TaskStop before its final message, and
then leaves the list; SendMessage still resumes it.

## A review of your own change ends in fixes

A qol-code-review you run on a change you deliver (your branch, worktree or
pull request, or a qol-tools pull request the user asked you to review) that
returns `conditional` or `block` goes straight into its fix round in the same
turn: never stop at the verdict to ask whether to fix. Re-verify each finding,
fix the real ones, settle the ones a user decision covers, ask only about the
ones the user must decide, then gate, commit, push and park. Stay read-only only
when the user said review only. Mechanics: "Fixing the findings" in
`qol-code-review`.

## Every pull request is watched until it merges

A pull request you open is yours until it merges. Do not report it done at
`gh pr create`; listen for its outcome and fix what fails.

<!-- inject:pr-watch:start -->
[qol-pr-watch] When this command succeeds, park this session on the pull request watcher before any other tool call, then end your turn with one line saying what you wait for: `<qol-cli-sessions> park -- node <qol-workflow>/bin/pr-watch.cjs <pr-url> --pretty`. The terminal stays open and the watcher's exit code and output are submitted into it when it exits, unless parking is on for this session: then the terminal closes once the turn ends and qol resumes this same conversation in a new tab with the result. Park's output says which applies. If park itself fails, report the error to the user; never run the watcher outside park. A failure or review the watcher reports comes before any other work, even mid-turn. Exit 1 is a failure with the failed steps' logs: fix it on the branch, gate locally, push, and park on the watcher again. Exit 7 is review feedback from the qol-code-review bot: fix the findings it left for you, pull the branch first when the bot pushed a fix commit, then park on the watcher again; a finding against a decision the user made on purpose is answered in a pull request comment instead, then the review is rerun. Exit 0 is merged: a fork or lane then sends its parent one line with session_send kind report and done true. Exit 6 on a ready pull request means arm `gh pr merge --auto` and park again; on a draft it is design work waiting for the user's approval: leave it unarmed, report it to your parent (or the user, without one), and park again with `--until-ready` added so the watcher waits for the user to mark it ready. Never poll with sleep loops or repeated `gh pr checks`. Skip only a pull request the user is testing or holding.
<!-- inject:pr-watch:end -->

<!-- inject:pr-watch-subagent:start -->
[qol-pr-watch] You run as a subagent and cannot park. When this command succeeds, start the pull request watcher with Bash `run_in_background: true` before any other tool call, as the bare command, no park and no wrapper: `node <qol-workflow>/bin/pr-watch.cjs <pr-url> --pretty`. Then end your turn with one line saying what you wait for; Claude Code wakes you with the exit code and output when the watcher exits. A failure or review the watcher reports comes before any other work. Exit 1 is a failure with the failed steps' logs: fix it on the branch, gate locally, push, start the watcher in the background again and end your turn. Exit 7 is review feedback from the qol-code-review bot: fix the findings it left for you, pull the branch first when the bot pushed a fix commit, then start the watcher again; a finding against a decision the user made on purpose is answered in a pull request comment instead, then the review is rerun. Exit 0 is merged: your final message is the one-line report. Exit 6 on a ready pull request means arm `gh pr merge --auto` and start the watcher again; on a draft it is design work waiting for the user's approval: leave it unarmed, start the watcher again with `--until-ready` added, and end your turn saying the draft waits for the user's approval. Never poll with sleep loops or repeated `gh pr checks`. Skip only a pull request the user is testing or holding.
<!-- inject:pr-watch-subagent:end -->

The watcher polls GitHub inside its own process, so no turn is spent until
there is an outcome. Parking puts it under a detached CLI Sessions process instead of
the harness. The terminal waits open unless parking is on for the session, which
closes it for the wait and resumes it in a new tab afterwards. `qols park` toggles
it for the current terminal, and `session_fork` with `park: true` or
`qols fork --park` starts a fork with it on: `qol sessions parked`
lists parked sessions, and `qol sessions unpark <id>` stops the wait and
resumes the conversation early.

Parking is enforced by `pr-watch-park-guard.cjs` (a subagent is held to the
background watcher instead, described below). On PreToolUse it denies a
watcher run that is not wrapped in `qol-cli-sessions park --`, and it denies every
other tool call while the latest successful `gh pr create`, `gh pr ready` or
`gh pr merge --auto` in the transcript has no park after it, so a failed check
or review always reaches the agent that opened the pull request at once.
Incident (2026-10-22): the claude review of qol-tools/qol#286 failed while its
session kept building two more pull requests with no watcher, and the user saw
the failure first. The filter lets through the park itself,
`gh pr merge --disable-auto`, and the `gh pr merge --auto` or `gh pr ready` that
follows a create; opening another pull request waits for the park. A failed park
attempt releases it, so a broken park cannot trap the session. Run the park
command the deny names as written: a park spelled through shell variables is not
recognized. An arming that a waiting park already watches, or whose pull request
is closed, is looked up once and remembered as a marker file in the system temp
folder, so the filter calls `gh` once per arming, not once per tool call.
`hooks.json` lists the guard in the Bash group and in a `^(?![Bb]ash$)` group
for every other tool, so it runs once per call (Claude Code also tests a tool's
legacy names, and `bash` is Bash's). Residual: a push to an open pull request is
held only at Stop, because telling it apart needs a network call; a tool call
sent in the same message as the arm command runs before the arm's result lands;
a park covers every arming before it, so arming two existing pull requests back
to back and parking one leaves the other unwatched; and like the Stop check it
reads only Claude Code's JSONL transcript.
On Stop it reads the
session transcript and blocks ending the turn while the latest successful
`gh pr create`, `gh pr ready`, `gh pr merge --auto`, or push to a branch with an
open pull request has no successful park after it; `gh pr merge --disable-auto`
(the testing or holding exception) releases it. It blocks once per stop, so a
park that keeps failing cannot trap the session. It never blocks the
switchboard session (the kitty window tagged `qol_session_key=switchboard`, with
no `agent_id` in the hook payload), which park refuses, and it skips a pull request a waiting park in `qol-cli-sessions parked`
already watches, since that watcher follows every push; the PreToolUse reminder
stays silent in both cases. Residual: a harness whose
transcript it cannot read (anything but Claude Code's JSONL) is not held at Stop.

For a call with `agent_id` (a subagent, such as a switchboard fork) the guard
holds the same line with a background watcher in place of the park. Hooks fire
on a subagent's tool calls, and a subagent runs in the switchboard's process, so
the switchboard exemption never applies to it. PreToolUse denies a watcher run
that is wrapped in `qol-cli-sessions park --` or lacks
`tool_input.run_in_background: true`, and the deny names the exact bare command.
An arming counts as watched once a later successful Bash call with
`run_in_background: true` runs `pr-watch.cjs`; `gh pr merge --disable-auto`
releases it and a failed watcher start releases it like a failed park. The
subagent's own transcript is
`<parent transcript folder>/<parent session id>/subagents/agent-<agent_id>.jsonl`
(searched recursively under `subagents/` for nested agents), because the
PreToolUse payload's `transcript_path` is the parent's. `SubagentStop` mirrors
Stop on `agent_transcript_path` and blocks once, naming the pull request and the
background command. Residual: a subagent whose transcript the guard cannot find
is not held, and a background watcher counts as started without checking that it
still runs.

It exits once: 0 merged, 1 failed (a failed check or
status on the head commit, a merge conflict, a merge queue removal, or the pull
request closed; a failed `merge queue` status ends the watch the moment the
queue run posts it, even while GitHub still holds the failed entry, and one left
by an earlier attempt is ignored once the pull request is queued again), 3 no pull request, 4 `gh` kept failing, 5 still pending after
two hours, 6 checks green on a draft (design work waiting for the user) or on a
ready pull request with auto-merge not armed, 7 a qol-code-review or
queue-fix comment posted after the watcher started that needs you: findings
"left for you", a fix commit the bot pushed to the branch, or a failed review
or fix. With `--until-ready` a green draft keeps it watching until the user marks
it ready. Only a pass verdict or an owner override lets the pull request into the
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
under Settled. The tests and CodeQL runs never wait for the verdict: they run
beside the review, and the merge queue admits the pull request only once both
required checks pass. When the finished review of the head commit still
blocks, the owner can comment `/review-override <sha>` naming that commit: it
records the override in a pull request comment and in the claude review check
and passes that check for that commit only. An override that names another
commit or comes while the review runs is refused, and a new push is reviewed
again. Post it only when the user asks for an override.

Pushing fixes to the branch of a pull request the user asked for is part of
that request. Re-arm `gh pr merge --auto` when the merge queue dropped the pull
request. Report to the user when it merges, or when a failure needs their
decision; a failure you cannot attribute to the change (a flake that passes on
rerun, an outage) is reported with the evidence, never silently rerun forever.

A PreToolUse hook (`pr-watch-context.cjs`) injects the paragraph above (the
background-watcher paragraph when the payload has `agent_id`), with
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
