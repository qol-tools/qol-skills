---
name: qol-plugin-lights
description: Use when working on the qol-tray lights plugin. Covers backend adapters, Zigbee coordinator control, live color transport, daemon lifecycle, contract wiring, and native settings integration.
---

# qol-plugin-lights

Lights is a daemon-driven plugin with transport-independent light commands and backend-specific device control. Treat the checked-out source as authoritative; do not infer backend readiness, action availability, or platform support from this skill.

## Contract sources

- `plugin.toml` owns the runtime command, public action IDs, daemon endpoints, platform availability, capabilities, and release artifact metadata.
- `qol-config.toml` owns settings fields and every action, query, or stream reference rendered by the host.
- `qol-runtime.toml` owns the runnable action/query/stream contract.
- `Cargo.toml` owns dependencies and target scoping.

Change referenced names across all contract files and their Rust dispatchers in one patch. Run the plugin contract tests and `qol check`; never copy a manifest inventory into prose.

## Source ownership

| Path | Responsibility |
|---|---|
| `src/main.rs`, `src/lib.rs` | Thin executable boundary and crate exports. |
| `src/runtime/` | Public action dispatch and client-side daemon communication. |
| `src/daemon/` | Long-lived process state, socket handling, live transport, and query responses. |
| `src/service/` | Orchestration between public light commands and a selected backend. |
| `src/backend/` | `LightBackend` plus concrete backend adapters. Adapter availability comes from implementations and tests under this directory. |
| `src/znp/` | Zigbee Network Processor framing, coordinator lifecycle, device discovery, and cluster commands. |
| `src/domain/` | Transport-independent targets, capabilities, state, colors, and commands. |
| `src/config/` | Config model, validation, persistence, and source-contract translation. |
| `src/platform/` | OS-specific settings or device-discovery behavior selected at one cfg wiring boundary. |
| `ui/` | Compatibility web surface; contract-driven host settings remain canonical. |

Do not move backend or protocol details into runtime dispatch. A new adapter implements the backend trait and is selected by service/config wiring; public action identities remain independent of the adapter.

## Contract stability

Every action ID declared by `plugin.toml` is an external contract consumed by hotkeys, launcher entries, settings fields, or automation. Rename one only with an intentional contract migration.

For an action referenced by `qol-config.toml`, require a matching runnable declaration and dispatcher. For a query or stream, require both the runtime declaration and a daemon response path. Payload-carrying actions must use the daemon transport rather than smuggling values through action names.

The live color boundary is owned by `src/daemon/` and the corresponding runtime stream. Keep throttling, latest-value coalescing, inherited-listener adoption, and daemon handoff behavior together.

## Common changes

**Add a backend:** implement `LightBackend` under `src/backend/`, add explicit configuration and selection, preserve transport-independent domain commands, and test backend errors without hardware where possible.

**Add a public action:** declare it in `plugin.toml` and `qol-runtime.toml`, dispatch it through `src/runtime/`, implement it through service/backend layers, and add any settings reference only after the runnable path exists.

**Add a query or stream:** define it in `qol-runtime.toml`, reference it from `qol-config.toml`, and implement the daemon response with the exact declared shape.

**Change Zigbee behavior:** keep serial framing and cluster protocol inside `src/znp/`; expose device-level behavior through the backend rather than leaking coordinator primitives into service code.

**Change configuration:** update the TOML contract, Rust model, validation, and persistence together. The contract defaults are authoritative; do not restate them here.

## Invariants

- Runtime dispatch depends on domain/service abstractions, not a concrete coordinator implementation.
- Backend health and device discovery failures are visible through declared queries or clear errors.
- Serial and other platform-only dependencies stay target-scoped in `Cargo.toml`.
- Dependencies are justified by live source references. Remove an unused dependency instead of preserving it for a prose roadmap.
- Settings work through the host contract without requiring the compatibility web surface.
- Daemon start, reload, and reconnect paths remain idempotent.

## Verification

Run format, build, Clippy with warnings denied, plugin tests, and `cargo run -q -p qol -- check`. Exercise hardware-independent protocol/config tests on every change; hardware claims require live coordinator evidence.
