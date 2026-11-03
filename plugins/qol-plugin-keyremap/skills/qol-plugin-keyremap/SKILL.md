---
name: qol-plugin-keyremap
description: Use when working on the qol-tray key remap plugin. Covers config-to-rule resolution, native event interception, per-app policy, hot reload, daemon lifecycle, the macOS virtual HID helper, and target adapters.
---

# qol-plugin-keyremap

Key Remap converts declarative config rules into native input-event transformations. `plugin.toml` owns runtime/platform availability, `qol-config.toml` owns rule shapes/defaults, and source/tests own implemented rule semantics.

## Contract ownership

- Never restate the manifest action, platform, daemon, or menu inventory here.
- A config rule kind exists only when contract schema, Rust raw/resolved models, native callback behavior on every supported adapter, and tests agree. Settings are rendered by qol-tray's native GPUI panel from `qol-config.toml`; there is no plugin-local editor.
- If config references a named runtime action/query, declare it in `qol-runtime.toml`; otherwise do not add an empty runtime contract.
- Run plugin tests and `qol check` after contract changes.

## Source ownership

| Path | Responsibility |
|---|---|
| `src/main.rs` | Thin process entrypoint; delegates to the headless surface in `src/cli.rs`. |
| `src/platform/mod.rs` | Single target-selection boundary and the `PlatformAdapter` trait. |
| `src/platform/engine/` | Shared macOS/Windows engine: contract-backed config, rule resolution (`remap`), and the reload/swap daemon loop (`serve`, `Remapper`). |
| `src/platform/macos/app/` | macOS process wiring that plugs the tap, input backends, and layout store into the engine. |
| `src/platform/macos/app_tracker.rs` | Live frontmost-application tracking. |
| `src/platform/macos/tap.rs`, `src/platform/macos/input/` | CGEventTap ownership, native event transformation, `BackendId`/`BackendCell`, `selection` (which backend a Key backend choice gets), and `backends/hid_helper/` (the helper session). |
| `src/platform/macos/karabiner/` | Karabiner-Elements backend: `compile` (rules to manipulators), `document`/`store` (karabiner.json sync with a sidecar record), `service` (probe and the `qol_keyremap_active` variable), `backend` (daemon state machine). |
| `src/platform/macos/hid_helper/`, `src/platform/macos/virtual_hid/` | Privileged HID helper install/protocol/watchdog and the Karabiner VirtualHIDDevice client. |
| `src/platform/macos/layout/`, `src/platform/macos/secure_input/` | Keyboard layout snapshots and Secure Input detection and warning. |
| `src/platform/windows/` | Windows adapter: low-level hooks, foreground tracking, key translation, profile, and the engine-backed service. |
| `src/platform/linux/`, `src/platform/fallback/`, `src/platform/virtual_keyboard_absent/` | Typed unsupported adapter for targets without input hooks; `linux/` and `fallback/` only name the target. |
| `qol-hotkeys::macos_keycode` | Shared key name/code translation; do not recreate a plugin-local forwarding module. |

Keep native callbacks allocation-light and independent of TOML/UI shapes. Resolve and validate before atomically swapping callback state.

## Directory invariants

- Keep `src/` limited to `main.rs` plus owned module directories; do not add root-level feature helpers.
- Keep every adapter in directory form: `platform/<name>/mod.rs`. Never add `platform/macos.rs`, a mixed file/directory module, or a catch-all `non_macos` module.
- Keep target selection gates only in `platform/mod.rs`. Put adapter-local helpers beneath the owning OS directory.
- The manifest declares macOS and Windows, and both adapters share `platform/engine/`. Put rule semantics in the engine and only native interception in the adapter; never duplicate resolution logic per OS.

## Daemon lifecycle

1. Load and resolve config before enabling interception.
2. Start the native adapter and socket listener.
3. On reload, build a complete replacement state, report semantic changes, and swap atomically.
4. On kill, error, or shutdown, disable interception and release native resources before removing the socket.

An existing daemon may accept a reload from a second process, but process ownership and cleanup remain single-owner.

## Key backends (macOS)

The `key_backend` setting picks what remaps keys: `auto`, `event_tap`, `hid_helper` or `karabiner_elements`.

- `auto` is the helper when it holds the keyboards, else the event tap. It never picks Karabiner-Elements; installing Karabiner-Elements must not change behavior.
- A chosen backend that is not ready falls back to the event tap, and doctor's `key_backend` check names what is missing and the fix.
- The helper seizes keyboards only under `auto` or `hid_helper` (`InputState::helper_allowed`); it never overwrites a `KarabinerElements` cell.
- Karabiner-Elements order: switch the cell first, then set the variable to 1. Leaving: variable 0, cell back to the tap, then remove the block. A core-service pid change re-sets the variable; a layout change recompiles.
- The block is identified by its description and gated by `variable_if qol_keyremap_active == 1`; `karabiner-sync`, `karabiner-remove` and doctor's `karabiner_rules` (a dry run) share `Store`.
- qol hotkeys ride the same block, so they survive Secure Input: the tray publishes `HotkeysChanged { hotkeys, relay }` (replayed on subscribe) and listens on the `relay` datagram socket. `karabiner/hotkeys.rs` appends the hotkey manipulators after the remap rules: a `send_user_command` with `HotkeyPress { pressed: true }` and another in `to_after_key_up`. Hotkeys never use `from.modifiers.mandatory`: Karabiner-Elements lets go of mandatory modifiers around `to` and `to_after_key_up`, which closed Alt Tab at once. Each modifier key instead passes through and sets `qol_hotkey_held_<key>` to 1, and `to_after_key_up` sets it back to 0. Karabiner-Elements holds only the last `to` event until key up, so the modifier's `key_code` must come after the `set_variable`; with the key first, the modifier is released at once and Alt Tab closes. `key_up_value` is not used, because only the held last event keeps it. Each hotkey takes its key with `optional: ["any"]` plus one manipulator per side choice of its held modifiers, with the other modifiers' variables at 0. The tray feeds them to the tap's own `KeyMatcher` and beats held continuous hotkeys itself, since Karabiner-Elements sends no repeats. No `relay` means no hotkey manipulators. Key Remap toggled off sets the variable to 0, so hotkeys fall back to the tap.

## Common changes

**Add a rule kind:** extend contract schema, raw/resolved engine types, native transformation on macOS and Windows, serialization, and tests in one change.

**Add per-app behavior:** inspect whether each resolved rule carries an explicit target predicate. If policy is only a global exclusion list, restructure around per-rule predicates instead of stacking inverse filters.

**Expand platform support:** implement a real input adapter and permission story on top of `platform/engine/`, keep target dependencies scoped, verify cleanup, then change `plugin.toml`. A non-target adapter must return typed errors; never use `compile_error!`.

## Native input invariants

- Native callback ownership is explicit; raw-pointer/`Arc::into_raw` lifetimes are paired and tested.
- Reload never exposes partially resolved state to the callback.
- Exclusion/target policy is evaluated from the same frontmost-app snapshot as the event transformation.
- Permission denial is visible and actionable.
- Shutdown cannot leave a tap, grab, or synthetic input device active.
- Dev dependencies require live test references; remove leftovers.

## Verification

Run format, build, Clippy with warnings denied, tests, and `cargo run -q -p qol -- check`. Compile every manifest-declared target plus typed-error fallbacks. Runtime remapping claims require live input and cleanup verification on the adapter platform.
