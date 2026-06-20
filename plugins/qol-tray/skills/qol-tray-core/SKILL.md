---
name: qol-tray-core
description: Use when working on the core qol-tray application - the plugin system, tray, feature architecture, and the plugin contract formats (plugin.toml / qol-config.toml / qol-runtime.toml). Rust internals, UI systems, world canvas, and the Profile feature have their own skills.
---

# qol-tray (core)

This skill owns the **core app model**: plugin system, tray, feature architecture,
and the plugin-author contracts. It deliberately holds no file inventories or
line numbers - those rot. Read the code (or the contract files) for the current
shape; this skill holds the durable rules.

> **Full cited reference:** the qol-monorepo carries a comprehensive
> plugin-contract hub at `docs/plugin-contract.md` - every host<->plugin channel,
> the manifest/config/runtime schemas and their validation invariants, the action
> dispatch path, the process lifecycle and host-death watchdog, an injected-env-var
> table, a footgun index, and an add-a-hotkey-action recipe, all cited to
> `file:line`. It lives next to the code (so its citations are maintained with the
> code); use it as the detailed map, and keep this skill for the durable rules.

Adjacent durable knowledge lives in dedicated skills - do not duplicate it here:

| Topic | Skill |
|---|---|
| Rust internals, the three IPC channels, boot phases, concurrency | `qol-tray-rust` |
| Generic workspace Rust style (error handling, graceful shutdown, idle-cost loops) | `rust-conventions` |
| Cross-platform compartmentalization methodology | `qol-arch-code` |
| UI components, Surface system, keyboard nav, styling | `qol-tray-ui-systems` |
| World canvas / dive / minimap | `qol-world-canvas` |
| Profile export/import, sync, backups | `qol-tray-feature-profile` |
| Verification stack | `qol-tray-rust` |

## Tray menu

Feature-driven: the menu appends each registered feature's items, an update item
when a newer version is available, then `Quit`. There are no per-plugin tray items.

## Plugin system (the model)

- Plugins live in `~/.config/qol-tray/plugins/`, external to this codebase. Each has a `plugin.toml` manifest, binary entrypoints, and an optional `config.json`.
- Loading scans the plugin dir, parses + validates each manifest, and resolves a source per plugin.
- Execution is manifest-driven: **daemon-socket dispatch first, runtime-binary fallback.**
- Source resolution unifies installed, dev-linked, and worktree-linked plugins through the registry (`src/plugins/registry/` + `resolver.rs`). The `SlotSource` variants and the per-slot fallback are defined there - read the enum, never memorize a list. Dev-link/worktree resolution is `#[cfg(feature = "dev")]`-gated; prod resolves installed plugins only.
- A plugin's id derives from its directory name.
- **When a `SlotSource` variant is added, audit every `matches!(source, ...)` branch** - the autostart guard, the execution-contract binary search, and the profile-sync-lock filter each special-case the source. A missed branch silently mis-handles the new kind.

## Plugin manifest (`plugin.toml`)

```toml
[plugin]
name = "Plugin Name"
description = "Description"
version = "1.0.0"
platforms = ["linux"]            # optional - omit for all platforms

[runtime]
command = "plugin-binary"
actions = { run = ["run"], settings = ["settings"] }   # optional map

[menu]
label = "Menu Label"
items = [
    { type = "action", id = "run", label = "Run", action = "run" },
    { type = "checkbox", id = "toggle", label = "Enable", checked = true,
      action = "toggle-config", config_key = "enabled" },
    { type = "separator" },
    { type = "submenu", id = "sub", label = "More", items = [...] },
]

[daemon]                          # optional
enabled = true
command = "plugin-binary"
socket = "/tmp/qol-plugin.sock"

[[dependencies.binaries]]
name = "plugin-binary"
repo = "qol-tools/plugin-repo"
pattern = "plugin-binary-{os}-{arch}"
```

Action types: `run` (daemon socket or runtime binary), `toggle-config` (flip a
boolean in `config.json` at `config_key`), `settings` (mapped runtime action).

## Plugin contracts (two-file pattern)

Plugins declare their user-facing surface through two TOML files at the plugin
root, both parsed by the `qol-config` crate.

**`qol-config.toml`** - persistent config the user edits, saved to `config.json`.
Field kinds include `boolean`, `string`, `number`, `select`, `string_array`,
`object_array`, `object_map`, `color`, `action`, `list`, `status`, `qr_code`.

**`qol-runtime.toml`** - named actions and queries the plugin exposes (non-persistent).
Required only when `qol-config.toml` references action/query names.

```toml
# qol-config.toml
schema_version = 1

[field.pair_device]
type = "action"
label = "Pair Device"
action = "pair_device"           # references [action.pair_device] in qol-runtime.toml

[field.coordinator_status]
type = "status"
query = "connection_status"      # references [query.connection_status]
value_from = "state"
tone_map = { ok = "success", offline = "danger" }
```

```toml
# qol-runtime.toml
schema_version = 1

[action.pair_device]
description = "Initiate Zigbee device pairing"
confirm = "Start pairing mode?"

[query.connection_status]
description = "Current coordinator state"
poll_interval_ms = 1000
```

Names are lowercase snake_case; actions and queries share one namespace (no
collisions). Cross-validation happens at three layers: the `qol-config` CLI
(run by qol-cicd on every PR), the qol-tray runtime (refuses to load a plugin
with dangling references), and a per-plugin `validate_qol_contracts` test.

The field kinds that reference the runable contract (`action`, `list`, `status`,
`qr_code`, plus `color` against config) are what auto-config renders into live,
keyboard-navigable controls.

## Daemon protocol

`DaemonResponse::Handled { data: Option<Value> }` carries structured JSON back to
qol-tray; plugins handling **query** actions must populate `data`. The dispatch
layer extracts the payload and returns it to the caller. Plain actions work with
or without a payload.

HTTP surface for the contracts:
- `POST /api/plugins/<id>/actions/<action_name>` - dispatches via the action executor.
- `GET  /api/plugins/<id>/queries/<query_name>` - validates the query exists, dispatches, returns the JSON payload.

## Auto-config rendering

Plugins are rendered by qol-tray's auto-config frontend (`ui/views/plugin-config/`)
directly from their `qol-config.toml` fields. **This is the only rendering path** -
there is no per-plugin iframe / custom-UI path. New plugins express their UI through
field kinds; expand the kind catalog if a field kind is missing.

## Contract and delivery rules

- Commands are strict binary basenames (`[A-Za-z0-9_-]+`) - never `.sh`, absolute paths, or traversal.
- When `runtime.actions` is present, every executable menu action requires a mapping (strict coverage).
- Command resolution is symlink-safe: canonicalized targets must stay under the plugin root.
- Dev-mode binary resolution order is **plugin root first, then `target/debug/`, then `target/release/`**. Do not leave stale binaries in the plugin root - they win over a fresh `target/debug/` build.
- In dev mode qol-tray runs `cargo build` directly; a plugin needs a `Cargo.toml`, not a Makefile.
- Plugin reload (`/api/dev/reload`) is single-flight via an `AtomicBool` guard; concurrent requests get `409`. The build runs in `spawn_blocking` so it never blocks axum workers.
- Every plugin must include a contract-validation test that parses `plugin.toml` and calls `manifest.validate()`, with `qol-tray` + `toml` in `[dev-dependencies]`.

## Hotkeys

qol-tray grabs global hotkeys at the X11 level (`src/hotkeys/`), intercepting them
before the window manager. Bindings live in `~/.config/qol-tray/hotkeys.json`
(`id`, `key`, `plugin_id`, `action`, `enabled`); key/modifier names are defined in
`src/hotkeys/types.rs`. To replace an OS shortcut: disable it in System Settings,
add the binding, restart so qol-tray grabs the key exclusively.

## Cross-platform tray

Platform tray impls live in `src/tray/platform/` (linux: GTK loop on its own
thread; macOS: `NSApplication.run()` on the main thread via objc2; windows:
Condvar blocking). The **one hard host-app invariant**: the macOS tray icon and
`NSApplication.run()` must be created on the main thread, with tokio on a
background thread. Broader Rust platform gotchas → `qol-tray-rust`; the
strategy-pattern methodology that replaces scattered `#[cfg]` → `qol-arch-code`.

## New-view integration

Every dashboard view is a citizen of all infrastructure or it is broken. A new
view must integrate, at minimum:

- **Global keyboard routing** via the view-keyboard registration hook - never local `onKeyDown`/`tabIndex` on divs.
- **Command-palette** search (filter on the shared query) and actions (register view commands).
- **The shared view registry** - one label/order map; never a second local registry.
- **The `display:none` lifecycle** - views are hidden, never unmounted, so polling/intervals/subscriptions must stop while inactive.

Component, Surface, and styling details → `qol-tray-ui-systems`.

## Icon

The tray icon is embedded at compile time from `assets/icon.rgba` (raw RGBA,
generated from `assets/icon.png`). Update the PNG, regenerate the RGBA, rebuild.

## Verification

Run the repo-native build + test first (via `qol`/`make`), then the cargo
`-D warnings` stack. The full command set and rules live in `qol-tray-rust`
(Verification) - do not report core work green until they pass.
