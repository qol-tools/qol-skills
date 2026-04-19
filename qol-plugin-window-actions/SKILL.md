---
name: qol-plugin-window-actions
description: Use when working on the qol-tray window actions plugin for window minimization, restore, and monitor movement.
---

Window management plugin for qol-tray (Linux and macOS). Binary-first runtime plugin.

## Contract

- Runtime command: `window-actions`
- Actions are manifest-mapped in `plugin.toml`:
  - `snap-left`
  - `snap-right`
  - `snap-bottom`
  - `maximize`
  - `minimize`
  - `restore`
  - `center`
  - `move-monitor-left`
  - `move-monitor-right`
- No shell entrypoint fallback. Keep all execution logic in Rust binary actions.
- Platforms: `linux`, `macos`

## Contract Validation Test

Every plugin must include this test in `src/main.rs` to statically validate `plugin.toml` at `cargo test` time:

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
- Do **not** leave a `window-actions` binary in the plugin root directory — it will shadow `target/debug/window-actions`.
- `qol-tray` resolves binaries in order: plugin root → `target/debug/` → `target/release/`.
- Run `cargo test` to validate the contract before linking or shipping.

## Architecture

| File / Dir | Purpose |
|------------|---------|
| `src/main.rs` | Entry point, parses action arg, dispatches to `platform::execute_action()` |
| `src/config.rs` | Config struct + `load_config()` via `qol_config::load_plugin_config()` |
| `src/restore.rs` | `WindowSystem` trait, `MinimizedStateStore` trait (stack-based), minimize/restore logic |
| `src/state_store.rs` | `FileMinimizedStateStore`: pipe-delimited text file, one record per line (push/peek/pop) |
| `src/platform/mod.rs` | Platform dispatcher: routes actions to geometry or minimize/restore |
| `src/platform/macos/mod.rs` | `MacWindowSystem` impl: PID-based window identity |
| `src/platform/macos/ax.rs` | Accessibility API: minimize, restore, window rect, position/size |
| `src/platform/macos/objc.rs` | Low-level Objective-C FFI bindings (AXUIElement, CGWindow, NSRunningApplication) |
| `src/platform/macos/geometry.rs` | Window snap/maximize/center via AX position+size |
| `src/platform/macos/screen.rs` | Screen geometry types and monitor enumeration |
| `src/platform/system.rs` | Linux `X11WindowSystem` impl (xdotool, wmctrl, xprop) |
| `src/platform/scripts.rs` | Cinnamon JS eval scripts for Linux snap/maximize |
| `src/platform/monitor_move.rs` | Linux monitor movement via xdotool + xrandr |

## Minimize / Restore (macOS)

**Minimize** (`instant_minimize`): strategy depends on visible window count:
- **Single visible window**: `AXHidden=true` on the app — instant, no animation.
- **Multiple visible windows**: `AXMinimized=true` on the focused window only — animated, but only affects that window. Other windows stay in place.

**Restore** (`unminimize_and_raise`): matches the minimize strategy:
- **App was `AXHidden`**: Unhides app + activates all windows (they were hidden together).
- **Individual `AXMinimized`**: Unminimizes only the first minimized window, raises it, nudges position (+1px back) to force WindowServer input re-registration. Activates app without `AllWindows` flag so other windows stay where they are.

**State store** is a stack (LIFO): minimize pushes, restore pops. Multiple windows can be minimized in sequence and restored in reverse order. State file: `$TMPDIR/qol-window-actions-last-minimized` (macOS) or `$XDG_RUNTIME_DIR/...` (Linux). Records expire after 8 hours.

## Config

Loaded via `qol_config::load_plugin_config()`. Fields:
- `center_mode`: `"pixels"` or `"percent"`
- `center_width_px`, `center_height_px`: pixel dimensions for center action
- `center_width_percent`, `center_height_percent`: percentage-based center sizing
- `snap_fraction`: snap window width fraction (default 0.5)
- `reveal_taskbar_after_move`: reveal Linux taskbar after monitor move (boolean)

## Known Issues / TODO

1. **Linux uses external tools** — xdotool, wmctrl, xprop, xrandr for window operations. macOS uses native Accessibility APIs.
2. **Wayland support** — Linux implementation is X11-only. Wayland alternatives would need `wlr-foreign-toplevel-management` or compositor-specific D-Bus APIs.
