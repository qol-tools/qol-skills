---
name: qol-dev-environments
description: Use when designing, implementing, or operating clean OS development environments for qol-tools, including `qol dev` environment panels, `qol env up`, `qol flow run`, VM/QEMU acceptance checks, OS image registries, ready/missing/unsupported resolver states, and mission-level portability validation.
---

# qol-dev-environments

Use this when a task asks for clean OS testing, VM acceptance, portability validation, OS image discovery, `qol env`, `qol flow`, or a `qol dev` workflow that boots an environment and gathers evidence.

## Core model

The durable contract is:

```text
environment registry first
VM/QEMU as the first backend
workflows as per-environment actions
```

Keep these concepts separate:

- `env up`: clone/open a clean OS instance for manual or assisted testing.
- `flow run`: run one deterministic scenario inside an environment, optionally reboot, rerun checks, then write a report.

Do not present every desktop/UI behavior as fully automatable. For UI-heavy work, a clean environment that opens quickly with logs and workspace mounts is already a valid workflow node. Automate only the deterministic part.

## Source of truth split

- `qol-skills`: agent-facing workflow knowledge and guardrails.
- `qol dev` / `qol` CLI: human and agent command surface.
- App or CLI repo implementation: runner code, environment resolver, report writer, and UI panels.

If implementation lives in `qol-monorepo`, prefer adding the executable surface near the existing `qol dev` implementation rather than creating a detached script that users must remember.

## First loop

Start with one executable loop before expanding the matrix:

1. Resolve one environment definition to `ready`, `missing`, or `unsupported`.
2. For `ready`, clone/open a clean OS instance.
3. Install/start the target under test.
4. Run one deterministic action check.
5. Reboot only if the scenario asks for lifecycle validation.
6. Rerun the check after reboot when required.
7. Teardown disposable state.
8. Write a machine-readable report and preserve logs.

For the first backend/case, use QEMU + Linux Mint unless the user explicitly chooses another environment.

## Resolver states

- `ready`: definition exists, backend is supported on this host, and the configured image path exists.
- `missing`: definition exists but the local image is not configured or unavailable.
- `unsupported`: definition exists but the host/backend/capability tuple is not implemented or cannot run.

Failure to resolve must be visible. Do not silently fall back to a different OS image or backend.

## Workflow-node contract

Every meaningful run should produce a timestamped result directory with:

- a structured `report.json`
- host preflight output
- effective environment definition and local overrides used
- commands or runner steps performed
- logs/artifacts needed to explain pass/fail
- teardown outcome
- the next useful command when the run fails or stops early

## Guardrails

- Keep the host unchanged except for declared cache/run artifacts.
- Keep base images immutable; mutate disposable clones only.
- Do not expand to a distro matrix until the first deterministic loop is stable.
- Do not imply Windows or macOS parity until their backend capability model exists.
- Treat QEMU details as backend knowledge, not the identity of the system.

## References

- Read `references/mission-capsule.md` for the compact design anchor.
- Read `references/env-registry.md` when defining or resolving environment manifests.
- Read `references/qemu-backend.md` when touching QEMU image, boot, clone, or host capability behavior.
- Read `references/result-report-contract.md` when implementing run output, UI status, or agent summaries.

