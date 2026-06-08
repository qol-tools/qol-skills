---
name: qol-trace-discipline
description: "Use when writing, reviewing, debugging, or testing code in any qol-tools repo, especially when behavior changes touch runtime flows, persistence, IPC, plugin actions, UI state, production-only paths, or a bug was found. Requires the agent to ask: is this a potential new qol trace target, or maybe time to enrich this qol trace target with more details?"
---

# qol trace discipline

## Mandatory question

Before implementing, reviewing, or closing any non-trivial qol-tools code change, ask:

> is this a potential new qol trace target, or maybe time to enrich this qol trace target with more details?

This is not a request to add tracing everywhere. It is a decision point. Record the answer in the work notes, final summary, PR text, or follow-up issue when it affects the delivery.

## When the answer is usually yes

- The bug only reproduced through the real app, release build, platform shell, desktop session, daemon, or HTTP/socket route.
- The behavior crosses a persistence boundary: config, profile, plugin registry, lockfiles, sync, backups, install markers, autostart, logs, pid files, cache, or temp staging.
- The code crosses a process or protocol boundary: tray host, plugin daemon, runtime socket, HTTP API, CLI courier, file manager/browser launch, shell hook, installer, updater.
- The feature has ordering, timing, lifecycle, or fallback behavior that unit tests do not show well.
- A regression would be expensive to understand from logs alone.
- A test can prove final state, but not explain the path taken to get there.

## Trace target guidance

Prefer a trace target when the system has a named workflow with multiple observable steps. Good trace targets are:

- **Focused**: one user or production workflow, not a whole subsystem.
- **Event-shaped**: each line says what happened, with stable identifiers and the reason/decision.
- **Replayable**: enough detail to compare a good run with a bad run.
- **Redacted**: no secrets, tokens, full home paths, or user content unless deliberately requested for local debugging.
- **Cheap by default**: off unless enabled, sampled, or scoped to an explicit `qol trace <target>` run.

Enrich an existing target instead of creating a new one when the workflow already has a trace name and the missing details are just additional events or fields.

## How to answer the question

Use one of these outcomes:

- **New target**: name the target and the workflow it should cover.
- **Enrich target**: name the existing target and the missing events/fields.
- **No trace**: say why tests/logs are enough, or why the workflow is too small.
- **Defer**: create a specific follow-up when the code fix is urgent and trace design would slow the repair.

## Trace candidates from persistence bugs

For profile work, strongly consider enriching the `profile` trace target with:

- active profile and scope paths as redacted labels, not raw user paths
- backup list/preview/open requests, including validation result and rejected filename reason
- export/import plugin config source decisions: profile config, installed config, skipped invalid entry, skipped symlink
- sync backup creation, retention, restore, and open-file decisions
- doctor findings for malformed persistence state

This target would have caught the difference between "parser preserved an unsafe string" and "the production launcher interpreted it differently", and it would make symlink/path-confinement decisions visible in a real app run.
