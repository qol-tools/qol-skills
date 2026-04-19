---
name: qol-plugin-alt-tab
description: Use when working on the qol-tray alt-tab plugin, including GPUI window list, X11 preview capture, config loading, and settings UI.
---

Better Alt+Tab experience for qol-tray (Linux and macOS). Shows a GPUI window list with live previews. Replaces the native OS Alt+Tab switcher by grabbing the key via qol-tray's hotkey system.

## Contract

- Runtime command: `alt-tab`
- Runtime actions map:
  - `open -> ["--show"]`
  - `settings -> ["--settings"]`
- Daemon: **enabled**. Socket: `/tmp/qol-alt-tab.sock`. Command: `alt-tab` (no args → starts daemon).
- Menu: `Open Alt Tab` (action `run`), separator, `Settings` (action `settings`).
- Platforms: `linux`, `macos`

## Contract Validation Test

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
- Do **not** leave an `alt-tab` binary in the plugin root — it will shadow `target/debug/alt-tab`.
- `qol-tray` resolves binaries in order: plugin root → `target/debug/` → `target/release/`.
- Run `cargo test` to validate the contract before linking.

## Architecture

| File / Dir | Purpose |
|------------|---------|
| `src/main.rs` | Entry point: loads config, dispatches `--show`/`--show-reverse`/`--kill` to daemon or starts daemon via `picker::run::run_app()` |
| `src/daemon.rs` | Unix socket daemon (show/kill/ping) via `qol_plugin_api::daemon` |
| `src/config.rs` | TOML config loading via `qol_config::load_plugin_config()` |
| `src/picker/run.rs` | Daemon event loop, cache management, `dispatch_show()` |
| `src/picker/mod.rs` | Picker orchestration: `open_picker()` with cycle/reuse/create paths |
| `src/picker/create.rs` | Window creation, `pre_create_offscreen()` for instant open |
| `src/picker/reuse.rs` | Window reuse across opens (resize, reposition) |
| `src/picker/gather.rs` | Window gathering from cache or live discovery |
| `src/app/mod.rs` | `AltTabApp` GPUI component, focus handling, alt-key polling |
| `src/app/render.rs` | UI rendering: grid layout, transparency, card styling |
| `src/discovery/platform/macos/` | macOS window enumeration via CoreGraphics (z-order = MRU) |
| `src/discovery/platform/linux.rs` | Linux window enumeration via x11rb `_NET_CLIENT_LIST_STACKING` |
| `src/capture/platform/macos.rs` | macOS preview capture via `CGWindowListCreateImage` |
| `src/capture/platform/linux.rs` | Linux preview capture via x11rb Composite `GetImage` |
| `src/actions/platform/` | Window actions (activate, close, quit, minimize) per platform |
| `ui/` | Settings HTML/JS/CSS served by qol-tray |

## Daemon Architecture

The plugin runs as a long-lived daemon because GPUI's GPU initialization is slow on cold start. The picker window is pre-created offscreen at boot for instant open.

**Startup flow:**
1. qol-tray starts the daemon at boot (because `daemon.enabled = true`)
2. Daemon binds `/tmp/qol-alt-tab.sock`, initializes GPUI, pre-creates picker window offscreen
3. Each subsequent `--show` invocation writes `"show"` to the socket (<5ms)
4. Daemon refreshes window cache (fresh MRU from OS), reloads config, reuses existing picker window with new data

**Key invariants:**
- Picker window is pre-created at boot and reused across opens (not destroyed/recreated)
- A hidden `KeepAlive` PopUp window via `qol_plugin_api::keepalive` prevents GPUI from quitting when picker is dismissed
- Window cache is refreshed synchronously on each show (`refresh_cache_for_show`) so MRU order is always current
- Config is reloaded on each show so settings changes take effect without restart
- Transparency changes are applied via `window.set_background_appearance()` + `disable_window_shadow()` on reuse

## Config System

Config is loaded via `qol_config::load_plugin_config(["plugin-alt-tab", "alt-tab"])` from `qol-config.toml`.

Key fields:
- `display.max_columns` — max grid columns
- `display.transparent_background` — transparent window background (requires shadow disable on macOS)
- `display.card_background_color` / `card_background_opacity` — card styling
- `display.show_minimized` — include minimized windows in list
- `display.show_hotkey_hints` — header bar with keybindings
- `display.show_debug_overlay` — debug header
- `action_mode` — `hold_to_switch` (release Alt to confirm) or `sticky` (press Enter)
- `reset_selection_on_open` — reset selection to index 0 each open
- `open_behavior` — `cycle_once` or `show_list`
- `label.*` — label font size, show app name, show window title

## Known Issues / TODO

1. **Preview accuracy (Linux)**: X11 `GetImage` captures the off-screen buffer; minimised or occluded windows may return stale/blank pixels.

2. **Wayland**: Linux support uses x11rb only. Wayland support is not implemented.

## Settings UI (`ui/`)

The settings page is served by qol-tray at `/plugins/plugin-alt-tab/`. It reads and writes config via:

- `GET /api/plugins/plugin-alt-tab/config` — load current config
- `PUT /api/plugins/plugin-alt-tab/config` — save updated config (body: JSON)

The `--settings` runtime action opens this URL in the default browser.
