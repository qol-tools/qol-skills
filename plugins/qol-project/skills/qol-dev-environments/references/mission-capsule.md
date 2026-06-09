# Mission Capsule

## Framing

Primary contract:

```text
environment registry first
VM/QEMU first backend
workflows as per-environment actions
```

## Core contract

- Keep the first artifact executable, not documentation-only: `env up` clean environment -> `flow run` deterministic scenario with optional reboot and rerun checks -> teardown/report.
- Treat `qol-mission` value as measured by repeatable behavior, not spec volume.
- Do not move beyond the first deterministic loop until it is stable.

## Concept split

- `env up`: boot/open a clean OS instance for manual or assisted testing.
- `flow run`: run one deterministic scenario inside that environment, optionally reboot and rerun checks, without host mutation.

## Registry model

- Repo-owned environment definitions (`flows/envs/*.toml`): OS identity, boot/runtime needs, backend, and capability metadata.
- Local overrides (`~/.config/qol/dev-envs.toml`): image paths, cache/run roots, and host-specific behavior.
- Resolver states:
  - `ready`: path exists and backend is supported.
  - `missing`: definition exists but image is unavailable locally.
  - `unsupported`: definition exists but backend or distro capability is missing on this host.

## MVP execution

- First backend/case: QEMU + Linux Mint.
- Per case: `qcow2` clone from a base image.
- Steps: install/start -> action check (runtime/socket/process) -> reboot -> same action check -> teardown.
- Required log outputs: startup, action result, cleanup.
- Host invariant: host config/files/state remain unchanged outside declared cache/run artifacts.

## Not yet

- No full UI automation in the first loop.
- No multi-distro matrix until the first flow is stable.
- No implied Windows/macOS parity assumptions.

## Next priorities

1. Build deterministic `flow run` contract and log schema.
2. Add capability-aware resolver (`ready` / `missing` / `unsupported`) in discovery UI.
3. Add extension points for additional `flows/envs/*.toml` providers.

