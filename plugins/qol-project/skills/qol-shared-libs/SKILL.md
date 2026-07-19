---
name: qol-shared-libs
description: Use when adding functionality, dependencies, native UI, runtime contracts, or platform-specific code to any qol-tray plugin under plugins/*. MUST check shared libraries before adding code directly to a plugin, especially when implementing a pattern another plugin could reuse.
---

# Shared Library Check

Before adding functionality to a plugin, check if it belongs in a shared library. If two plugins need the same capability, it MUST go in the shared lib.

## Shared Libraries

| Library | Purpose | Key Modules |
|---------|---------|-------------|
| `qol-conventions` | Cross-process constants and wire contracts | doctor CLI/report contract, daemon health snapshots, settings URLs |
| `qol-plugin-api` | Plugin contract types | `manifest`, `capability`, `restore` |
| `qol-plugin-daemon` | Resident plugin and helper-process plumbing | `daemon` (Unix socket listener/client and host-death watchdog), `activation`, `notification` |
| `qol-gpui` | Shared native UI rendering and window behavior | `Surface`, `SettingsWindowHost`, `SettingsRuntime`, contract settings rows, `Dropdown`, `ScrollList`, `Spinner`, `StatusIndicator` |
| `qol-config` | Plugin config + runtime contracts, validation, CLI validator | `contract::v1` (ConfigSpec, FieldKind incl. Color/Action/List/Status/QrCode), `contract::runtime` (RuntimeSpec, ActionSpec, QuerySpec), `contract::cross_validate` (validate_contracts), `normalized`, `validation` |
| `qol-platform` | OS detection, capability flags | `PlatformCapabilities` (can_global_hotkey, can_focus_popup, can_clipboard_monitor, can_window_positioning) |
| `qol-runtime` | State socket protocol, monitor bounds | `PlatformStateClient`, `MonitorBounds`, `CursorPos`, `protocol` |
| `qol-process` | Cross-platform process lifecycle | detached spawning, PID liveness, termination, waiting, child reaping |
| `qol-apps` | App inventory and desktop integration | Linux desktop entries, macOS bundles, default open, file-manager reveal |
| `qol-hotkeys` | Shared hotkey grammar and native key adapters | canonical grammar, evdev keycodes and modifier state, macOS keycodes |
| `qol-color` | Color utilities | |
| `qol-search` | Fuzzy matching | `fuzzy_match`, `FuzzyMatch` |
| `qol-fx` | Standalone canvas/CSS animation effects (JS) | `dissolve`, `dissolve-gpu`, `glitch-squares`, `glow`, `canvas` |
| `qol-frecency` | Frecency scoring/decay | |

## Plugin Dependencies

Do not maintain a duplicate plugin-to-library inventory in prose. Inspect the
plugin's `Cargo.toml` or `cargo metadata` at read time. All shared crates are
workspace path dependencies, so the checked-out monorepo is the dependency
graph and Cargo owns build order.

## Before Adding Code to a Plugin

1. **Is this a cross-process constant or serialized wire type?** → Check `qol-conventions`
2. **Is this plugin manifest, capability, or restore state?** → Check `qol-plugin-api`
3. **Is this a resident daemon, helper socket, or host-death lifecycle?** → Check `qol-plugin-daemon`
4. **Is this a native component, contract settings row, spinner, list, or surface?** → Check `qol-gpui`
5. **Is this GPUI window, monitor, keepalive, or platform behavior?** → Check `qol-gpui`
6. **Is this non-UI platform behavior?** → Check `qol-platform`
7. **Is this config loading?** → Check `qol-config`
8. **Is this app discovery, default opening, or file-manager reveal?** → Check `qol-apps`
9. **Is this process lifecycle or detached spawning?** → Check `qol-process`
10. **Is this hotkey grammar, native keycode mapping, or modifier state?** → Check `qol-hotkeys`
11. **Could another plugin need this?** → Put it in the shared lib

## Integration Order

Shared libraries and consumers land atomically in the monorepo. Do not split a
shared API and its consumers into an artificial push sequence. Stage the full
coherent change and let the workspace build graph validate it.

## Adding a New Dependency

When a plugin needs a new crate (e.g., `x11rb`, `libc`):
- If only ONE plugin uses it → add to that plugin's `Cargo.toml`
- If TWO+ plugins use it for the SAME purpose → add to the relevant shared lib
- Platform-specific deps use `[target.'cfg(target_os = "...")'.dependencies]`

All shared lib crates live under `libs/` in the monorepo, consumed as workspace deps.

## Plugin Contract Files

Every plugin declares its user-facing surface through two TOML files at its root:

1. **`qol-config.toml`** — persistent settings and renderer-neutral field declarations
2. **`qol-runtime.toml`** — named `[action.NAME]` and `[query.NAME]` tables the plugin's daemon handles; only required when `qol-config.toml` references them

Cross-validation runs at three layers:
- **Local**: `cargo run -p qol-config --bin qol-config -- validate --plugin-root .` — use during plugin development
- **CI**: `qol-cicd/.github/workflows/plugin-ci.yml` runs the same CLI step automatically
- **Runtime**: qol-tray refuses to mount plugins whose contracts are inconsistent

**Daemon query responses carry payloads.** Plugins handling query actions must populate `DaemonResponse::Handled { data: Some(...) }`. qol-tray's `dispatch_query` extracts `payload` and returns JSON to the frontend via `GET /api/plugins/<id>/queries/<name>`.

**Field kinds have richer shapes than their base types** - model the real value space instead of falling back to free text:

- `string_array` accepts `options` + `option_labels`: static options validate membership and the gpui renderer uses the shared multi-select (e.g. qol-shot `audio.inputs`). It also accepts `query = "<name>"` for machine-specific options; dynamic arrays skip membership validation, preserve unavailable stored values, and use the same `[{ "value", "label" }]` query rows as dynamic selects.
- `select` accepts `query = "<name>"` for machine-specific options (e.g. PulseAudio devices): `options` may be omitted, membership validation is skipped, `option_labels` keys seed always-available well-known values (like `default`), and the query name is cross-validated against `qol-runtime.toml`. Query rows are `[{ "value", "label" }]`; UIs merge them with the labeled seeds and keep an unknown stored value selectable. The web renderer polls the query; a hosted GPUI panel uses `SettingsRuntime::tray` to reach the same tray endpoint (`qol-project:qol-plugin-gpui-surfaces`).
- `number` accepts `variant = "slider"` for bounded knobs (web renders a slider; 0..1 ranges slider automatically).

**Migration in progress**: Plugins still using `ui/index.html` iframes are scheduled for migration to auto-config. The iframe path in qol-tray (`mode='ui'`, `openPluginUi`, `has_custom_ui`) is slated for deletion once all plugins land on the auto-config path. Do not introduce new iframe-based plugin UIs — use the contract pattern.
