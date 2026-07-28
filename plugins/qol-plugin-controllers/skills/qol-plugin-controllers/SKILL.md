---
name: qol-plugin-controllers
description: Use when working on the qol-tray Controllers plugin or the host's reusable gamepad field, including browser Gamepad input, controller hardware profiles, Linux evdev supplementation, Bluetooth adapter and signal diagnostics, driver-specific fixes, and rumble or haptics testing.
---

# QoL Controllers

Keep the Controllers plugin's native hardware knowledge separate from qol-tray's reusable browser gamepad UI. Preserve raw evidence and its unit or source before deriving a label.

## Read the relevant reference

- Read [browser-gamepad.md](references/browser-gamepad.md) before changing controller layouts, mappings, live input monitoring, native/browser merging, or haptics.
- Read [linux-bluetooth.md](references/linux-bluetooth.md) before changing adapter resolution, signal collection, connection diagnostics, or Linux controller metadata.

## Ownership

| Area | Owner |
| --- | --- |
| Native detection, driver fixes, evdev supplementation, and Linux Bluetooth metadata | the `plugin-controllers` plugin source |
| Generic `type = "gamepad"` rendering, browser monitoring, profiles, haptics, and presentation | `apps/qol-tray/ui/views/plugin-config/fields/` |
| Controller illustration geometry | `apps/qol-tray/ui/assets/gamepad-*` |
| Gamepad styling | `apps/qol-tray/ui/styles/plugin-config.css` |
| Host/plugin query contract | `qol-config.toml`, `qol-runtime.toml`, and the plugin daemon payload |

Do not move a hardware-specific daemon workaround into the generic field. Do not build a plugin-local copy of UI behavior that every gamepad field should share.

## Data flow

1. Snapshot browser-visible axes, buttons, mapping, identity, and haptic capability from `navigator.getGamepads()`.
2. Apply a narrow hardware/browser profile only when its identity and exposed layout match.
3. Query the plugin's native input payload for facts the browser cannot reliably expose, such as Linux stick clicks and exact Bluetooth connection metadata.
4. Merge native data into one matching browser gamepad. Never leak data between simultaneously connected controllers.
5. Render presentation labels from typed evidence such as `absolute_dbm` or `bredr_link_margin_db`; never infer units from the number alone.

## Invariants

- Treat `mapping = "standard"` as the browser's mapping claim, not proof that vendor extras or browser-specific quirks are canonical.
- Keep unknown buttons visible on the discovery rail instead of dropping or inventing labels for them.
- Show controller-side buttons as non-testable only when the selected hardware mode does not emit an input event.
- Resolve the actual Bluetooth adapter or report it unavailable. Never let an adapter-sensitive command silently select the system default.
- Keep advertised RSSI and BR/EDR link margin as different types. Do not compare, average, or threshold them together.
- Describe signal evidence as signal evidence. It does not directly measure packet loss, latency, interference, antenna integrity, or reconnect reliability.
- Bound every rumble effect and stop it on explicit stop, controller change, disconnect, hide, and unmount.

## Change workflow

1. Inspect the field contract, daemon payload, browser model, and relevant reference before editing.
2. Put mapping and presentation decisions in pure functions; keep polling, fetch, and actuator calls in orchestration hooks or components.
3. Pin daemon JSON shape and pure UI transformations with focused tests.
4. Use `qol-tray:qol-apps-testing` for the canonical browser-hardware testing recipe.
5. Exercise the real WebUI with a controller when the change affects layout, input, signal display, or rumble. Report when hardware verification was unavailable.

## Common changes

### Add a controller profile

Match the narrowest stable identity available, define geometry and legends as profile data, and test profile selection, canonical controls, extra-button discovery, and geometric clearance. Do not rewrite raw button order globally for a quirk observed in one browser/device combination.

### Extend native diagnostics

Add a typed field to the native model, serialize it in one contract payload, normalize it at the browser boundary, and render from the normalized model. Use `qol-project:qol-arch-channels` before introducing a new host/plugin communication path.

### Change rumble behavior

Keep capability detection separate from effect planning and playback. Test magnitudes, durations, fallback mode, cancellation, and cleanup independently.

## Related skills

- Use `qol-langs:preact-conventions` for the htm/Preact implementation.
- Use `qol-langs:rust-conventions` for native platform code.
- Use `qol-tray:qol-tray-ui-systems` for host UI interaction and focus behavior.
- Use `qol-tray:qol-apps-testing` for test selection and browser-hardware fakes.
