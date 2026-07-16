---
name: qol-dev-environments
description: Operate, debug, and evolve the `qol dev` Sandbox panel and its disposable OS environments. Use for typed sandbox workers, verified qcow2 import, `qol env`, `qol flow`, prepared desktop images, guest control, QEMU lifecycle or recovery, resource admission, clean-session plugin testing, and parallel guest work that must stay off the user's active desktop session.
---

# qol-dev-environments

## Establish current truth

Do not use this skill as a command database.

1. Locate the relevant repo with `git rev-parse --show-toplevel`.
2. Start from `qol dev` and inspect the Sandbox panel; this is the normal user surface.
3. Read current command grammar from `qol --help`, `qol env --help`, and `qol flow --help` before using lower-level diagnostic surfaces.
4. Run `qol env list` and `qol env doctor` before choosing an environment.
5. Inspect the selected definition under `flows/envs/*.toml` and any local override path printed by `qol env doctor`.
6. Run `qol env runs` and `qol flow runs` before diagnosing leaked or interrupted work.

Treat the CLI output, environment definitions, implementation source, and run reports as authoritative. Treat prose examples as shapes only.

## Choose the correct surface

| Need | Surface |
| --- | --- |
| Run the selected environment's declared real workflow | `qol dev` Sandbox panel, then `r` |
| Set the next flow's bounded parallelism | `qol dev` Sandbox panel, then `-` or `+` |
| Verify and import a matching prepared qcow2 image | `qol dev` Sandbox panel, then `a` |
| Boot or stop a windowed guest for manual work | `qol dev` Sandbox panel, then Enter |
| Keep one or more clean guests running for manual or assisted testing | `qol env up` |
| Execute a deterministic scenario in disposable headless lanes | `qol flow run` |
| Inspect, screenshot, or stop detached guests | `qol env runs`, `qol env shot`, `qol env down` |
| Reconcile interrupted fan-outs | `qol flow runs` |
| Debug the backend below environment orchestration | `qol emu` |

Prefer `qol dev` for normal work. Keep `qol env` and `qol flow` as thin engine veneers for agents, automation, and diagnosis, and `qol emu` as the lower-level backend surface. The `qol dev` panel must consume the same typed registry, reports, and lifecycle engine; it must not shell out merely to scrape command output.

## Operate the workflow node

From `qol dev`, select an environment in the Sandbox panel. Use `-` and `+` to set the next run's lane count, then press `r` to run its declared `default_workflow`. The panel starts the shared typed worker directly and owns its `RunHandle`; it does not invoke a sibling CLI and scrape stdout.

Treat a desktop workflow as real only when its adapter builds and transports the production artifacts, drives the declared behavior through verified guest control, and records behavior-specific evidence. The current Mint `qol-shot-capture` adapter exercises screenshot selection, preview, pin, and pinned-window movement inside the guest; a harness stub does not satisfy that workflow.

Press `a` on a missing environment or its exact matching candidate to verify and import the qcow2 image. The result is a read-only content-addressed image at `<image_root>/verified/images/<sha256>.qcow2` and its exact report at `<image_root>/verified/imports/<run-id>/report.json`. Refuse missing or ambiguous matches rather than guessing. See [references/env-registry.md](references/env-registry.md) for the import contract.

Use Enter only for a visible, windowed guest that still needs human judgment. This is a manual VM path, not the automated desktop-flow isolation path. The direct typed-handle integration currently covers `r` and `a`; Enter delegates the CLI-owned `env up` lifecycle, so do not cite it as proof that all detached environment orchestration has been extracted below `qol dev`.

Use detached environments from the diagnostic CLI when the task still needs a human or agent to interact with a guest:

```bash
qol env up <environment> --count <lanes>
qol env runs
qol env shot <run-id-or-environment>
qol env down <run-id-or-environment>
```

Use flows directly when the action and verdict are deterministic or when diagnosing the engine below `qol dev`:

```bash
qol flow run <workflow> --env <environment> --repeat <cases> --jobs <parallelism>
qol flow runs
```

Treat `--repeat` as total independent cases and `--jobs` as the concurrency bound. Start with one lane when validating a new image, adapter, or workflow. Increase concurrency only after the single-lane lifecycle is clean.

Do not add a wrapper script around these commands unless the CLI cannot express the reusable input-to-report node. The stable output is `report.json`, not terminal prose.

Do not pass `--force` automatically. Use it only after explaining which resource guard is being overridden and why the host can tolerate it.

Never let an agent fall back to host mouse, keyboard, window, display, or session APIs. If the selected guest cannot expose the required guest-control capability, report that prerequisite instead of controlling the user's desktop.

## Respect the desktop runtime boundary

The enforced guest-only guarantee is narrow: automated plugin runtime and desktop control launch in a headless, offline guest with workspace mounts disabled and only the immutable payload attached read-only. The host worker also clears graphical-session environment variables as defense in depth. Require the aggregate report to record those facts.

Compilation still runs as the current host user. Clearing environment variables is not an OS security boundary because same-user code can rediscover host sockets and files. This feature protects the user's desktop from normal plugin runtime and input automation; it is not safe for adversarial source code or build scripts without an additional container, separate user, or build VM.

Do not describe `qol dev` itself as a global agent-security boundary. It also runs host-side development services, and Enter deliberately opens a manual windowed VM. Keep agent-driven desktop input and plugin actions on the automated guest-control path.

## Preserve lifecycle invariants

Maintain this order:

```text
resolve environment
admit and reserve host resources
persist aggregate ownership
persist lane ownership
prepare disposable state
bind an immutable payload and prepared-image identity
spawn and identify the VM
run or expose the workload
stop the VM and its process tree
verify cleanup
finalize reports
release resources
```

Plan a typed flow or image import once at the caller boundary. Bind its run root, report ticket, and complete semantic plan to a digest in the worker request; require the worker to re-resolve and match that plan before creating a report, reserving resources, or performing mutable work. Refuse drift instead of letting the parent and worker execute different configuration.

Enforce these invariants:

- Persist an aggregate report before any lane may spawn.
- Mark a lane as launching before process creation; distinguish never-started work from uncertain launch state.
- Persist the child `preparing` report before creating mutable artifacts or starting QEMU.
- Bind recovery to canonical run id, report path, QEMU machine name, pidfile, QMP identity, and process-tree evidence.
- Persist the owner PID together with its platform process-start identity, and require both to match before treating an owner as live; a reused PID is not ownership proof.
- Bind desktop guest control to the environment id, prepared-image revision, QEMU-provided run id, guest user, desktop, and display protocol.
- Build a real plugin payload once per fan-out, attach it read-only, and record its manifest and image in parent and child reports.
- Keep resource admission atomic across independent `qol` processes.
- Retain capacity after launcher failure until a report proves terminal cleanup.
- Never publish a terminal aggregate while any owned lane lacks verified cleanup.
- Request cancellation through the typed handle, then escalate only through the verified owned process tree after a bounded wait; never kill only the parent and call cleanup complete.
- Never infer safe deletion from an untrusted path or PID alone.

## Recover interrupted work

Use the owning commands first:

```bash
qol env runs
qol flow runs
```

Allow reconciliation to inspect owner liveness, child reports, QMP identity, process-tree state, and disposable artifacts. Expect an interrupted run to move through a recovery or cleanup-incomplete state before becoming terminal. If identity or cleanup remains unknown, keep it nonterminal and repair or explicitly clear its lease through the owning command; do not promise that passive scanning alone can always make uncertainty terminal.

Reconcile leased image imports before generic lease pruning. Recover a pass only when the exact registered image, digest, revision, passing probes, and cleanup proof are already durable. Treat published-but-unregistered content as abandoned, remove only canonical owned staging, and retain the lease whenever process or cleanup identity is uncertain.

Do not manually delete case directories, leases, pidfiles, or overlays merely because the launcher is gone. Preserve uncertain state and report it when identity or cleanup cannot be proven.

## Change the implementation at its owners

Inspect these source-of-truth areas before editing:

- Environment definitions: `flows/envs/*.toml`
- Shared registry, inventory, reports, cancellation, payload, and resource admission: `libs/qol-dev-env/`
- Typed guest-control protocol: `libs/qol-dev-guest/`
- Typed worker requests, tickets, and handles: `libs/qol-dev-orchestrator/`
- Prepared desktop-session runner: `tools/qol-guest-runner/`
- Detached orchestration: `tools/qol-cli/src/commands/env.rs`
- Parallel orchestration and recovery: `tools/qol-cli/src/commands/flow.rs`
- Verified prepared-image import: `tools/qol-cli/src/commands/emu/image_import/`
- VM backend and workflow driving: `tools/qol-cli/src/commands/emu.rs` and `tools/qol-cli/src/commands/emu/`
- Cross-platform process ownership and worker isolation: `libs/qol-process/`

Extend these owners instead of creating a second registry, launcher, resource ledger, cleanup path, or reporting schema.

Keep `qol dev` presentation thin. Add reusable orchestration below it first, then expose typed state and actions in the panel. Let the panel and CLI veneers call the same typed start functions and consume the same `RunHandle`, report schema, and cancellation protocol; never make the panel shell out and interpret terminal prose.

Keep environment identity backend-neutral. Put QEMU flags and image mechanics below the environment boundary. Require an explicit flow adapter capability before automating an environment; keep environments without one available for manual sessions.

After changing `tools/qol-cli`, run `qol setup` before trusting the installed `qol` command.

## Validate behavior in layers

For implementation work, validate in this order when the requested scope permits execution:

1. Run focused parser, state-machine, report, and failure-injection tests.
2. Run strict host lint or compile checks for changed crates.
3. Cross-check platform-specific process code on its target triples.
4. Provision or select the exact prepared desktop image required by the environment manifest.
5. Run one real lane through the `qol dev` Sandbox panel and inspect its child and aggregate reports.
6. Run one detached `env up`/`env down` lifecycle and verify canonical process identity.
7. Exercise graceful cancellation and abrupt owner death.
8. Run the requested bounded fan-out and confirm every lane reports cleanup.
9. Confirm `qol env runs` and `qol flow runs` show no unintended active work.

Do not claim runtime parity for a host that was only compile-checked. Do not claim real guest or plugin behavior was tested unless the exact prepared image booted, its live identity probes passed, and the real workflow ran. A harness stub, a missing image, or a desktop screenshot is not that evidence.

## Guardrails

- Keep base images immutable and mutate disposable overlays only.
- Leave the host unchanged outside declared config, cache, run, and evidence locations.
- Keep missing and unsupported environments visible; never silently substitute another image or backend.
- Treat localhost QMP and user-mode VM networking as development control channels, not a hostile-code security boundary.
- Preserve reports for failed and abandoned runs even after disposable artifacts are removed.
- Keep the repository, worktree, home directory, host display, and host input devices outside the guest boundary.
- Add real plugin payload transport and UI automation as workflow adapters, not as special cases in environment discovery or the `qol dev` panel.

## References

- Read `references/mission-capsule.md` before changing scope or portability promises.
- Read `references/env-registry.md` when defining or resolving environments and adapters.
- Read `references/qemu-backend.md` when touching boot, identity, process ownership, or teardown.
- Read `references/result-report-contract.md` when writing, reconciling, or consuming run evidence.
