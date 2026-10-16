---
name: qol-plugin-controllers
description: Use when working on the qol-tray Controllers plugin or the host's reusable gamepad field, including native controller input, controller hardware profiles, Linux evdev input, Bluetooth adapter and signal diagnostics, driver-specific fixes, and rumble capability reporting.
---

# QoL Controllers

Keep the Controllers plugin's native hardware knowledge separate from the reusable gpui gamepad field that qol-tray renders. Preserve raw evidence and its unit or source before deriving a label.

## Read the relevant reference

- Read [gamepad-field.md](references/gamepad-field.md) before changing controller layouts, profiles, the `controller_input` payload, live input monitoring, or rumble reporting.
- Read [linux-bluetooth.md](references/linux-bluetooth.md) before changing adapter resolution, signal collection, connection diagnostics, or Linux controller metadata.

## Ownership

| Area | Owner |
| --- | --- |
| Native detection, driver fixes, evdev or XInput input, and Linux Bluetooth metadata | the `qol-controllers` plugin source |
| Generic `type = "gamepad"` rendering, monitoring, profiles, and presentation | `libs/gpui/src/gamepad/`, hosted by the settings panel (`FieldKind::Gamepad` in `apps/tray/src/plugins/config/`) |
| Controller diagram geometry | `libs/gpui/src/gamepad/diagram/` |
| Host/plugin query contract | `qol-config.toml`, `qol-runtime.toml`, and the plugin daemon payload |

Do not move a hardware-specific daemon workaround into the generic field. Do not build a plugin-local copy of UI behavior that every gamepad field should share.

## Data flow

1. The plugin's platform adapter snapshots native input per device: evdev on Linux, XInput on Windows; other targets report `available = false`.
2. Apply a native button layout only when the device identity matches (for example the GuliKit evdev layout); everything else stays standard.
3. Serve the snapshot through the `controller_input` query with typed connection metadata such as transport, signal, and adapter.
4. The host's `GamepadMonitor::apply_query` parses the payload; a card about one pad uses `scoped_to` so it never renders another pad's input.
5. Render presentation labels from typed evidence such as `absolute_dbm` or `bredr_link_margin_db`; never infer units from the number alone.

## Invariants

- Treat a reported `mapping` as the source's claim, not proof that vendor extras or driver quirks are canonical.
- Keep unknown buttons visible instead of dropping or inventing labels for them.
- Show controller-side buttons as non-testable only when the selected hardware mode does not emit an input event.
- Resolve the actual Bluetooth adapter or report it unavailable. Never let an adapter-sensitive command silently select the system default.
- Keep advertised RSSI and BR/EDR link margin as different types. Do not compare, average, or threshold them together.
- Describe signal evidence as signal evidence. It does not directly measure packet loss, latency, interference, antenna integrity, or reconnect reliability.
- Rumble is a driver capability the plugin reports per device; the host field does not play effects.

## Change workflow

1. Inspect the field contract, daemon payload, gpui gamepad model, and relevant reference before editing.
2. Put mapping and presentation decisions in pure functions; keep device polling and query plumbing in the daemon and monitor.
3. Pin daemon JSON shape and pure model transformations with focused tests.
4. Use `qol-tray:qol-apps-testing` for test selection.
5. Exercise the real settings panel with a controller when the change affects layout, input, or signal display. Report when hardware verification was unavailable.

## Common changes

### Add a controller profile

Match the narrowest stable identity available (name plus vendor/product), define geometry and legends as profile data, and test profile selection, canonical controls, extra-button discovery, and geometric clearance. Do not rewrite raw button order globally for a quirk observed in one driver/device combination.

### Extend native diagnostics

Add a typed field to the native model, serialize it in one contract payload, parse it in the gpui gamepad model, and render from that model. Use `qol-project:qol-arch-channels` before introducing a new host/plugin communication path.

### Change rumble reporting

Keep capability detection separate from driver fixes. Test the per-device verdict and the fix state independently.

## Related skills

- Use `qol-langs:gpui-conventions` for the gpui field implementation.
- Use `qol-langs:rust-conventions` for native platform code.
- Use `qol-project:qol-plugin-gpui-surfaces` for the hosted settings panel.
- Use `qol-tray:qol-apps-testing` for test selection.
