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
