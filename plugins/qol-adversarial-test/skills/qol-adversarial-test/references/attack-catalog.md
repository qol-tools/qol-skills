# Attack Catalog

Read this file after mapping the real runtime path. Select attacks because they threaten a named invariant; do not run every category mechanically.

## Selection matrix

| Category | Attack examples | Invariants to check |
| --- | --- | --- |
| Baseline and repetition | first run, warm run, repeated actions, rapid toggles, duplicate requests | same input has stable semantics; repetition is idempotent where promised |
| Concurrency and ordering | simultaneous creates/updates/deletes, run while updating, shutdown during write, reordered callbacks | no lost updates, duplicates, deadlocks, partial state, or impossible transitions |
| Lifecycle | cold start, stop/start, authenticated shutdown, crash, daemon disappearance, host restart, reinstall | readiness is truthful; state survives only when promised; recovery is bounded |
| Persistence | restart after mutation, interrupted write, malformed existing config, duplicate IDs, stale schema, exact cleanup | writes are atomic; valid state survives; invalid state fails safely; baseline restores exactly |
| Boundary input | empty, maximum size, Unicode, whitespace, control bytes, quotes, duplicate keys, unknown enum, wrong content type | validation is explicit; errors do not mutate state; encoding round-trips |
| Trust and authorization | missing/invalid token, hostile Host, wrong origin, path traversal, unsafe URL scheme, symlink escape | unauthorized requests fail closed; trusted local use still works |
| Dependency failure | missing binary, denied permission, unavailable device, dropped IPC, closed socket, partial platform capability | errors are actionable; no wedged state; retry or fallback matches contract |
| Resource pressure | request flood, reconnect loop, file-descriptor count, process count, memory growth, bounded queues | resources remain bounded; overload is rejected or degraded predictably |
| Platform/session | supported OS variants, desktop sessions, display servers, headless mode, production versus development install | capability routing selects the correct backend; unsupported paths say so explicitly |
| UI state | multiple windows/items, focus loss, press/hold/release, close during action, repeated summon/dismiss, stale selection | controls remain reachable; state belongs to the right instance; focus and cleanup recover |
| Time and race windows | near-zero delays, delayed dependency, timeout boundary, cancellation at each phase | completion is semantic; timeouts are bounded; cancellation cannot commit partial work |
| Recovery and cleanup | rerun after failure, cleanup after partial setup, stale artifact reuse, interrupted cleanup | reruns are safe; leftovers are detected; cleanup never deletes pre-existing state |

## Escalation order

1. Run one valid case and one invalid case.
2. Repeat the valid case enough to expose drift.
3. Race operations that share mutable state.
4. Insert lifecycle transitions across persistence boundaries.
5. Remove or delay dependencies.
6. Fan out into fresh isolated environments.

Stop escalating a lane when it fails. Minimize and preserve that failure before adding more noise.

## Oracles

Prefer these evidence sources in order of authority for the specific invariant:

1. persisted or externally observable final state;
2. protocol response plus a subsequent independent read;
3. targeted trace events with stable identifiers and reasons;
4. UI observation or screenshot for visual/state ownership defects;
5. process exit and resource counters as supporting evidence.

Use multiple oracles when acknowledgements can precede persistence or when UI success can hide backend failure.

## Case accounting

Record exact attempted, acknowledged, persisted, unique, recovered, cleaned, and failed counts. Never summarize a concurrent run as “passed” from response codes alone.

Capture a seed for randomized data, but commit the minimized deterministic counterexample rather than relying on the seed to recur.
