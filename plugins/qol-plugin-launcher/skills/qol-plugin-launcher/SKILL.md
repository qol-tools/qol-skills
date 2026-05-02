---
name: qol-plugin-launcher
description: Use when working on the qol-tray launcher plugin, including GPUI launcher behavior and architecture.
---

## Current State

GPUI launcher is the production launcher. Runs as a long-lived daemon under qol-tray (`daemon.enabled = true`) so cold-start GPU init is amortized. Supports Linux and macOS. Binary name: `launcher`.

## Capabilities

- App search: `.desktop` entries (Linux), `.app` bundles (macOS)
- File search with depth-limited indexing and a cached on-disk index
- Fuzzy matching with adjustable fuzziness (strict/balanced/loose)
- Two search modes: Apps and Files (Tab to switch)
- Arrow key navigation, Enter to launch, Escape to dismiss
- Borderless popup window with dynamic height
- Multi-monitor: opens centered on the focused window's monitor
- Blur detection: dismisses on focus loss
- Daemon mode with instant show via Unix socket (`/tmp/qol-launcher.sock`)
- Clipboard support (Ctrl+C/X/V, Ctrl+A) in the query input
- Action modifiers (Ctrl/Shift/Alt + Enter) for alternate launch behaviour

## Plugin Contract

`plugin.toml`:

- `runtime.command = "launcher"`
- `runtime.actions = { open = ["--show"] }`
- `[daemon] enabled = true`, `command = "launcher"`, `socket = "/tmp/qol-launcher.sock"`
- Menu: `Open Launcher` (action `run`)
- Platforms: `linux`, `macos`
- Binary download repo: `qol-tools/plugin-launcher`, pattern `launcher-{os}-{arch}`

## File Layout

```
src/
  main.rs              # binary entry: argv parsing, --show/--kill dispatch, daemon spawn
  lib.rs               # crate root and public re-exports
  daemon.rs            # Unix socket IPC (show/kill/ping) via qol_plugin_api::daemon
  discovery/           # app + file discovery and caching
    mod.rs
    search.rs          # query scoring + ranking
    file_scan.rs       # file walker
    file_cache.rs      # cached on-disk index
    entry_store.rs     # in-memory entry store shared with the UI
    platform/
      mod.rs
      linux.rs         # XDG application dir scan, .desktop parser
      macos.rs         # .app bundle scan
      windows.rs       # stub
  launch/              # how to actually execute an entry per OS
    mod.rs
    linux.rs           # setsid -f <cmd>
    macos.rs           # open_path_detached(&path)
    windows.rs         # stub
  ui/                  # GPUI front-end
    mod.rs
    run.rs             # top-level GPUI app bootstrap
    view.rs            # root view
    render.rs          # list / cell rendering
    layout.rs          # window size + row layout math
    controller.rs      # user-input → state transitions
    input.rs           # key + clipboard handling
    state.rs           # UI state (query, selection, mode)
    windows.rs         # window creation + reuse helpers
    window_ops.rs      # show/hide/move ops
    keepalive.rs       # hidden PopUp to keep GPUI alive when picker is dismissed
    platform/
      mod.rs
      linux.rs         # X11 focus/monitor tracking via x11rb
      macos.rs         # macOS-specific window behaviour
      windows.rs       # stub
tests/                 # property tests (see below)
examples/              # small example binaries
```

## Platform-Specific Notes

**macOS:**
- Apps: scans `/Applications`, `~/Applications`, `/System/Applications` (depth 1)
- Launch: passes `Path` directly to `Command::new("open").arg(path)` via `launch::macos::open_path_detached` — no shell string splitting (avoids `.app` bundle path crashes)
- Window dismiss: `window.remove_window()` — `cx.hide()` hides entire NSApplication and crashes subsequent show

**Linux:**
- Apps: scans XDG application dirs for `.desktop` files
- Files: uses cached TSV-style index for fast startup
- Launch: `setsid -f <cmd>` with fallback
- Monitor tracking: X11 input polling via `x11rb`

## Property Tests

Logic validation with auto-generated cases. Split across `tests/` by domain:

- Filter: matches contain query, subset of items, case insensitive, preserves order, no false negatives
- Navigation: selection bounds, reversibility, cannot exceed max, zero items, filtered bounds
- Window height: grows with items, caps at max, minimum is header, non-decreasing
- Icons: path validation, extension checks, case insensitive extensions, size bounds, path traversal blocked, null byte blocked, empty path, dimension clamping, row fitting, list item resolution
- Sections: header skipping, bounds checking, reversibility through headers
- Async: results subset of indexed, monotonic progress
- Frecency decay: non-negative, zero count, zero elapsed, halving at half-life, monotonic, linear in count, longer half-life slower, clock skew safety
- Path quality: non-negative, standard dirs lower, depth penalty, hidden penalty, hidden disabled, .local exemption, autostart/xdg penalty
- Ranking: exact > prefix > contains, desktop > folder, shorter wins, frequency overcomes match gap, case insensitive, unknown path no bonus
- Fuzzy: subsequence valid, superset of substring, empty query, case insensitive, no match missing char, contiguous > scattered, prefix > interior, boundary > non-boundary
- Action modifiers: ctrl priority, shift priority, alt priority, no modifiers default, hint matches action

### Bugs Found by Property Tests

- `effective_count` u64 underflow when `now < last_accessed` (clock skew) — fixed with `saturating_sub`
- Fuzzy prop tests: pad characters must not overlap query alphabet (used `'0'` for `[a-z]` queries) or constructed candidates become identical

## GPUI Gotchas

- gpui reports a single merged display on Linux multi-monitor (e.g., 4480x1440) — must use xrandr for real geometry
- Blur detection fires immediately on PopUp windows — needs a delay guard before subscribing

```rust
// Borderless popup
WindowOptions {
    titlebar: None,
    window_decorations: Some(WindowDecorations::Client),
    kind: WindowKind::PopUp,
    ..Default::default()
}
```

## Running

```bash
# Launcher binary
cargo run --bin launcher

# Contract validation
cargo test
```

## Contract Validation Test

The launcher must include a contract validation test to statically validate `plugin.toml` at `cargo test` time:

```rust
#[cfg(test)]
mod tests {
    use qol_tray::plugins::manifest::PluginManifest;

    #[test]
    fn validate_plugin_contract() {
        let manifest_str =
            std::fs::read_to_string("plugin.toml").expect("Failed to read plugin.toml");
        let manifest: PluginManifest =
            toml::from_str(&manifest_str).expect("Failed to parse plugin.toml");
        manifest.validate().expect("Manifest validation failed");
    }
}
```

Required `Cargo.toml` dev-dependencies:

```toml
[dev-dependencies]
qol-tray = { path = "../../qol-tray" }
toml = "0.9"
```

## Build and Dev Workflow

- No Makefile. qol-tray uses `cargo build` directly in dev mode.
- Do **not** leave a `launcher` binary in the plugin root — it will shadow `target/debug/launcher`.
- `qol-tray` resolves binaries in order: plugin root → `target/debug/` → `target/release/`.
- Run `cargo test` to validate the contract before linking or shipping.

## Activation Path (qol-tray → daemon)

End-to-end on a hotkey press:

1. qol-tray's `HotkeyListenerLoop` (`src/hotkeys/listener.rs`, polls `GlobalHotKeyEvent::receiver()` every 10ms) wakes.
2. Looks up `(plugin_id, action)` from the in-memory binding map populated by `HotkeyManager::register_hotkeys`.
3. Calls `crate::plugins::action_executor::execute_action(plugin_manager, "plugin-launcher", "open")`.
4. `action_executor::resolve_plugin_daemon_socket` resolves to `/tmp/qol-launcher.sock` from the manifest.
5. `action_transport::dispatch_daemon_action` writes the action name over the socket.
6. Launcher's `daemon::parse_command` matches `"show" | "open"` → emits `Command::Show` to its UI thread → `window_ops` reuses the keepalive popup window and shows it.

Implication: the action_executor / socket / GPUI half are independent of how the keystroke was captured. Any new capture mechanism just needs to invoke `execute_action(..., "plugin-launcher", "open")`.

Direct socket smoke-test (no qol-tray involvement):

```bash
echo '{"action":"open","args":["--show"]}' | nc -U /tmp/qol-launcher.sock
# → {"status":"handled"}
```

## Hotkey Capture Limitation (X11)

qol-tray uses the `global_hotkey = "0.7"` crate, which calls `XGrabKey` on Linux. X11 passive grabs are first-come-first-served — when two clients grab the same combo on root (e.g. `csd-keyboard`'s `<Super>space` for `switch-input-source`), the X server delivers events to whichever client grabbed first. There is no preempt or priority.

Symptoms when this bites:
- `/api/hotkeys/errors` returns `[]` (registration succeeded — `XGrabKey` returned Ok).
- Other hotkeys (e.g. Alt+Tab, owned by Muffin WM via a different mechanism) fire normally.
- Pressing the conflicting combo silently triggers the WM's binding instead of qol-tray.

Diagnostic checklist:
- `gsettings get org.cinnamon.desktop.keybindings.wm <name>` and `org.gnome.*` equivalents
- `gsettings get org.freedesktop.ibus.general.hotkey triggers`
- `kreadconfig5 --file kglobalshortcutsrc` (KDE)
- Compare `ps -o lstart= -p` for `csd-keyboard` / `gsd-media-keys` / `ibus-daemon` / `kglobalaccel` against qol-tray's start time. If a known shortcut daemon outranks qol-tray and its config has the same combo, qol-tray lost the race silently.

Why this surfaces in dev: `make dev` kills the autostarted qol-tray (which originally grabbed at session start, alongside csd-keyboard) and starts a new instance hours later. By then csd-keyboard has been camping on the combo uncontested, so the dev tray loses the next grab race. The doctor's `autostart_target` warning points at this: dev sessions don't benefit from the boot-time co-grab.

### Fix Direction: evdev + uinput Capture

Architectural fix — replace `XGrabKey` on Linux with a kernel-level capture so no other X11 client can interfere:

1. `evdev::raw_stream::enumerate()` to walk `/dev/input/event*`; keep devices advertising `EV_KEY` with codes ≥ `KEY_ESC` (kanata's keyboard heuristic).
2. `Device::grab()` (EVIOCGRAB) each chosen device exclusively.
3. One `uinput::VirtualDevice` exposing the union of grabbed devices' KEY caps.
4. Per-device read thread + tiny modifier-state machine. On match → fire `action_executor::execute_action(...)` (same callsite as today, no downstream changes). On non-match → `VirtualDevice::emit(&[event])`.
5. `inotify` on `/dev/input/` for hotplug.
6. SIGTERM + panic hook MUST `ungrab()` every device, otherwise the keyboard is bricked until fd close. Test with deliberate SEGV in dev.

Install footprint (matches kanata, keyd):
```
/etc/udev/rules.d/99-qol-input.rules:
KERNEL=="uinput", MODE="0660", GROUP="input", OPTIONS+="static_node=uinput"
```
Plus user in `input` group; `uinput` kernel module loaded.

Reference impls: kanata, keyd, xremap, interception-tools — all use this exact pattern because it's the only Linux mechanism with deterministic capture semantics. Bonus: works identically on X11 and Wayland, so no Wayland rewrite later.

Sharp edges:
- Multi-keyboard laptops expose 2–3 keyboard-class devices (built-in, dock, headset mic buttons reporting `KEY_*`). Default to grab-all with explicit exclude list.
- Modifier-only / tap-vs-hold bindings are out of scope for V1 — they need a state machine.
- In-process thread inside qol-tray is the right starting point. Sidecar (`qol-input-router`) only buys robustness against `kill -9`; defer it.

Keep `global_hotkey` available as a fallback compile path for users who can't install the udev rule.

## Plugin Staleness & Dev-Link Diagnostics

When the launcher daemon "doesn't work" but the daemon socket responds to direct `nc -U` calls, the issue is upstream of the daemon. Common chain:

1. Check `~/.config/qol-tray/plugin-registry.json` — is the slot `release-asset` (stale installed binary) or `dev-link` (live source)? Compare `plugin-launcher` and `plugin-lights` for the two shapes.
2. If `release-asset`: the binary at `~/.config/qol-tray/plugins/plugin-launcher/launcher` may be weeks behind upstream. `make dev` rebuilds qol-tray only — never plugin daemons.
3. Convert to dev-link: `POST http://127.0.0.1:42700/api/dev/links` with `{"path": "/path/to/plugin-launcher"}` (Origin header required for CSRF). On success, qol-tray respawns from `<source>/target/debug/launcher` and the build planner detects fingerprint mismatch (`needs_rebuild: true, rebuild_reason: "Source changed"`) on next reload.
4. Trigger build + respawn: `POST /api/dev/reload/plugin-launcher`. Build progress visible at `GET /api/dev/build-state`. Note: building gpui from cold can OOM at ~98% on memory-constrained machines.

Doctor warnings worth wiring (currently absent):
- `release-asset` slot has a sibling source repo at `../<plugin-id>` next to qol-tray → "source exists but is not dev-linked".
- `dev-link` slot's `needs_rebuild` is true → "rebuild required: <reason>".
- Same hotkey combo present in DE shortcut daemon AND that daemon outranks qol-tray in uptime → "hotkey shadowed by <daemon>".
