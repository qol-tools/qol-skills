---
name: qol-plugin-window-actions
description: Use when working on the qol-tray Window Actions plugin, including snapping, centering, minimize/restore, monitor movement, continuous glide actions, Cinnamon/X11 behavior, platform backends, or window-movement diagnostics.
---

# Window Actions

Work in `plugins/plugin-window-actions` from the qol-monorepo root. Treat
`plugin.toml` as the source of truth for supported platforms, runtime commands,
actions, daemon configuration, and which actions are continuous.

## Runtime contract

- Keep execution in the Rust `window-actions` binary. Do not add a shell
  entrypoint fallback.
- Validate `plugin.toml` through
  `qol_plugin_api::manifest::PluginManifest::load_and_validate()` in the
  contract test.
- Route ordinary actions through `platform::execute_action()`.
- Route continuous actions through the daemon because their state spans
  multiple requests.
- Load settings through the qol-config contract. Keep the Rust type, contract
  defaults, and property tests aligned.

## Start here

| Concern | Source |
|---|---|
| CLI and daemon entry | `src/main.rs` |
| Request parsing and continuous runtime state | `src/daemon.rs` |
| Direction and phase types | `src/movement.rs` |
| Platform selection | `src/platform/mod.rs` |
| Minimize/restore rules | `src/restore.rs` |
| Persisted minimized-window stack | `src/state_store.rs` |
| Linux action routing | `src/platform/linux/mod.rs` |
| Cinnamon glide controller | `src/platform/linux/glide.rs` |
| Cinnamon geometry scripts | `src/platform/linux/scripts.rs` |
| X11 discovery and activation | `src/platform/linux/system.rs` |
| macOS Accessibility backend | `src/platform/macos/` |

Follow the platform declaration in `plugin.toml`; the presence of a compiled
module does not by itself make that platform supported.

## Continuous glide ownership

The end-to-end flow crosses qol-tray and the plugin:

1. `plugin.toml` marks each glide action as continuous.
2. qol-tray registers the hotkey and emits structured `start`, `heartbeat`, and
   `stop` phases.
3. `src/daemon.rs` parses the phase and keeps one `GlideController` alive for
   the active session.
4. The platform controller owns active directions and updates window motion.

Preserve these invariants:

- A physical direction release stops that direction immediately.
- Releasing a required modifier stops every active continuous action.
- Heartbeats extend the watchdog; they do not change direction intent.
- The watchdog stops motion if the host disappears or phase delivery breaks.
- The most recently started direction wins when opposite directions share an
  axis.
- Diagonal motion is normalized so it is not faster than axial motion.
- Motion uses elapsed time rather than assuming every timer tick is exact.

Do not suppress terminal releases to work around autorepeat. A start recovered
from physical state may not have a matching global-hotkey release, which turns
release suppression into stuck movement. Fix input reconciliation in qol-tray
instead of teaching the plugin to guess whether a key remains held.

## Cinnamon movement invariant

Cinnamon may constrain a requested frame position at a monitor or work-area
boundary. After `move_frame()`, read `get_frame_rect()` and reconcile the
controller coordinates with the actual frame position. Preserve fractional
motion only when Cinnamon accepted the requested integer target.

Never continue dead-reckoning from a rejected position. Otherwise the internal
coordinate accumulates invisible overshoot at an edge, and reversing direction
appears delayed while the internal value travels back to the visible window.

Unmaximize a focused window before starting a new Linux glide session. Keep the
same window for the session rather than switching targets as focus changes.

## Diagnose glide behavior

Classify the symptom before changing input code:

- If it depends on a monitor edge, maximized state, or window geometry, inspect
  requested versus actual Cinnamon frame positions first.
- If the host emits the correct phase immediately but motion is wrong, inspect
  the plugin controller or compositor script.
- If the host phase itself is missing or late, inspect qol-tray hotkey capture
  and physical-state reconciliation.

Correlate the host and plugin trace in one timeline:

```bash
rg 'WINACT_(HOTKEY|DISPATCH|GLIDE)' /tmp/qol-altmon.log
```

`WINACT_HOTKEY` identifies the event source and active chord,
`WINACT_DISPATCH` measures host transport, and `WINACT_GLIDE` reports the
daemon phase, direction, elapsed time, and compositor observation. Carry
`trace_session`, `trace_seq`, and `trace_source` through the daemon request so
the rows remain joinable.

Use `qol_runtime::probe!` for new diagnostic events and follow
`qol-trace-discipline`. Do not add raw `println!` logging.

Only probe lower input layers when the host trace is wrong. On X11,
`xinput test-xi2 --root` observes raw XInput events. To isolate the kernel input
stream from X11 and qol-tray without changing device settings, use a bounded
exclusive evdev capture:

```bash
sudo timeout 20s evtest --grab /dev/input/eventN
```

Read the device node from `xinput list-props <device-id>`; never hardcode an
event number in code or documentation.

## Minimize and restore

Keep minimized-window state as a validated LIFO stack. Before restoring, reject
expired records, stale process identities, excluded window types, launcher
windows, and windows that are no longer hidden.

Platform behavior belongs behind `WindowSystem`:

- Linux uses X11 window discovery/activation and the runtime-directory state
  file.
- macOS uses Accessibility identities and restores only the window represented
  by the top valid record.

Do not move platform-specific window identity or activation rules into shared
restore logic.

## Validate changes

When validation is requested, run the scoped plugin suite:

```bash
cargo test -p window-actions
```

For continuous movement changes, verify at least:

- direction changes on both axes without acceleration lag;
- release stops immediately;
- opposite directions obey most-recent intent;
- diagonal speed matches axial speed;
- reversing away from every constrained monitor edge starts immediately;
- watchdog cleanup stops motion after host loss.

Use the qol-tray Recompile action or its documented dev endpoint to load the
new binary. Follow `qol-tray-dev-recompile`; do not infer freshness from a
successful Cargo build alone.

## Platform limits

The Cinnamon glide backend is X11-specific. Keep Wayland work behind a separate
compositor capability boundary. Continuous glide on a platform must return a
clear unsupported error until that platform has a real controller; do not add
a partial fallback that can leave motion active.
