---
name: qol-plugin-bluetooth
description: Use when working on the qol-tray Bluetooth plugin. Covers BlueZ adapter and device operations, discovery, the reconnect retry policy, audio-device readiness, live settings queries, daemon lifecycle, and doctor checks. Triggers on "plugin-bluetooth", "bluetooth", BlueZ, bluer, adapter power, pairing, trusting, reconnecting headphones, or Bluetooth discovery.
---

# qol-plugin-bluetooth

Bluetooth owns adapter control, device discovery, and reliable reconnection of selected devices. Supported targets, actions, and device capabilities come from the checked-out manifest, adapters, and tests; do not maintain a support matrix here.

## Contract sources

- `plugin.toml` owns actions, daemon metadata, declared capabilities, platform availability, and release artifacts.
- `qol-config.toml` owns settings sections, fields, live queries, and the actions each field invokes.
- `qol-runtime.toml` owns the runnable action contract and its typed input.
- `Cargo.toml` owns target-scoped native dependencies.

Change an action name in the manifest, runtime contract, config contract, and dispatcher together, then run contract validation instead of copying values into prose.

## Source ownership

| Path | Responsibility |
|---|---|
| `src/main.rs` | Thin entrypoint delegating to the headless app. |
| `src/cli.rs` | Headless command surface, doctor registration, and text rendering. |
| `src/bluetooth/` | Platform-neutral domain: device facts, discovery state, reconnect selection and reporting, adapter health. |
| `src/bluetooth/retry.rs` | Reconnect retry policy and its per-device state. |
| `src/platform/` | Target-selected backend; the Linux adapter talks to BlueZ through the `bluer` D-Bus bindings. |
| `src/settings/` | Native settings panel with a browser fallback. |
| `src/config/` | Typed config loading. |

Keep cfg selection in `platform/mod.rs`. Domain code in `src/bluetooth/` must stay free of target gates and backend types so it remains unit-testable without a live adapter.

## Backend boundary

The Linux backend owns every BlueZ interaction. Prefer the typed D-Bus bindings already in use over shelling out to a CLI: shelling out loses typed errors and turns adapter state into screen-scraping. When an operation needs a helper binary, inspect its metadata for doctor rather than executing it during a read-only check.

Device readiness is a domain question, not a backend one. Audio classification and connection-readiness predicates live in `src/bluetooth/` so both the reconnect path and the settings payload agree on what "ready" means.

## Common changes

**Add a device operation:** add the action to the manifest and runtime contract, add a headless command that parses and normalizes its address input, implement the operation on each supported backend, and return the resulting device fact rather than a bare success.

**Change reconnect behavior:** edit the retry policy and its state together, and keep the decision pure so it can be tested without hardware. Report per-device failures through the reconnect report instead of aborting the whole run on the first error.

**Add a settings surface:** express it in the config contract. Live-updating rows pair a query with the field that reads it, so the host can re-render state such as adapter power or an in-progress search without a plugin-local window.

**Add a doctor check:** register it with the headless app and keep it read-only. Adapter and service probes report status; they never power an adapter or start discovery to make a check pass.

## Invariants

- The domain layer is backend-agnostic; only the target-selected adapter knows about BlueZ.
- Addresses are normalized at the boundary and used in normalized form internally.
- Discovery is bounded and stoppable; a search left running is a defect.
- Reconnect is best-effort across the selection and reports partial failure rather than hiding it.
- Unsupported targets return typed errors; never `unimplemented!()` or `compile_error!`.
- Doctor is read-only by default and never mutates adapter or device state.
- Settings are host-rendered from the contract; the native panel falls back to the browser rather than failing the action.

## Verification

Run format, build, Clippy with warnings denied, and tests, plus `cargo run -q -p qol -- check`. Domain and retry logic must be covered without hardware. Claims about adapter, pairing, or reconnect behavior need evidence from a real adapter on a declared target, including that discovery stopped afterwards.
