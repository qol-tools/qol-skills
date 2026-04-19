---
name: qol-plugin-os-themes
description: Use when working on the qol-tray OS themes plugin. Covers the shake-to-grow cursor effect, X11 cursor manipulation via xfixes, daemon lifecycle, and the broader (largely unimplemented) GTK/Qt/icon/cursor theming roadmap.
---

# qol-plugin-os-themes

OS-wide theming plugin for qol-tray. Linux-only today. The shipped feature is **shake-to-grow cursor**: detect rapid cursor movement, scale the cursor up, smoothly animate back to normal.

The broader plan (GTK theme switching, Qt, icon themes, cursor themes, Wayland) is incremental and largely unimplemented. Keep that in mind when scoping work.

## Plugin Contract

`plugin.toml`:

- `runtime.command = "plugin-os-themes"`
- `runtime.actions = { run = ["run"], settings = ["settings"] }`
- `[daemon] enabled = true`, `socket = "/tmp/qol-os-themes.sock"`
- Menu: `Cursor Grow` (action `run`) + `Settings`
- Platforms: `linux` only
- Binary download repo: `qol-tools/plugin-os-themes`

`qol-config.toml`:

- `[section.thresholds]`: `velocity_threshold` (default 4500.0), `shakiness_threshold` (75.0), `regrow_velocity_threshold` (1500.0), `regrow_shakiness_threshold` (3.0), `post_trigger_threshold` (1000.0)
- `[section.animation]`: `scale_factor` (4), `calm_duration_ms` (650), `restore_steps` (18), `enable_shape_preserving_growth` (false)

No `qol-runtime.toml` (no named action/query references in the config contract).

## Architecture

| File / Dir | Purpose |
|---|---|
| `src/main.rs` | Entry. Parses single action arg, dispatches to `app::run(action)`. |
| `src/app/` | Action router and daemon orchestration. |
| `src/config.rs` | TOML config loading via `qol_config`. |
| `src/daemon.rs` | Socket daemon helper. |
| `src/cursor/` | Cursor manipulation: `control.rs` is the trait, `platform/` holds the X11 impl using `xfixes` to set/restore cursor images. |
| `src/theme/` | Theme switching seam (placeholder for GTK/Qt/icon work). |
| `ui/index.html` | Auto-config shell. |

Linux deps in `Cargo.toml`: `x11` with `xlib`, `xcursor`, `xfixes` features. `libc` for low-level interaction.

## Shake Detection Tuning

The thresholds above describe a small state machine:

1. **Idle** → cursor is normal size.
2. Velocity exceeds `velocity_threshold` AND direction changes accumulate past `shakiness_threshold` → **Grown**: cursor scales by `scale_factor`.
3. Cursor stays grown until movement stays below `post_trigger_threshold` for `calm_duration_ms`.
4. **Shrink** animates over `restore_steps` frames.
5. **Regrow short-circuit**: if velocity exceeds `regrow_velocity_threshold` and shakiness exceeds `regrow_shakiness_threshold` while still grown, reset the calm timer (don't shrink mid-shake).

`enable_shape_preserving_growth = false` keeps the simpler scaling path. Enabling it preserves the cursor's hotspot/aspect; the implementation cost is more X11 round-trips.

## Common Tasks

**Tune the shake**: adjust the thresholds in `qol-config.toml` defaults. Real users iterate through the qol-tray settings UI.

**Add a new cursor effect**: define a new variant in `cursor/control.rs`, implement it in the X11 platform module, and wire a runtime action. Update `qol-config.toml` if the effect needs settings.

**Start the GTK theme work**: the seam is `src/theme/`. Add a new module with a trait, implement it via gsettings/dconf, and add a runtime action. Update the contract.

**Wayland support**: not started. xfixes is an X11 protocol — Wayland needs compositor-specific protocols (`wp-cursor-shape`) or per-compositor IPC. Treat as a multi-week task.

## Gotchas

- **Linux-only** at the manifest level. The cargo target gates ensure the binary still compiles on macOS/Windows (per the `qol-architecture` strategy pattern), but the manifest declares `platforms = ["linux"]` so qol-tray won't offer it elsewhere.
- **Cursor manipulation requires an X server**. Wayland sessions have no X server unless XWayland is running, and even then xfixes effects only apply to X11 windows. The daemon will start but be a no-op under pure Wayland.
- **`scale_factor`** is an integer in the config but represents a multiplier. Default 4 means 4x. Don't accidentally treat it as a percentage.
- **`calm_duration_ms`** uses a real-time clock via `qol-runtime`'s monitor utilities. It's not tied to frame rate, so changing it doesn't shift the regrow detection window.

## Shared library usage

- `qol-plugin-api` for daemon/socket helpers.
- `qol-config` for config + auto-config rendering.
- No `qol-platform` use (the plugin is Linux-only and inlines its X11 deps directly).

## Build / Dev

- `make dev` builds and installs to the plugin root.
- `make release` produces an optimized build.
- Standard `validate_plugin_contract` test in `src/main.rs`.
