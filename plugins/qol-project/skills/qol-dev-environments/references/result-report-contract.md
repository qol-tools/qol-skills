# Result Report Contract

## Contents

- [Purpose](#purpose)
- [Report family](#report-family)
- [Required aggregate fields](#required-aggregate-fields)
- [Child lifecycle evidence](#child-lifecycle-evidence)
- [Status rules](#status-rules)
- [Cleanup proof](#cleanup-proof)
- [Durable writes and locking](#durable-writes-and-locking)
- [Consumption](#consumption)

## Purpose

Write enough durable evidence for another human, agent, or command to answer:

- What was requested?
- Which effective environment and resources were used?
- What actually started?
- What passed, failed, or never started?
- Which processes and disposable artifacts remain?
- Is cleanup proven?
- What command should run next?

Use `report.json` as the status source. Do not scrape terminal output or logs for the aggregate verdict.

## Report family

Keep separate but linked reports for:

- the detached environment batch
- the automated flow fan-out
- each child VM case
- interruption evidence when an owner dies
- stable step, preflight, environment, log, and artifact outputs

Derive paths from the configured run root and canonical run ids. Validate every report's kind, run id, and directory relationship before using it for recovery or lease release.

## Required aggregate fields

Record these concepts even if their exact serialization evolves:

- report kind and run id
- owner PID and ownership state
- start time and terminal finish time
- active, terminal, or cleanup-incomplete status
- requested environment and effective definition
- requested concurrency and per-lane resources
- host capacity, budgets, pre-existing reservations, and forced admission
- complete planned lane set
- lane phase, child report path, verdict, and cleanup proof
- aggregate error when applicable
- stable artifact locations
- next useful actions

Write the complete lane plan before spawning the first lane. A partial plan makes crash recovery unable to distinguish unstarted work from forgotten work.

## Child lifecycle evidence

Write a child report before mutable artifacts or QEMU may exist. Evolve it through launch and runtime without losing the original identity.

Record during the active lifecycle:

- environment and image resolution
- resource and display inputs
- supervisor PID
- canonical spawn state and pidfile
- QEMU PID after observation
- QMP and serial endpoints
- canonical machine identity
- commands as program plus argv

In the terminal report, retain enough of that identity through runtime, command, and teardown evidence to audit which process was controlled, even if transient spawn fields are removed.

Also record:

- workflow verdict and traces when applicable
- teardown status, process exit proof, and removed artifacts
- reconciliation reason and preserved prior report when interrupted

Treat `preparing` with no possible spawn differently from `launching` with uncertain process creation.

## Status rules

Keep active, terminal, and cleanup-incomplete states distinct.

Use an active state while an owner is legitimately preparing, starting, running, cancelling, stopping, or recovering work.

Use a terminal state only when:

- every planned lane has an outcome
- never-started lanes are recorded explicitly
- every lane that may have spawned has verified cleanup
- terminal timestamps and owner release state are written

Use a cleanup-incomplete state when process identity, process-tree exit, or artifact removal cannot be proven. Do not convert uncertainty into success, ordinary failure, or abandonment merely to finish the report.

## Cleanup proof

Make cleanup a first-class verdict. For each owned lane, record:

- whether cleanup is complete
- process and process-tree exit verification
- QEMU identity evidence when it may have spawned
- disposable artifact removal
- cleanup error or ambiguity

Require a terminal cleanup-complete aggregate before removing its host resource lease. Keep the lease on report-write failure or uncertain cleanup.

## Durable writes and locking

- Use atomic durable writes for reports and the resource ledger.
- Lock a run while reconciling or updating aggregate lifecycle state.
- Ignore unrelated non-directory entries when scanning run roots.
- Preserve malformed or mismatched state and fail closed instead of rewriting it optimistically.
- Bind resource leases to both report path and report run id.

## Consumption

Make CLI, UI, CI, and agents summarize the same fields:

- environment
- workflow or manual batch
- lane counts and concurrency
- current or terminal status
- failed or incomplete lane
- cleanup state
- report path
- next command

Keep detailed diagnosis in child reports and logs. Keep the aggregate concise enough to scan without hiding cleanup uncertainty.
