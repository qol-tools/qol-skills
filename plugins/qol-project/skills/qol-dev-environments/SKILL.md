---
name: qol-dev-environments
description: Operate, debug, and evolve disposable OS environments and parallel VM workflows for qol-tools. Use for `qol env`, `qol flow`, QEMU lifecycle or orphan recovery, environment manifests and resolver states, resource admission, run evidence, clean-session plugin testing, multi-VM fan-out, and portability validation that must not consume the user's desktop session.
---

# qol-dev-environments

## Establish current truth

Do not use this skill as a command database.

1. Locate the relevant repo with `git rev-parse --show-toplevel`.
2. Read current command grammar from `qol --help`, `qol env --help`, and `qol flow --help`.
3. Run `qol env list` and `qol env doctor` before choosing an environment.
4. Inspect the selected definition under `flows/envs/*.toml` and any local override path printed by `qol env doctor`.
5. Run `qol env runs` and `qol flow runs` before diagnosing leaked or interrupted work.

Treat the CLI output, environment definitions, implementation source, and run reports as authoritative. Treat prose examples as shapes only.

## Choose the correct surface

| Need | Surface |
| --- | --- |
| Keep one or more clean guests running for manual or assisted testing | `qol env up` |
| Execute a deterministic scenario in disposable headless lanes | `qol flow run` |
| Inspect, screenshot, or stop detached guests | `qol env runs`, `qol env shot`, `qol env down` |
| Reconcile interrupted fan-outs | `qol flow runs` |
| Debug the backend below environment orchestration | `qol emu` |

Prefer `qol env` and `qol flow` for normal work. Keep `qol emu` as the lower-level backend surface.

## Operate the workflow node

Use detached environments when the task still needs a human or agent to interact with a guest:

```bash
qol env up <environment> --count <lanes>
qol env runs
qol env shot <run-id-or-environment>
qol env down <run-id-or-environment>
```

Use flows when the action and verdict are deterministic:

```bash
qol flow run <workflow> --env <environment> --repeat <cases> --jobs <parallelism>
qol flow runs
```

Treat `--repeat` as total independent cases and `--jobs` as the concurrency bound. Start with one lane when validating a new image, adapter, or workflow. Increase concurrency only after the single-lane lifecycle is clean.

Do not add a wrapper script around these commands unless the CLI cannot express the reusable input-to-report node. The stable output is `report.json`, not terminal prose.

Do not pass `--force` automatically. Use it only after explaining which resource guard is being overridden and why the host can tolerate it.

## Preserve lifecycle invariants

Maintain this order:

```text
resolve environment
admit and reserve host resources
persist aggregate ownership
persist lane ownership
prepare disposable state
spawn and identify the VM
run or expose the workload
stop the VM and its process tree
verify cleanup
finalize reports
release resources
```

Enforce these invariants:

- Persist an aggregate report before any lane may spawn.
- Mark a lane as launching before process creation; distinguish never-started work from uncertain launch state.
- Persist the child `preparing` report before creating mutable artifacts or starting QEMU.
- Bind recovery to canonical run id, report path, QEMU machine name, pidfile, QMP identity, and process-tree evidence.
- Keep resource admission atomic across independent `qol` processes.
- Retain capacity after launcher failure until a report proves terminal cleanup.
- Never publish a terminal aggregate while any owned lane lacks verified cleanup.
- Never infer safe deletion from an untrusted path or PID alone.

## Recover interrupted work

Use the owning commands first:

```bash
qol env runs
qol flow runs
```

Allow reconciliation to inspect owner liveness, child reports, QMP identity, process-tree state, and disposable artifacts. Expect an interrupted run to move through a recovery or cleanup-incomplete state before becoming terminal.

Do not manually delete case directories, leases, pidfiles, or overlays merely because the launcher is gone. Preserve uncertain state and report it when identity or cleanup cannot be proven.

## Change the implementation at its owners

Inspect these source-of-truth areas before editing:

- Environment definitions: `flows/envs/*.toml`
- Registry and resource admission: `tools/qol-cli/src/commands/dev_env/`
- Detached orchestration: `tools/qol-cli/src/commands/env.rs`
- Parallel orchestration and recovery: `tools/qol-cli/src/commands/flow.rs`
- VM backend and workflow driving: `tools/qol-cli/src/commands/emu.rs` and `tools/qol-cli/src/commands/emu/`
- Cross-platform process ownership: `libs/qol-process/`

Extend these owners instead of creating a second registry, launcher, resource ledger, cleanup path, or reporting schema.

Keep environment identity backend-neutral. Put QEMU flags and image mechanics below the environment boundary. Require an explicit flow adapter capability before automating an environment; keep environments without one available for manual sessions.

After changing `tools/qol-cli`, run `qol setup` before trusting the installed `qol` command.

## Validate behavior in layers

For implementation work, validate in this order when the requested scope permits execution:

1. Run focused parser, state-machine, report, and failure-injection tests.
2. Run strict host lint or compile checks for changed crates.
3. Cross-check platform-specific process code on its target triples.
4. Run one real headless lane and inspect its child and aggregate reports.
5. Run one detached `env up`/`env down` lifecycle and verify canonical process identity.
6. Exercise graceful cancellation and abrupt owner death.
7. Run the requested bounded fan-out and confirm every lane reports cleanup.
8. Confirm `qol env runs` and `qol flow runs` show no unintended active work.

Do not claim runtime parity for a host that was only compile-checked. Do not claim plugin behavior was tested when the workflow only exercised a harness stub.

## Guardrails

- Keep base images immutable and mutate disposable overlays only.
- Leave the host unchanged outside declared config, cache, run, and evidence locations.
- Keep missing and unsupported environments visible; never silently substitute another image or backend.
- Treat localhost QMP and user-mode VM networking as development control channels, not a hostile-code security boundary.
- Preserve reports for failed and abandoned runs even after disposable artifacts are removed.
- Add real plugin payload transport and UI automation as workflow adapters, not as special cases in environment discovery.

## References

- Read `references/mission-capsule.md` before changing scope or portability promises.
- Read `references/env-registry.md` when defining or resolving environments and adapters.
- Read `references/qemu-backend.md` when touching boot, identity, process ownership, or teardown.
- Read `references/result-report-contract.md` when writing, reconciling, or consuming run evidence.
