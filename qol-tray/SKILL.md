---
name: qol-tray
description: Use when working on the core qol-tray application, including plugin system, tray platform modules, and feature architecture.
---

# qol-tray

## Cross-Platform Support

Platform-specific code lives in `src/tray/platform/`:
- `linux.rs` - GTK event loop in separate thread
- `macos.rs` - NSApplication.run() on main thread (objc2)
- `windows.rs` - Condvar-based blocking

Prefer keeping platform differences in platform modules. Some lifecycle-specific macOS handling already exists in `main.rs`, so do not force refactors just to remove existing `#[cfg]` usage.

## Development Commands

```bash
make run      # Build and run
make dev      # Build and run with dev features (Developer tab)
make test     # Run tests
make install  # Build release and install to /usr/bin
make clean    # Clean build artifacts
make release  # Local helper: lint, test, bump Cargo.toml, commit, tag, push
```

## Required Verification

Do not report `qol-tray` work as complete until the repo-native verification commands pass unless the user explicitly says not to run them:

```bash
make build
make test
cargo build --features dev
```

These are the primary source of truth because they match how this repo is actually built and exercised in day-to-day work.

After the repo-native commands pass, the direct CI-equivalent Rust stack is still required for thoroughness when you changed Rust, tests, or build wiring:

```bash
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo build
cargo test
```

Rules:
- Run `make build`, `make test`, and `cargo build --features dev` first after code, test, config, or UI changes. Do not stop at a targeted test slice if you touched the repo.
- Then run the direct Rust stack when the change touched Rust code, tests, feature wiring, or verification-sensitive behavior.
- `cargo test` is not enough. Clippy catches real failures in test targets and helper code that compile and tests can miss.
- `cargo build` is still required after lint. The repo CI runs a separate build job, so passing clippy does not replace build validation.
- If you edit `ui/` files, `node --check` on the changed files is useful, but it is additive. It does not replace the Rust stack above.
- If one command fails, fix the issue or report the concrete blocker before saying the repo is green.
- If a user says `qol-tray` still does not build, rerun their exact failing repo command immediately. Do not argue from substitute commands.

## Hotkeys System

qol-tray has a native global hotkey system (`src/hotkeys/`) that grabs keys at the X11 level, intercepting them before the window manager (e.g., Cinnamon) can act on them.

Hotkey bindings live in `~/.config/qol-tray/hotkeys.json`:

```json
{
  "hotkeys": [
    {
      "id": "hk-alt-tab-plugin",
      "key": "Alt+Tab",
      "plugin_id": "plugin-alt-tab",
      "action": "open",
      "enabled": true
    }
  ]
}
```

Key names (case-insensitive) are defined in `src/hotkeys/types.rs` (`KEY_CODE_MAP`). Supported modifiers: `Alt`, `Ctrl`, `Shift`, `Super`. Supported keys: `a-z`, `0-9`, `f1-f12`, `space`, `enter`, `escape`, `tab`, `backspace`, `delete`, `insert`, `home`, `end`, `pageup`, `pagedown`, arrow keys, `printscreen`, `pause`.

**To replace an OS-level shortcut** (e.g., replacing the native Alt+Tab switcher):
1. Disable the OS shortcut in System Settings → Keyboard → Shortcuts → Windows
2. Add the binding to `hotkeys.json` pointing to the relevant plugin action
3. Restart qol-tray — it will grab the key exclusively via `XGrabKey`

## Architecture

**Tray menu:** The tray menu is feature-driven. It appends feature menu items, an update item when a newer version is available, and `Quit`.

### Core Modules

**src/plugins/** - Plugin loading, execution, and configuration
- Scans `~/.config/qol-tray/plugins/` for plugin directories
- Each plugin has: `plugin.toml` (manifest), binary entrypoints, optional `config.json`
- Runtime execution is manifest-driven: daemon socket dispatch first, runtime binary fallback
- Supports daemon processes and config toggles
- Key types: `Plugin`, `PluginManager`, `PluginManifest`
- Files: `mod.rs` (`Plugin` + exports), `manager/mod.rs` (load/reload/runtime), `loader/mod.rs` + `loader/scan.rs`/`loader/manifest_loader.rs`, `manifest/mod.rs` + `schema.rs`/`validation.rs`, `resolver.rs`

**src/menu/** - Menu abstraction and event routing
- `builder.rs`: Builds the tray menu from registered feature menu items, plus optional update item and Quit (no per-plugin tray items)
- `router.rs`: EventRouter with EventPattern (Exact/Prefix) for O(k) routing
- Event format: `feature-id::menu-item-id`

**src/tray/** - System tray UI with platform abstraction
- Platform-specific implementations in `platform/` subdirectory:
  - `linux.rs`: GTK event loop in separate thread, glib polling for menu events
  - `macos.rs`: NSApplication.run() on main thread, objc2 for Cocoa bindings
  - `windows.rs`: Condvar-based blocking, menu events via spawned thread
  - `mod.rs`: Routing to platform modules, shared `spawn_menu_event_handler`
- `PlatformTray` enum handles platform differences at compile time
- `icon.rs`: Icon loading from embedded RGBA data, supports notification dot variant
- Uses `tray-icon` crate (cross-platform)

**src/features/plugin_store/** - Browser-based plugin management
- Serves web UI at `http://127.0.0.1:42700`
- Landing page shows installed plugins and plugin store
- Plugin settings accessed via `/plugins/{plugin_id}/`
- API endpoints for install/uninstall operations
- Fetches available plugins from `github.com/qol-tools/*`
- Remote version metadata is release-gated: version comes from `releases/latest` tag and is only surfaced when required dependency assets exist for the active OS/arch
- Asset pattern resolution is centralized in `src/features/plugin_store/release_assets.rs`

**src/features/profile/** - Profile import/export, sync, backups, and profile UI transport
- `core/`: profile bundle, storage, lock reconciliation, import/export rules
- `sync/`: sync service, state, provider adapters, and platform integration
- `http/`: export/import and sync HTTP routes mounted from plugin-store settings
- `startup.rs`: startup migration from legacy config layout into `profile/`

**src/updates/** - Auto-update system
- Checks GitHub API on startup for new releases (2s timeout)
- Compares semantic versions
- Shows orange notification dot on tray icon when update available
- Linux updates use release packages for local or system installs
- macOS updates consume the universal app-bundle archive and replace the enclosing `.app` bundle
- Windows opens the latest release page
- Kills plugin daemons before restart to avoid socket conflicts

**src/plugins/resolver.rs** - Plugin path resolution
- Current (pre-registry-unification): merges installed plugins (`~/.config/qol-tray/plugins/`) with dev-links from `dev/links.json` via `resolve_all(plugins_dir, dev_links)`
- `PluginSource` currently has two variants: `Installed` and `DevLinked` — no `WorktreeLink` variant yet
- Dev-links always win on conflict; silent override with no fallback tracking
- Dev-link resolution is `#[cfg(feature = "dev")]` gated: prod builds always return `HashMap::new()` from `dev_registry.rs`
- **Pending spec:** `plugin-registry.json` unification will replace `dev/links.json`, add a `WorktreeLink` variant, add a fallback slot per entry, and remove the `dev` feature gate from resolution

**Plugin ID derivation** — id is derived from directory `file_name()` at both installed scan time (`resolver.rs:44`) and dev-link creation time (`dev/linking/store.rs:91-94`). The spec's v2 `plugin.id` field override is future work.

**dev_link conflict guard** (`installer/operations.rs:44-54`): `ensure_no_dev_link_conflict` is called on install, install_exact, update, and update_exact. It hard-blocks all install/update operations when a dev-link exists for the same id. The registry-unification spec removes this in favor of writing a new fallback slot instead.

**Daemon autostart and PluginSource coupling** (`manager/autostart.rs`): daemon autostart for dev-linked plugins is blocked unless a `.qol-tray-dev-autostart` marker file exists in the plugin directory. After registry unification adds `WorktreeLink` as a third `PluginSource` variant, this `matches!(source, DevLinked)` check must be updated or `WorktreeLink` will silently bypass the autostart guard.

**Execution contract and PluginSource** (`execution_contract.rs:90`): binary candidate resolution branches on `Some(PluginSource::DevLinked)` to prioritize `target/debug/` and `target/release/`. After unification, `WorktreeLink` must be added to this branch or dev-built binaries won't be found for worktree-linked plugins.

**Profile sync filtering** (`profile/core/plugins_lock.rs:108`): `sync_plugins_lock_from_plugins` filters to `PluginSource::Installed` only, intentionally excluding dev-linked plugins from the sync lock. After unification adds `WorktreeLink`, this filter still holds — the property is correct but must be verified to exclude `WorktreeLink` too.

**Operation lock scope** (`installer/operation_lock.rs`): per-plugin file lock at `plugins_dir/.{id}.lock`. Protects install/update/uninstall serialization. Does not protect registry JSON writes — registry write atomicity relies solely on the temp-file-rename pattern.

**src/logging/** - Centralized logging with filterable logger
- `control.rs`: Log control persistence (mute, suppress patterns) for plugins and core sections
- `relay.rs`: Stdout/stderr relay with pattern-based suppression
- Dev mode: `FilterableLogger` with runtime-adjustable core log controls via dev UI

### Web UI Architecture

Preact with htm tagged templates (no JSX, no build step). Views mount lazily and then stay mounted behind layer-aware `display:none`.

**HARD RULE: New Views Must Honor ALL Infrastructure**

Every view is a citizen of the qol-tray dashboard. Adding a view without integrating with all infrastructure systems is incomplete. Use existing views (hotkeys-view.js, plugins-view.js, store-view.js) as reference.

**Mandatory integration checklist for every new view:**

1. **Global keyboard routing** (`useRegisterViewKeyboard`)
   - Import from `../components/app/view-keyboard-context.js`
   - Register `handleKey` callback for the view ID
   - Arrow keys navigate content, Enter activates, Escape dismisses modals
   - `isBlocking` prevents Tab cycling during modal/edit states
   - NEVER use local `onKeyDown`/`tabIndex` on divs

2. **Command palette search** (`usePaletteContext`)
   - Import from `../palette/context.js`
   - Read `searchQuery` and filter displayed content when non-empty
   - Use `matchesQuery()` from `../utils/collections.js` for consistent filtering

3. **Command palette actions** (`useRegisterCommands`)
   - Import from `../palette/useRegisterCommands.js`
   - Register view-specific commands (e.g., "Clear suppressed", "Refresh logs")
   - Commands appear in the `>` action mode of the palette (Ctrl+E then `>`)

4. **View registration** (`ui/components/app/views.js`)
   - Add to `VIEW_LABELS`, `BASE_ORDER`, and `renderWorldViews`
   - Pass `active` prop if the view needs to know when it's visible

5. **World labels/navigation**
   - `WorldNav.js` and `RegionLabels.js` read the shared `VIEW_LABELS` map from `ui/components/app/views.js`
   - Do not introduce a second local label registry

6. **CSS** (`ui/styles/`)
   - Create view-specific CSS file, import in `styles.css`
   - Use design tokens from `theme-tokens.css` — never hardcode values

7. **Display:none lifecycle**
   - Views are NEVER unmounted, only hidden via `display:none`
   - Polling/intervals MUST stop when `active` is false
   - Subscriptions MUST be gated on visibility

If any of these is missing, the view is broken.

**ui/components/** - Shared components
- `Surface.js`: Primordial component — all interactive elements derive from this. Exports `useSurface()` trait hook, `useInputSurface()` (with ref ownership), and `Surface` component. Never write raw `data-selected-surface=""`.
- `ListRow.js`: Row component composing Surface — accent border, header/body strips, optional action column. Sub-components: `ListRowHeader`, `ListRowBody`, `ListRowTitle`, `ListRowText`. Container: `ListGroup` with deselect-on-blur.
- `rows/PluginRow.js`, `rows/LogRow.js`, `rows/SuppressedRow.js`, `rows/BackupRow.js`: Specialized row components composing ListRow with variant-specific accent, badges, and actions.
- `PageHeader.js`: Uniform 48px header with title, subtitle, optional badge, command palette, noise animations
- `ViewTabs.js`: Shared tabbed content switcher — tab buttons use Surface, manages preview/activate routing. ANY view with tabs MUST use this component.
- `Expander.js`: Expand/collapse component composing Surface
- `CustomSelect.js`: Dropdown using Surface (trigger) + useInputSurface (list with ref ownership)
- `CommandPalette.js`: Global command palette, dual-mode: `>` prefix for actions, plain text for search. Items use Surface.
- `ModalPreact.js`: Modal + ModalFooter, action buttons use Surface
- `CodeBlock.js`: Formatted code display with click-to-copy
- `SurfaceContainer.js`: Navigation region boundary (NOT a Surface — structural only)
- `StatusIndicators.js`: Badge, HealthDot, Alert (display-only, no Surface)
- `NoiseBorder.js`: Canvas-based noise accent line on PageHeader, activates when palette opens
- `NoiseReveal.js`: Canvas-based bubble buoyancy reveal animation
- `ScrambleText.js`: Random-order character reveal animation for titles
- `WorldNav.js`: Command-palette and keyboard world navigation across root-layer views
- `RegionLabels.js`: Overlay labels for world regions sourced from the shared view registry
- `SidebarFooter.js`: Footer with recompile button and worktree picker (dev mode)
- `app/views.js`: View registry (`VIEW_LABELS`, `BASE_ORDER`, `buildViewOrder`) and `WorldViewSlot`/`renderWorldViews` for layer-aware display toggling

### UI Component Rules (Mandatory)

- **Surface is the primordial.** Every interactive element uses `Surface` or `useSurface()`/`useInputSurface()`. Never write raw `data-selected-surface=""`.
- **Composition is hierarchical, never bespoke.** Every component must compose from the trait hierarchy: `Surface` → base shapes (`TableRow`, `ListRow`, `Card`) → specialized components (`DevPluginRow`, `PluginRow`, `LogRow`, etc.). No component may be a completely bespoke one-off — it must derive from an existing shared component unless there is an explicit, stated reason to diverge. If a new row behaves like an existing row type (same layout, same interaction), it MUST use that component with different props — not reimplement the same pattern.
- **Traits are hooks, shapes are components.** Behaviors compose via hooks (useClickOutside, useScrollFollow, useListSelection). Visual structure composes via components (ListRow → PluginRow). Variants come from props and data, not from separate components with duplicated markup.
- **Refs never cross boundaries.** Components needing DOM access use `useInputSurface()` internally. No ref forwarding.
- **No boilerplate duplication.** If two views share structural markup, extract a shared component. If it already exists, use it.
- **Keyboard navigation is automatic.** Surface provides `data-selected-surface`. Do NOT manually add keyboard handlers for basic navigation.
- **Tabs use `ViewTabs`.** Do not implement tab switching manually.
- **Buttons use `Surface as="button"` with `.btn` classes.** Variants: `btn-primary`, `btn-ghost`, `btn-danger`, `btn-dropdown`.
- **Rows use specialized row components** (PluginRow, LogRow, etc.) inside ListGroup/Table. Never build row markup from scratch. Data-driven lists render all items through one component — differentiate via props, not separate components.
- **Provider fields are strategy-driven.** The backend defines all fields per provider. The frontend renders whatever the provider declares.
- **Components catalog (Dev tab) is the POC.** All new patterns must be showcased in the catalog before migrating to real views.

**ui/palette/** - Command palette infrastructure
- `context.js`: PaletteContext provider with dual-mode state (search vs action)
- `registry.js`: Command registry for palette actions
- `useRegisterCommands.js`: Hook for views to register their commands

**ui/lib/** - Shared utilities
- `canvas.js`: Canvas helpers for noise/reveal animations (resolveColor, pixel manipulation)
- `scramble.js`: Fisher-Yates shuffle, deterministic hash for per-pixel random phase/speed
- `html.js`: htm + preact binding

**ui/views/** - Page views (plugins, store, hotkeys, shortcuts, task-runner, profile, logs, dev)
- Views use either a top-level coordinator file (`*-view.js`) or a feature subdirectory with `view.js` plus focused helpers/hooks for data/state
- Dev view uses Preact components (migrated from full-DOM string templates)

**ui/styles/** - CSS architecture
- `theme-tokens.css`: Color palette and semantic tokens
- `styles.css`: Global token definitions
- `page-header.css`: PageHeader layout with noise animation support
- `common-controls.css`: Shared form controls, search bars
- View-specific files: `dev-layout.css`, `plugin-grid.css`, etc.

### Plugin Manifest Format

Plugins define their menu structure in `plugin.toml`:

```toml
[plugin]
name = "Plugin Name"
description = "Description"
version = "1.0.0"
platforms = ["linux"]  # Optional - omit for all platforms

[runtime]
command = "plugin-binary"
actions = { run = ["run"], settings = ["settings"] }  # Optional map

[menu]
label = "Menu Label"
items = [
    { type = "action", id = "run", label = "Run", action = "run" },
    { type = "checkbox", id = "toggle", label = "Enable", checked = true,
      action = "toggle-config", config_key = "enabled" },
    { type = "separator" },
    { type = "submenu", id = "sub", label = "More", items = [...] }
]

[daemon]  # Optional
enabled = true
command = "plugin-binary"
socket = "/tmp/qol-plugin.sock"

[[dependencies.binaries]]
name = "plugin-binary"
repo = "qol-tools/plugin-repo"
pattern = "plugin-binary-{os}-{arch}"
```

Action types:
- `run` - Execute action via daemon socket or runtime binary
- `toggle-config` - Toggle boolean in `config.json` at `config_key` path
- `settings` - Execute mapped runtime action

Platform-specific code belongs in `platform/` directories, not root modules.

### Plugin Contracts (Two-File Pattern)

Every plugin declares its user-facing surface through two TOML files at the plugin root. Both are parsed by the `qol-config` crate (v1.3.0+).

**`qol-config.toml`** — Config Contract (persistent state)
Describes fields that the user can edit and qol-tray persists to the plugin's `config.json`. Parsed into `ConfigSpec`. Field kinds: `boolean`, `string`, `number`, `select`, `string_array`, `object_array`, `object_map`, `color`, `action`, `list`, `status`, `qr_code`.

```toml
schema_version = 1

[field.window_border_color]
type = "color"
default = "#5FA8FF"
alpha = false

[field.pair_device]
type = "action"
label = "Pair Device"
action = "pair_device"    # references [action.pair_device] in qol-runtime.toml
variant = "primary"

[field.paired_devices]
type = "list"
label = "Paired"
query = "list_devices"    # references [query.list_devices] in qol-runtime.toml
row_label = "{name}"
row_subtitle = "{ieee}"
empty_message = "No devices paired yet."

[field.coordinator_status]
type = "status"
label = "Coordinator"
query = "connection_status"
value_from = "state"
label_map = { ok = "Connected", offline = "Offline" }
tone_map = { ok = "success", offline = "danger" }
```

**`qol-runtime.toml`** — Runable Contract (non-persistent interactions, NEW in this architecture)
Declares named actions and queries the plugin exposes. Required only when `qol-config.toml` references action/query names. Parsed into `RuntimeSpec`.

```toml
schema_version = 1

[action.pair_device]
description = "Initiate Zigbee device pairing"
confirm = "Start pairing mode?"

[query.list_devices]
description = "All currently paired Zigbee devices"
poll_interval_ms = 2000

[query.connection_status]
description = "Current coordinator state"
poll_interval_ms = 1000
```

Naming rules: lowercase snake_case (`[a-z][a-z0-9_]*`). Action and query names share one namespace — no collisions allowed.

**Cross-validation** happens at three layers:
1. **qol-config CLI** (`cargo run --bin qol-config -- validate --plugin-root <path>`) — run by `qol-cicd`'s `plugin-ci.yml` on every PR
2. **qol-tray runtime** — `load_combined_contracts_from_root()` refuses to load a plugin with dangling references
3. **Per-plugin `validate_qol_contracts` test** — each plugin includes a Rust test that parses both files

**Field kinds that reference the runable contract** (auto-config rendering):
| Kind | What it renders | Keyboard | Backed by |
|---|---|---|---|
| `color` | Hex picker (native `<input type="color">` + text input) | focus, commit | config value |
| `action` | Button | Enter/Space | `[action.NAME]` → daemon action |
| `list` | Live-polled list with row templates | arrow nav | `[query.NAME]` → daemon response data |
| `status` | Live-polled chip with label/tone maps | non-interactive | `[query.NAME]` → value_from path |
| `qr_code` | Canvas (stub renderer; needs QR library) | non-interactive | `[query.NAME]` → value_from path |

### Daemon Protocol: Query Responses Carry Payloads

As of the runable-contract migration, `DaemonResponse::Handled { data: Option<Value> }` carries structured JSON back to qol-tray. The `action_transport::DaemonActionDispatch::Handled { payload }` variant propagates this.

**Plugins handling query actions** must populate the `data` field in their daemon response. Example daemon handler:

```rust
fn handle_action(action: &str) -> DaemonResponse {
    match action {
        "list_devices" => DaemonResponse::Handled {
            data: Some(serde_json::json!({
                "devices": [{"ieee": "0x00124b00...", "name": "Kitchen", "online": true}]
            })),
        },
        "pair_device" => {
            start_pairing();
            DaemonResponse::Handled { data: None }
        }
        _ => DaemonResponse::Fallback,
    }
}
```

`dispatch_query` in `action_executor.rs` extracts `payload` and returns it via `Result<serde_json::Value, ActionExecutionError>`. Actions still work with or without payloads.

### HTTP Routes

- `POST /api/plugins/<id>/actions/<action_name>` — dispatches via existing `try_execute_action` + action executor
- `GET /api/plugins/<id>/queries/<query_name>` — validates query exists in runable contract, dispatches via `dispatch_query`, returns JSON payload

### Auto-Config Rendering Path (current)

Plugins without `ui/index.html` (or with one that contains `initAutoConfigPage` — the legacy bootstrap template) are routed by `use-actions.js:41-44` through `openPluginConfig` → auto-config. qol-tray's Preact frontend at `ui/views/plugin-config/` renders fields via `field-map.js` → `fields/*.js`. Keyboard nav works via `delegateToPluginConfig` in `useAppKeyboardRouting.js`.

Plugins with a real `ui/index.html` (not containing `initAutoConfigPage`) are routed to `openPluginUi` → iframe. **This path is scheduled for removal once all plugins migrate to auto-config.** Do not add new plugins that rely on iframe rendering.

### Iframe Path Deprecation (In-Progress Migration)

The `mode='ui'` iframe path is a **temporary backward-compat shim**. The migration plan deletes:
- `mode='ui'` branch in `ui/views/plugin-config/view.js:20-32`
- `openPluginUi` in `ui/hooks/useRouter.js`
- `activePluginMode` state threading through `App.js`, `useApp.js`
- `has_custom_ui` routing branch in `ui/views/plugins/use-actions.js:41-44`
- `.plugin-ui-*` CSS rules in `ui/styles/plugin-config.css`

Per-plugin migrations (one plan per plugin) are the path forward. Each plugin migration:
1. Verify the plugin's custom UI features are expressible through auto-config field kinds (or expand the kind catalog first)
2. Create `qol-runtime.toml` if the plugin needs actions/queries
3. Update `qol-config.toml` to use the new field kinds
4. Delete the plugin's `ui/` directory
5. Remove any plugin-side static file HTTP routes
6. Test and release

## Icon Management

Icon is embedded as raw RGBA data at compile time from `assets/icon.rgba` (64x64 pixels, generated from `icon.png`).

To update icon:
1. Edit `assets/icon.png`
2. Convert to RGBA: `python3 -c "from PIL import Image; img = Image.open('assets/icon.png'); open('assets/icon.rgba', 'wb').write(img.tobytes())"`
3. Rebuild

## Plugin Development

Plugins are external to this codebase. They live in `~/.config/qol-tray/plugins/`.

The daemon provides:
- Plugin loading and manifest parsing
- Browser-based settings UI (each plugin can have `ui/index.html`)
- Config file management (read/write JSON)
- Process execution (runtime binaries and daemons)

Plugins should expose binary entrypoints through `runtime.command` and optional `daemon.command`.

## Contract and Delivery Rules

- Commands are strict binary basenames (`[A-Za-z0-9_-]+`), never `.sh`, never absolute paths, never traversal.
- Runtime coverage is strict: when `runtime.actions` is present, all executable menu actions require mappings.
- Command resolution is symlink-safe: canonicalized command targets must stay under plugin root.
- In dev mode, binary resolution order is: **plugin root directory first**, then `target/debug/`, then `target/release/`. **Do not leave stale binaries in the plugin root** — they will be preferred over freshly built `target/debug/` binaries.
- In dev mode, `qol-tray` uses `cargo build` directly. No Makefile is needed or expected. Ensure your plugin contains a `Cargo.toml`.
- Plugin reload (`/api/dev/reload`) is protected by a single-flight `AtomicBool` guard (`BUILD_IN_PROGRESS`). Concurrent reload requests return `409 Conflict`. The build runs in `tokio::task::spawn_blocking` to avoid blocking axum worker threads.
- Every plugin **must** include a contract validation test in its main source file:

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

  Add `qol-tray` and `toml` to `[dev-dependencies]` in `Cargo.toml`:

```toml
[dev-dependencies]
qol-tray = { path = "../../qol-tray" }
toml = "0.9"
```

## Lessons Learned

### Test-Driven Bug Discovery
Adding comprehensive edge case tests often reveals bugs in the implementation:
- Adding `("V1.2.3", vec![1, 2, 3])` test case revealed version parser only handled lowercase 'v'
- Adding `("--help", false)` test case revealed action ID validation didn't check leading dashes
- Adding `("<body data-x='a>b'>", Some(19))` test case revealed HTML parser didn't handle `>` inside quotes

**Pattern:** When adding tests, think about what the implementation *actually does* vs what it *should do*. Write the test for expected behavior first, then fix the implementation if it fails.

### Consolidate Validation Functions
Path/ID validation functions tend to get duplicated. Keep them in one place:
- `paths::is_safe_path_component()` - validates single path components (no `/`, `\`, `..`, `.`, null bytes)
- Used by: `config.rs`, `plugin_ui.rs`, anywhere plugin IDs are used in paths

### Graceful Process Shutdown
When stopping child processes:
1. Send SIGTERM first (Unix) to allow graceful cleanup
2. Wait with timeout (2s is reasonable)
3. Only SIGKILL if process doesn't respond
4. Use `libc::kill()` directly - no Rust wrapper needed

### Error Handling Patterns
- `.expect()` is acceptable for compile-time invariants (embedded assets)
- `.expect()` is NOT acceptable for runtime operations (file paths, config dirs)
- Return `Option` or `Result` and let callers decide how to handle
- Log errors at the point of failure, not just at the top level

### HTML Parsing Edge Cases
Simple string matching for HTML tags needs to handle:
- Case insensitivity (`<body>` vs `<BODY>`)
- Attributes containing `>` (need quote-aware parsing)
- Tags inside comments (skip `<!-- <body> -->`)

A proper HTML parser would be overkill - just handle the common cases correctly.

### GitHub Token Validation
Token validation uses typed errors (`TokenValidationError::Empty`, `Invalid`, `Upstream`) to distinguish between user mistakes (400) and GitHub API failures (502). The frontend renders a state-driven token banner based on `showTokenInput`, `rateLimited`, and `hasToken` flags — no imperative show/hide calls.

### macOS Tray Icon Requirements
On macOS, `tray-icon` crate requires:
1. Tray icon must be created on the main thread
2. `NSApplication.run()` must be called on the main thread (blocks until quit)
3. Tokio runtime must run on a background thread

The pattern is: main thread runs Cocoa event loop, background thread runs tokio for async operations (web server, etc.). Use `objc2` crate for Cocoa bindings.
