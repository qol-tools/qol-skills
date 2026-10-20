---
name: qol-plugin-bluetooth
description: Use when working on the qol-tray Bluetooth plugin. Covers BlueZ, IOBluetooth and CoreBluetooth adapter and device operations, discovery including Bluetooth LE devices on macOS, the reconnect retry policy, audio-device readiness, live settings queries, daemon lifecycle, and doctor checks. Triggers on "plugin-bluetooth", "bluetooth", BlueZ, bluer, IOBluetooth, CoreBluetooth, Bluetooth LE, adapter power, pairing, trusting, reconnecting headphones, a device missing from search, or Bluetooth discovery.
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
| `src/main.rs` | Thin entrypoint routing to the settings handoff, the daemon, or the headless app in `src/lib.rs`. |
| `src/cli.rs` | Headless command surface, doctor registration, and text rendering. |
| `src/bluetooth/` | Platform-neutral domain: device facts, discovery state, reconnect selection and reporting, adapter health. |
| `src/bluetooth/retry.rs` | Reconnect retry policy and its per-device state. |
| `src/connect/` | Connection attempts over ordered routes. |
| `src/handoff/` | Device hold release and resume between peers. |
| `src/audio_claim/` | Target-selected audio output reclaim for a connected device. |
| `src/hostfix/` | Host fix findings such as a wedged service or a competing Bluetooth manager. |
| `src/platform/` | Target-selected backend: BlueZ through the `bluer` D-Bus bindings on Linux, IOBluetooth plus a CoreBluetooth scan on macOS, the Windows Bluetooth APIs on Windows. Pure parsing that one backend owns sits in a sibling module compiled for that target and for tests, so it is tested on every host (`low_energy.rs` for Windows, `nearby.rs` for macOS). |
| `src/settings/` | Asks qol-tray to open its host-rendered settings panel. |
| `src/config/` | Typed config loading. |

Keep cfg selection in `platform/mod.rs`. Domain code in `src/bluetooth/` must stay free of target gates and backend types so it remains unit-testable without a live adapter.

## Backend boundary

Each target backend owns every native Bluetooth interaction; on Linux that is BlueZ. Prefer the typed D-Bus bindings already in use over shelling out to a CLI: shelling out loses typed errors and turns adapter state into screen-scraping. When an operation needs a helper binary, inspect its metadata for doctor rather than executing it during a read-only check.

Device readiness is a domain question, not a backend one. Audio classification and connection-readiness predicates live in `src/bluetooth/` so both the reconnect path and the settings payload agree on what "ready" means.

## macOS discovery traps

- `IOBluetoothDeviceInquiry` finds classic (BR/EDR) devices only. Bluetooth LE peripherals such as Logitech mice and keyboards, watches and LE headsets come only from the CoreBluetooth scan that the search runs next to it. Dropping either one silently loses a whole class of devices.
- CoreBluetooth delivers its callbacks on the main queue, so the scan makes progress only while the main thread runs the run loop. The CLI and the daemon both search on the main thread. A search started on any other thread lists classic devices only and logs why.
- macOS never exposes an LE device's address. A scanned peripheral has only an identifier that is specific to this Mac, and the public API cannot pair it. Its row carries `pairing: system_settings` and offers no actions, and every device command refuses the identifier at the address boundary. Do not reach for private IOBluetooth or CoreBluetooth selectors to fill that gap.
- One device can arrive twice with no shared key: as an IOBluetooth address, because bonded LE devices sit in `pairedDevices()`, and as a CoreBluetooth identifier. Only the name joins the two, so a settings-paired row named like an address row is dropped.
- `isPaired()` can read false for a bonded LE device in `pairedDevices()`, so treat membership in that list as paired. The settings list shows only paired, trusted or discovered devices, so a false paired flag hides the device.
- `RSSI()` is an offset from the golden range, where 0 means in range, not dBm; `rawRSSI()` is the measured value. Both read 0 for an LE device that IOBluetooth does not track and +127 when the signal cannot be read. Report both as unknown.
- CoreBluetooth needs the Bluetooth privacy permission of the app responsible for the process: the terminal for the CLI, qol-tray for the daemon. Without it, LE devices are left out with a warning naming System Settings > Privacy & Security > Bluetooth.

## Common changes

**Add a device operation:** add the action to the manifest and runtime contract, add a headless command that parses and normalizes its address input, implement the operation on each supported backend, and return the resulting device fact rather than a bare success.

**Change reconnect behavior:** edit the retry policy and its state together, and keep the decision pure so it can be tested without hardware. Report per-device failures through the reconnect report instead of aborting the whole run on the first error.

**Add a settings surface:** express it in the config contract. Live-updating rows pair a query with the field that reads it, so the host can re-render state such as adapter power or an in-progress search without a plugin-local window.

**Add a doctor check:** register it with the headless app and keep it read-only. Adapter and service probes report status; they never power an adapter or start discovery to make a check pass.

## Invariants

- The domain layer is backend-agnostic; only the target-selected adapter knows about BlueZ or another native stack.
- Addresses are normalized at the boundary and used in normalized form internally.
- Discovery is bounded and stoppable; a search left running is a defect.
- Reconnect is best-effort across the selection and reports partial failure rather than hiding it.
- Unsupported targets return typed errors; never `unimplemented!()` or `compile_error!`.
- Doctor is read-only by default and never mutates adapter or device state.
- Settings are rendered by qol-tray as a native GPUI panel from the contract; the plugin never draws its own settings window.

## Verification

Run format, build, Clippy with warnings denied, and tests, plus `cargo run -q -p qol -- check`. Domain and retry logic must be covered without hardware. Claims about adapter, pairing, or reconnect behavior need evidence from a real adapter on a declared target, including that discovery stopped afterwards.

To check the settings list without touching the user's running daemon, start the built binary with no arguments and two variables set. Point `QOL_TRAY_DAEMON_SOCKET` at a short path: macOS caps socket paths at 104 bytes, and a long scratch path fails with "listener failed to start". Set `QOL_TRAY_PLUGIN_ID` to an id of your own, so the daemon loads the default config with no managed devices to reconnect. Send it newline-delimited `{"action", "input"}` JSON (`start_search`, `search_status`, `devices`), and stop it with the `kill` action.
