---
name: qol-plugin-alt-tab
description: Use when working on the qol-tray alt-tab plugin, including its retained GPUI picker, OS window discovery, preview capture, window actions, daemon lifecycle, config, and shared settings surface.
---

# qol-plugin-alt-tab

Alt Tab replaces the host switcher with a retained GPUI picker. Exact actions, daemon metadata, platform availability, and artifact names come from `plugin.toml`; settings fields come from `qol-config.toml`.

## Contract ownership

- `plugin.toml` owns public action IDs, command arguments, daemon endpoints, menu entries, capabilities, platforms, and release artifacts.
- `qol-config.toml` owns renderer-neutral settings and defaults.
- `Cargo.toml` owns platform dependencies and the package binary name.
- Contract validation is executable through the plugin tests and `qol check`.

Change a public action across the manifest, host binding, daemon parser, and tests together. Never copy the action/platform inventory into this skill.

## Source ownership

| Path | Responsibility |
|---|---|
| `src/main.rs` | Thin module wiring and process entrypoint. |
| `src/runtime/` | Argument routing, daemon action transport/startup, and settings fallback. |
| `src/config/` | Typed settings consumed by the picker. |
| `src/picker/` | Show dispatch, retained-window creation/reuse, cache types, layout, state, gathering, and monitor updates. |
| `src/app/` | GPUI view state, input, live-preview coordination, and element rendering. |
| `src/discovery/` | Platform-neutral window metadata plus target-selected enumeration. |
| `src/capture/` | Preview capture capability and target-selected capture implementations. |
| `src/preview_plane/` | Platform-specific live preview plane behavior when used. |
| `src/actions/` | Activate, close, quit, minimize, and other host-window operations behind target adapters. |
| `src/rendering/` | Preview-renderer selection, image conversion, GPU image lifetime, and debug traces. |

Keep target cfg wiring inside feature-owned `platform/mod.rs` files. Picker/app code must call feature boundaries without direct OS selection.

## Directory invariants

- Keep `src/` limited to `main.rs` plus owned module directories; never put config, daemon, aliases, or feature helpers back at the root.
- Never create a generic `shared/` directory. Put layout/state/cache logic beneath `picker/`, live-preview scheduling beneath `app/live_preview/`, and image ownership beneath `rendering/`.
- Keep `PickerState` in `picker/state.rs`; do not hide large named modules inline inside `picker/mod.rs`.
- Never combine `foo.rs` with `foo/`. In particular, monitor listeners and live previews use directory modules because they own child modules.
- Within each feature-owned `platform/`, use one OS module form consistently and keep target selection in its `mod.rs`.
- Keep browser settings assets in top-level `ui/`, outside Rust `src/`.

## Retained picker invariants

- GPUI initializes in the long-lived daemon; show actions reuse a retained picker rather than paying cold GPU startup.
- A keepalive surface may retain the application, but it must never appear in Alt-Tab or as an empty desktop window.
- Every show refreshes OS window metadata and reloads config before selection/render decisions.
- Dismissal hides/removes the picker without terminating the daemon.
- Reuse reapplies size, monitor placement, transparency, shadow, focus, and first-frame reveal requirements.
- Image ownership drains through `rendering::image_registry` on view release; never drop the same GPUI image ID twice.

Follow `qol-project:qol-plugin-gpui-surfaces` and `qol-langs:gpui-conventions` for hosted settings and compositor-safe retained-window reveal.

## Non-negotiables

1. **Live query per show. No polling, no long-lived MRU cache.** Visible windows
   are queried fresh on every open so z-order matches what the OS thinks is
   frontmost. Any observer/store/stacking-watcher that "keeps state warm" leaks
   stale windows and misses focus changes.
2. **Strategy pattern, zero `#[cfg(target_os)]` in business logic.** Platform
   differences live behind a trait in per-OS modules; cfg gates exist only in the
   re-export layer. An unsupported OS returns a typed `Err`, never
   `compile_error!` or `unimplemented!()`.
3. **AX calls can stall.** Always keep a messaging timeout, parallel AX prefetch
   so one slow PID caps `max` not `sum`, and a short-TTL slow-PID-aware cache so
   repeated opens skip known-slow PIDs.
4. **The show path never captures; previews are warmed in the background.**
   Opening is a pure, instant reveal of the cached previews. Never trigger a
   screenshot on show and never block the show on capture: a macOS window
   screenshot is ~30-90ms and WindowServer-serialized, so capturing-on-open *is*
   the lag. Keep previews current by usage instead of by opening. A hidden,
   idle-gated warmer re-shoots only the active window (idx 0) on a ~250ms timer
   while the picker is hidden and there has been recent HID input; every other
   window is captured the instant focus leaves it (`FocusChanged` -> capture the
   just-defocused window). A window's content only changes while it is frontmost,
   so its last-focused capture stays accurate until it is refocused, which is why
   re-shooting backgrounded windows is wasted work. The cache is the source of
   truth at show time. The warmer and the focus-leave fill use separate in-flight
   guards so neither blocks the other. The icon cache is per-app and long-lived.
5. **Daemon-backed picker.** Cold GPUI startup is too slow for Alt+Tab, so the
   daemon stays resident: the picker window is created once and reused across
   opens, never destroyed between opens on macOS. A hidden keepalive PopUp stops
   GPUI from quitting when the picker is dismissed.
6. **Config and window cache reload per show**, so settings and MRU are current
   without a restart.
7. **Debug logs under `#[cfg(debug_assertions)]`, prefixed `[alt-tab/...]`** so
   qol-tray's filters work. Never leak into release.
8. **Data-driven dispatch over N-way switches.** Rule kinds, action handlers, and
   platform bindings go through `{ key, handler }` tables.
9. **Every `Arc<RenderImage>` cache routes through the registry.** Inserts via
   `REGISTRY.retain`, removals via `REGISTRY.release`, so `App::drop_image` fires
   exactly once per `ImageId`. `MetalAtlas::remove` double-decrements on a double
   remove; a view that owns images must drain them in `Context::on_release`.
10. **Focus-out is passive; it NEVER activates the selection.** Activation is
    owned solely by explicit user intent (Enter, card click, alt-release via
    `on_modifiers_changed` or the alt-poll fallback). Routing activation through
    focus-out lets a click-outside hijack the selected window.
11. **Foregrounding the picked window is authoritative, not
    `NSRunningApplication.activate`** (inert on macOS 14+: returns true, does
    nothing). `_SLPSSetFrontProcessWithOptions` alone is silently ignored when an
    actively-front app holds front, so foreground via the target app's
    `kAXFrontmost` attribute plus the SkyLight `set_front` path, then re-assert
    both on a short generation-guarded loop until the target is frontmost. The
    picker teardown deactivates the daemon and the WindowServer restores the prior
    app, so a one-shot activation loses a timing race; the re-assert wins it. See
    `qol-langs:macos-window-activation`.

## Ghost popup: active monitor is qol-runtime's single source of truth

The picker stays alive between invocations drawn at `alpha=0` +
`ignoresMouseEvents`, and recenters as the user moves between monitors so the next
show is a pure alpha toggle on the correct monitor.

- Show and ghost paths both resolve placement through
  `PopupPlacement::from_tracker(tracker)` at use time. The plugin holds zero
  monitor state: never cache a `LastActiveMonitor`, never decode event payloads
  for routing, never re-implement crossing/reclaim logic. Runtime owns that
  decision. If the picker lands on the wrong monitor, the fix is in qol-runtime,
  not here.
- Do NOT use `from_tracker_focus_first` for this picker. It forces focus to win
  over more-recent cursor activity, breaking "follow the user". Focus-first is
  only for popups that must strictly track the focused window.
- `FocusChanged` / `CursorMoved` / `MonitorsChanged` are recompute triggers, not
  carriers of the active-monitor decision. Ghost recenter runs the same placement
  computation the show path uses; pixel-exact match is the contract.
- macOS y-flip uses the first entry of `NSScreen::screens(mtm)` (the
  menu-bar/anchor screen, fixed for the session). NEVER `NSScreen::mainScreen()`:
  it follows the focused window and drifts on multi-monitor.
- gpui `window_bounds()` is screen-local, not global gpui coords; reconcile
  against `NSWindow::frame()` if in doubt.
- Always-on-top via `NSPopUpMenuWindowLevel`, set once at boot.

The shared per-monitor ghost mechanism and the reason cross-monitor moves are
banned live in `qol-langs:gpui-conventions`, "Ghost popup architecture".

## Build and dev

- No Makefile-as-build-system; use `cargo` directly.
- Never leave an `alt-tab` binary in the plugin root: it shadows `target/debug/`.
  qol-tray resolves binaries plugin-root, then `target/debug/`, then
  `target/release/`.
- A resident daemon keeps serving the old binary until restarted. After a rebuild,
  restart the daemon (qol-tray Recompile, or kill + relaunch) or your change is
  invisible. Type-check passing does not mean the feature works.

## Systematic debugging

Recurring failure mode: stale state persists across opens because a cache was
designed optimistically. For any "works first time, then gets weird" report, audit
each cache for the correct lifetime: preview (background-warmed, pruned to the
live window set per show), icon (per-app), MRU/window-order (per-query), AX
results (short TTL, slow-PID aware), and the daemon binary itself (rebuilt vs
running).

## Testing

1. Property tests for ordering invariants (window-order merge, MRU stabilization),
   parsing, and path-safety.
2. Parameterized tables for exact-output contracts (window enumeration to
   `WindowInfo`, AX filter decisions).
3. No smoke tests: `assert!(x.is_ok())` must fail on a plausible regression or it
   stays out.
4. Every bug starts with a failing test.

## Discovery and capture

Discovery returns stable window identity and ordering; capture returns preview content for that identity. Do not merge them merely because a platform API supplies both.

Platform availability is real only when discovery, activation, preview capture or an explicit fallback, retained reveal, and runtime tests all work on that target. A compiling stub is not support.

For blank or stale previews, determine whether the limitation is the compositor/windowing substrate, the chosen capture API, image-lifetime handling, or stale discovery identity. Record evidence from the actual adapter; do not add a timeless “known issues” list.

## Settings ownership

The settings action is hosted by qol-tray when the manifest/config capability contract selects native GPUI settings. The daemon may keep a shared-panel or browser fallback, but it must not create a second bespoke settings implementation. Every renderer reads and writes through the same config API.

## Common changes

**Add a window action:** extend the platform-neutral action boundary and implement every target adapter, returning typed errors for unsupported behavior.

**Change preview behavior:** update capture, rendering representation, image lifetime, and reuse tests together. Verify cold and retained paths.

**Change selection/input:** keep modifier release, explicit confirmation, blur dismissal, and fast-tap fallback within one state machine. Add transition tests before GPUI event glue.

**Change contract/config:** edit owning TOML and typed consumers together, then run contract validation.

## Verification

Run format, build, Clippy with warnings denied, plugin tests, and `cargo run -q -p qol -- check`. Compile every manifest-declared target. Visual/reveal claims require compositor-backed tests, not the developer desktop.
