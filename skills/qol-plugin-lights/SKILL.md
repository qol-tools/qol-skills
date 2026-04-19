---
name: qol-plugin-lights
description: Use when working on the qol-tray lights plugin. Covers backend adapters (Zigbee2MQTT first), main-target action wiring, daemon entrypoint, and the auto-config-rendered settings UI.
---

# qol-plugin-lights

Lights domain plugin for qol-tray. Daemon-driven, backend-adapter shaped, with stable v1 action IDs so hotkeys and launcher integration stay compatible across backend swaps.

## Plugin Contract

`plugin.toml`:

- `runtime.command = "plugin-lights"`
- 18 named runtime actions covering toggle/on/off/brighter/dimmer/warmer/cooler, eight presets, set-color/brightness/colortemp, plus `settings` and `pair`. Every menu action has a runtime mapping.
- `[capabilities] serial = true` — declares the plugin needs serial-port access (Zigbee coordinator).
- `[daemon] enabled = true`, `socket = "/tmp/plugin-lights.sock"`, command shares the runtime binary.
- Platforms: `linux`, `macos`
- Binary download repo: `qol-tools/plugin-lights`, pattern `plugin-lights-{os}-{arch}`

`qol-config.toml`:

- `[section.connection]`: `backend.serial_port` (auto or `/dev/...`), `backend.channel` (11–26), `backend.network_key` (auto or fixed)
- `[section.target]`: `main_target_type` (`device`|`group`), `main_target_id`
- The connection section's actions list `["settings", "pair"]` — both are referenced from `runtime.actions`. `qol-runtime.toml` is not present today; if cross-validation tightens to require declared actions, add it.

## Architecture

Every entry to the plugin goes through `plugin_lights::runtime::entrypoint(args)` — `src/main.rs` is just a thin wrapper.

| File / Dir | Purpose |
|---|---|
| `src/lib.rs` | Public crate root, exports `runtime`, `daemon`, `service`, `backend`, `domain`, `config`, `platform` |
| `src/runtime/` | Action dispatcher: parses the action name, talks to the daemon over the socket if it's running, otherwise short-circuits. |
| `src/daemon/` | Long-running socket daemon. Owns the backend connection, applies actions to lights. |
| `src/service/` | Orchestration boundary between runtime/daemon and backend transports. Keeps backend-specific noise out of action dispatch. |
| `src/backend/` | Pluggable backend implementations. **Zigbee2MQTT is the first target** and is currently a stub. |
| `src/znp/` | Zigbee Network Processor (serial-protocol) primitives — coordinator framing, request/response. |
| `src/domain/` | Transport-agnostic light types (target, color, color temp, brightness curves). |
| `src/config/` | Plugin configuration shape, validation, loading via `qol_config`. |
| `src/platform/` | OS-specific settings launch behavior. |
| `ui/index.html` + `ui/app.js` + `ui/components/` | Auto-config shell so settings work on older qol-tray builds. New builds render the contract directly via auto-config. |

## Backend Status

- **Zigbee2MQTT**: first target, **still a stub**.
- The end-to-end goal is: connect → discover the main RGB+CCT target → toggle → brightness → color → color temp → preset slot 1.

When implementing, keep the backend behind a trait so adding a future Hue Bridge / LIFX / WLED backend doesn't require touching the action dispatcher.

## Action Stability

The 18 v1 action IDs in `plugin.toml` are intentionally stable. Hotkeys, the launcher, and (eventually) third-party tray menus bind to these names. Don't rename without bumping the plugin's contract version.

Notes on specific actions:
- `pair` triggers backend pair-mode. UI feedback comes from the auto-config status field once the live `[query]` plumbing lands; for now the action body should at least log success/failure.
- `set-color-main` / `set-brightness-main` / `set-colortemp-main` are designed to accept a payload via socket message body. Today's runtime dispatcher passes the action name only — extend the daemon protocol when adding payload-carrying actions.

## Common Tasks

**Wire a backend method**: implement the trait in `src/backend/<vendor>/`, update `service` to dispatch to it, and verify `runtime` exposes the action name. If the action takes a payload, extend the daemon command parser.

**Add a config field**: add it to `qol-config.toml`, mirror the type in `src/config/`, and ensure validation rejects bad values. Auto-config renders the field in qol-tray.

**Add a preset**: presets 1–8 are pre-declared in `plugin.toml` so hotkeys can bind them. Extend the preset table in `service` (or wherever preset bodies live) to map a preset slot to a backend payload.

## Gotchas

- **No `qol-plugin-api` dep.** Lights does its own daemon socket without using the shared helpers. If you find yourself reimplementing daemon protocol pieces, switch to `qol_plugin_api::daemon` like the other plugins.
- **`getrandom`** is a direct dep — used for network-key generation. Don't accidentally pull a different random source into a backend; reuse the existing helper.
- **`tungstenite` 0.26** is in the deps for a future MQTT-over-WS transport. Currently unused. Don't remove it without checking the Zigbee2MQTT plan.
- **Serial port enumeration on macOS** uses different device-name conventions than Linux (`/dev/tty.usbserial-*` vs `/dev/ttyUSB*`). The `auto` value in `backend.serial_port` should DTRT on both.

## Shared library usage

- `qol-config` for config loading and contract definition.
- No `qol-plugin-api` (yet — see Gotchas).

## Build / Dev

- Standard plugin: `cargo test` runs the contract validation. Release flow is tag-driven via `qol-cicd`.
- The `ui/index.html` shell can be ignored on modern qol-tray; the auto-config path takes over.
