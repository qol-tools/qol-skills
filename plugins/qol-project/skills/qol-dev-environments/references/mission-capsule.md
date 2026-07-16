# Mission Capsule

## Primary contract

```text
qol dev as the normal user surface
shared environment engine beneath every surface
environment registry first
backend capability second
workflows as environment actions
evidence and cleanup as completion criteria
```

Build clean-OS testing as an integrated `qol dev` product surface, not a collection of VM instructions. A person or agent should select a sandbox action and receive a reproducible environment or a structured report. CLI commands remain useful as thin automation and debugging veneers over the same engine.

## User-facing promises

- Keep automated guest-flow testing off the user's active desktop session.
- Keep agent-driven pointer, keyboard, window, display, and plugin actions inside verified guest control.
- Make prerequisites and unsupported capabilities visible before launch.
- Leave the host as found outside declared config, cache, run, and evidence locations.
- Make failure recoverable from durable ownership and report state.
- Make parallelism bounded by explicit resource admission.
- Preserve enough evidence for another human or agent to continue without rediscovery.

These promises describe the automated guest-runtime path. The outer `qol dev` session still builds and packages development artifacts as the host user, so the application as a whole is not a hostile-source or global agent-security boundary.

## Concept split

- Use the `qol dev` Sandbox panel for ordinary selection, verified image import, launch, lane count, and status.
- Use Enter to package existing host-built artifacts and run `qol dev` inside a headless guest without compiling there.
- Use `env up` as the direct engine veneer for generic detached guests or parallel artifact-backed development sessions.
- Use `flow run` as the direct engine veneer for deterministic input-to-verdict scenarios that own their teardown.
- Use environment definitions for OS identity and requirements.
- Use backend modules for QEMU or another runtime's mechanics.
- Use workflow adapters for guest-specific automation.

Do not force UI-heavy behavior into a fake deterministic test. An artifact-backed guest with logs and screenshots is a valid workflow node when human judgment remains necessary. Keep an explicitly windowed manual path below the normal sandbox surface when direct observation is genuinely required.

## Portability rule

Represent portability through declared capabilities and resolver outcomes. Never infer that an environment, workflow adapter, or process-control backend works because another platform does.

Use the definitions and implementation at read time instead of documenting a fixed distro or platform matrix here.

## Completion rule

Treat a run as complete only when:

1. Its inputs and effective environment are recorded.
2. Its workload verdict is recorded or the blocking prerequisite is explicit.
3. Every owned process has a verified terminal outcome.
4. Disposable artifacts are removed or deliberately retained with a reported reason.
5. Resource reservations are released only after cleanup proof.
