# Mission Capsule

## Primary contract

```text
environment registry first
backend capability second
workflows as environment actions
evidence and cleanup as completion criteria
```

Build clean-OS testing as an executable product surface, not a collection of VM instructions. A person or agent should supply a small set of inputs and receive a reproducible environment or a structured report.

## User-facing promises

- Keep testing off the user's active desktop session when a clean environment can host it.
- Make prerequisites and unsupported capabilities visible before launch.
- Leave the host as found outside declared config, cache, run, and evidence locations.
- Make failure recoverable from durable ownership and report state.
- Make parallelism bounded by explicit resource admission.
- Preserve enough evidence for another human or agent to continue without rediscovery.

## Concept split

- Use `env up` for detached clean guests that still need manual or assisted interaction.
- Use `flow run` for deterministic input-to-verdict scenarios that own their teardown.
- Use environment definitions for OS identity and requirements.
- Use backend modules for QEMU or another runtime's mechanics.
- Use workflow adapters for guest-specific automation.

Do not force UI-heavy behavior into a fake deterministic test. A quickly reproducible guest with logs and screenshots is a valid workflow node when human judgment remains necessary.

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
