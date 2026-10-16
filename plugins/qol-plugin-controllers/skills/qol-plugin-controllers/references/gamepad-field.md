# Gamepad field and native input

Source-checked 2026-10-16 against `plugins/controllers` and `libs/gpui/src/gamepad/`. Inspect current implementation before assuming paths remain unchanged.

## Native input model

All live input comes from the plugin. Each platform adapter in `plugins/controllers/src/platform/` produces a `NativeInputSnapshot` with `available`, a `source`, and one item per device:

- Linux reads evdev devices (`source = "linux-evdev"`) and adds Bluetooth signal and adapter metadata.
- Windows reads XInput (`source = "windows-xinput"`).
- Other targets report `available = false`, and the host shows the field as unavailable.

The daemon serves the snapshot as the `controller_input` query declared on the `type = "gamepad"` field in `qol-config.toml`.

In qol-tray:

- `libs/gpui/src/gamepad/model.rs` owns `GamepadMonitor`, `ControllerSnapshot`, query parsing (`apply_query`), profile selection, motion smoothing, and connection badges.
- `libs/gpui/src/gamepad/view.rs` renders the panel (`gamepad_panel`).
- `libs/gpui/src/gamepad/diagram/` owns the controller drawing and its geometry.
- The settings panel binds each gamepad field to its query; fields that declare the same query share one monitor state.

## Layouts and profiles

Two layers apply hardware corrections, each narrowly:

1. Native button layout (`ButtonLayout` in the Linux adapter) remaps evdev key codes only for a device whose identity matches, such as the GuliKit layout where face, shoulder, select/start and stick-click codes differ from standard.
2. Presentation profile (`ControllerProfile` in the gpui model) picks legends and geometry from the device name plus vendor/product id, falling back to the Xbox profile.

Apply a correction only to the affected device shape and keep already-canonical shapes untouched.

## Connection and signal

The payload carries `transport`, an optional typed `signal`, and an optional `adapter` per device. `connection_badge` grades `absolute_dbm` into levels and shows any other kind as a link margin in dB without a level. See [linux-bluetooth.md](linux-bluetooth.md) for adapter resolution and signal semantics.

## Rumble

Rumble is reported, not played. The plugin's controller rows state whether the kernel exposes a rumble interface, and the fixes module offers driver workarounds (such as the xpadneo rumble fix) only when they apply.

## Domain-specific verification

- Pin the `controller_input` JSON shape in the plugin tests.
- Pin `apply_query` for available, unavailable, empty, and multi-controller payloads, and `scoped_to` for per-pad cards.
- Pin profile selection and native layout remapping with table cases.
- Keep every diagram control inside the body and clear of neighboring controls.

Run the real settings panel with a controller after deterministic tests when hardware is available. Model tests prove contracts; they do not prove the OS/driver/device stack emits the expected events.
