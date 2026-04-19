---
name: qol-plugin-launcher
description: Use when working on the qol-tray launcher plugin, including GPUI launcher behavior and architecture.
---

## Current State

GPUI launcher is the production launcher. Supports Linux and macOS.

## GPUI Launcher (Active)

Located in `gpui-prototype/gpui-test/`. Running binary: `cargo run --bin launcher`.

### What Works

- App search: `.desktop` entries (Linux), `.app` bundles (macOS)
- File search with depth-limited indexing
- Fuzzy matching with adjustable fuzziness (strict/balanced/loose)
- Two search modes: Apps and Files (Tab to switch)
- Arrow key navigation, Enter to launch, Escape to dismiss
- Borderless popup window with dynamic height
- Multi-monitor: opens centered on the focused window's monitor
- Blur detection: dismisses on focus loss
- Daemon mode with instant show via Unix socket
- Clipboard support (Ctrl+C/X/V, Ctrl+A)

### Architecture

| Module | Purpose |
|--------|---------|
| `src/bin/launcher.rs` | Binary entrypoint |
| `src/lib.rs` | Crate root |
| `src/daemon.rs` | Unix socket IPC (show/kill commands) |
| `src/desktop_entry.rs` | .desktop file parser (Linux) |
| `src/monitor.rs` | Multi-monitor focus tracking (Linux/X11) |
| `src/providers/apps/mod.rs` | AppsProvider trait + OS dispatch |
| `src/providers/apps/linux.rs` | .desktop entry scanner |
| `src/providers/apps/macos.rs` | .app bundle scanner |
| `src/providers/apps/fallback.rs` | Empty provider (other platforms) |
| `src/providers/files/` | FilesProvider trait + OS-specific indexing |
| `src/launcher_app/` | Controller, render, search, state, actions, window ops |

### Platform-Specific Notes

**macOS:**
- Apps: scans `/Applications`, `~/Applications`, `/System/Applications` (depth 1)
- Launch: uses `open_path_detached(&entry.path)` — passes path directly, no shell string splitting
- Window dismiss: `window.remove_window()` — `cx.hide()` crashes (hides entire NSApplication)

**Linux:**
- Apps: scans XDG application dirs for `.desktop` files
- Files: uses cached TSV index for fast startup
- Launch: `setsid -f <cmd>` with fallback
- Monitor tracking: X11 input polling via `x11rb`

## Verified UI Patterns (bin tests 01-16)

| Bin | Feature | Status |
|-----|---------|--------|
| 01 | Minimal window (42px) | ✓ |
| 02 | Borderless popup | ✓ |
| 03 | Dynamic resize | ✓ |
| 04 | Text input | ✓ |
| 05 | List selection + keyboard nav | ✓ |
| 06 | Blur detection (close on focus loss) | ✓ |
| 07 | Hide/show window | ✓ |
| 08 | Scrollable list | ✓ |
| 09 | Filtered list (core launcher) | ✓ |
| 10 | Icons | ✓ |
| 11 | Section headers | ✓ |
| 12 | Async loading | ✓ |
| 13 | Frecency ranking | ✓ |
| 14 | Fuzzy matching | ✓ |
| 15 | Action modifiers | ✓ |
| 16 | Multi-monitor | ✓ |

## Property Tests (67 tests)

Logic validation with 200 auto-generated cases each:
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

- `effective_count` u64 underflow when `now < last_accessed` (clock skew) - fixed with `saturating_sub`
- Fuzzy prop tests: pad characters must not overlap query alphabet (used `'0'` for `[a-z]` queries) or constructed candidates become identical

### Key Discoveries

- gpui reports single merged display on Linux multi-monitor (e.g., 4480x1440) - must use xrandr for real geometry
- Blur detection fires immediately on PopUp windows - needs delay guard before subscribing

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
# Launcher
cargo run --bin launcher

# Contract validation
cargo test
```


## Existing webkit2gtk Implementation

### Code Locations

- `src/main.rs` - Main daemon and window logic
- `webview/app.js` - Frontend logic
- `webview/style.css` - Styling
- `launcher` binary - Runtime and daemon entrypoint via plugin manifest contract

### What Works

- Daemon mode with instant show via Unix socket
- Binary-first runtime/daemon contract (`runtime.command = daemon.command = "launcher"`)
- Search and results display
- Modifier key actions (Ctrl/Shift/Alt + Enter)
- Window positioning on correct monitor
- State resets on reopen

### Known Issues

1. **Minimum height** - webkit2gtk hardcoded ~275px minimum (reason for gpui migration)
2. **Wayland support** - Uses xdotool, xclip
3. **Terminal detection** - Hardcoded terminal list

### Release Process

`make release` bumps `plugin.toml` (source of truth), syncs version to `Cargo.toml`, commits, tags, and pushes. The tag triggers GitHub Actions which builds binaries for Linux x86_64, macOS aarch64, and macOS x86_64.

## Contract Validation Test

The launcher must include a contract validation test in `src/bin/launcher.rs` to statically validate `plugin.toml` at `cargo test` time:

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

## Documentation

- `GPUI.md` - Knowledge base for gpui patterns
- `tests/` - Property tests split by domain (filter, nav, window, icon, section, async, frecency, path_quality, ranking, fuzzy, action_modifiers)



# Multi-Monitor Support for GPUI Launcher

Port the existing webkit2gtk multi-monitor logic to GPUI.

## Goal

Launcher opens centered on the monitor containing the currently focused window.

## Current Implementation (webkit2gtk)

1. `get_focused_window_position()` calls `xdotool getactivewindow getwindowgeometry --shell`
2. GTK's `display.monitor_at_point(x, y)` finds the monitor
3. `calculate_centered_position()` centers horizontally, 1/3 from top

## GPUI Approach

Use GPUI's display APIs:
- `cx.displays()` - list all displays
- `display.bounds()` - get origin and size
- `display.id()` - get DisplayId
- `Bounds::centered(Some(display_id), size, cx)` - center on specific display

## New Code in `lib.rs`

```rust
#[cfg(target_os = "linux")]
pub fn get_focused_window_position() -> (i32, i32) {
    // Port from webkit2gtk - xdotool getactivewindow getwindowgeometry --shell
    // Parse X= and Y= from output
    // Return (0, 0) on failure
}

pub fn find_display_at_point(x: i32, y: i32, cx: &App) -> Option<DisplayId> {
    for display in cx.displays() {
        let bounds = display.bounds();
        let origin = bounds.origin;
        let size = bounds.size;
        if x >= origin.x.0 as i32
            && x < (origin.x.0 + size.width.0) as i32
            && y >= origin.y.0 as i32
            && y < (origin.y.0 + size.height.0) as i32
        {
            return Some(display.id());
        }
    }
    None
}
```

## Bin Test: `16_multi_monitor.rs`

Interactive test with two components:

### Visual Guide Window
- Small always-visible window
- Shows "Active Monitor: <name>"
- On blur: re-query xdotool, find display, update text
- Escape to quit

### Launcher Test Window
- Press Enter on visual guide to open
- Opens centered on the detected monitor
- Shows position info for verification
- Escape to close and return to visual guide

### Test Flow
1. Run bin → visual guide appears
2. Click window on monitor 2 → guide shows "Active Monitor: 2"
3. Press Enter → launcher window opens on monitor 2
4. Verify placement, Escape to close
5. Click window on monitor 1 → guide shows "Active Monitor: 1"
6. Press Enter → launcher window opens on monitor 1
7. Escape on visual guide to quit

## Dependencies

- xdotool (runtime, already required)
- No new crate dependencies

## Property Tests

Not needed - trivial point-in-rect logic. The xdotool parsing is battle-tested from webkit2gtk version.
