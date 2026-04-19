---
name: qol-shared-libs
description: Use when adding new functionality, dependencies, or platform-specific code to any qol-tray plugin. MUST check shared libraries before adding code directly to a plugin. Triggers on any change to plugin-alt-tab, plugin-launcher, plugin-keyremap, plugin-lights, plugin-window-actions, plugin-os-themes, plugin-screen-recorder, plugin-pointz.
---

# Shared Library Check

Before adding functionality to a plugin, check if it belongs in a shared library. If two plugins need the same capability, it MUST go in the shared lib.

## Shared Libraries

| Library | Purpose | Key Modules |
|---------|---------|-------------|
| `qol-plugin-api` | Shared GPUI plugin infrastructure | `daemon` (socket IPC), `window` (ActiveWindows, open_window_with_focus), `keepalive` (keepalive window), `monitor` (MonitorTracker), `focus` (X11 process focus check), `activation` (macOS policy), `app_icon` |
| `qol-config` | Plugin config + runable contracts, validation, CLI validator | `contract::v1` (ConfigSpec, FieldKind incl. Color/Action/List/Status/QrCode), `contract::runtime` (RuntimeSpec, ActionSpec, QuerySpec), `contract::cross_validate` (validate_contracts), `normalized`, `validation` |
| `qol-platform` | OS detection, capability flags | `PlatformCapabilities` (can_global_hotkey, can_focus_popup, can_clipboard_monitor, can_window_positioning) |
| `qol-runtime` | State socket protocol, monitor bounds | `PlatformStateClient`, `MonitorBounds`, `CursorPos`, `protocol` |
| `qol-color` | Color utilities | |
| `qol-search` | Fuzzy matching | `fuzzy_match`, `FuzzyMatch` |
| `qol-fx` | Standalone canvas/CSS animation effects (JS) | `dissolve`, `dissolve-gpu`, `glitch-squares`, `glow`, `canvas` |
| `qol-frecency` | Frecency scoring/decay | |

## Plugin Dependencies

| Plugin | Shared Libs |
|--------|-------------|
| plugin-alt-tab | qol-plugin-api, qol-config, qol-color |
| plugin-launcher | qol-plugin-api, qol-search, qol-frecency, qol-platform |
| plugin-keyremap | qol-plugin-api, qol-config |
| plugin-os-themes | qol-plugin-api, qol-config |
| plugin-pointz | qol-plugin-api |
| plugin-window-actions | qol-config |
| plugin-screen-recorder | qol-config |
| plugin-lights | (none) |

## Before Adding Code to a Plugin

1. **Is this platform-specific behavior?** → Check `qol-platform` or `qol-plugin-api`
2. **Is this daemon/socket/IPC?** → Check `qol-plugin-api::daemon`
3. **Is this GPUI window management?** → Check `qol-plugin-api::window`
4. **Is this X11/focus/monitor?** → Check `qol-plugin-api::focus` or `qol-plugin-api::monitor`
5. **Is this config loading?** → Check `qol-config`
6. **Could another plugin need this?** → Put it in the shared lib

## Push Order

Shared libs must be pushed BEFORE plugins that depend on them. Order:
1. `qol-runtime` (lowest level)
2. `qol-platform`, `qol-config`, `qol-color`, `qol-search`, `qol-frecency`
3. `qol-plugin-api` (depends on qol-runtime)
4. Individual plugins (depend on above)

## Adding a New Dependency

When a plugin needs a new crate (e.g., `x11rb`, `libc`):
- If only ONE plugin uses it → add to that plugin's `Cargo.toml`
- If TWO+ plugins use it for the SAME purpose → add to the relevant shared lib
- Platform-specific deps use `[target.'cfg(target_os = "...")'.dependencies]`

All shared lib repos live at `/media/kmrh47/WD_SN850X/Git/qol-tools/qol-*/`.

## Plugin Contract Files (v1.3+ of qol-config)

Every plugin declares its user-facing surface through two TOML files at its root:

1. **`qol-config.toml`** — persistent settings (existing pattern, expanded with 5 new field kinds: `color`, `action`, `list`, `status`, `qr_code`)
2. **`qol-runtime.toml`** — NEW. Declares named `[action.NAME]` and `[query.NAME]` tables the plugin's daemon handles. Only required when `qol-config.toml` references action/query names.

Cross-validation runs at three layers:
- **Local**: `cargo run -p qol-config --bin qol-config -- validate --plugin-root .` — use during plugin development
- **CI**: `qol-cicd/.github/workflows/plugin-ci.yml` runs the same CLI step automatically
- **Runtime**: qol-tray refuses to mount plugins whose contracts are inconsistent

**Daemon query responses carry payloads.** Plugins handling query actions must populate `DaemonResponse::Handled { data: Some(...) }`. qol-tray's `dispatch_query` extracts `payload` and returns JSON to the frontend via `GET /api/plugins/<id>/queries/<name>`.

**Migration in progress**: Plugins still using `ui/index.html` iframes are scheduled for migration to auto-config. The iframe path in qol-tray (`mode='ui'`, `openPluginUi`, `has_custom_ui`) is slated for deletion once all plugins land on the auto-config path. Do not introduce new iframe-based plugin UIs — use the contract pattern.
