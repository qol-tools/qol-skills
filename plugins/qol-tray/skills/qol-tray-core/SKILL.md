---
name: qol-tray-core
description: Use when working on the core qol-tray application - the plugin system, tray, feature architecture, and the plugin contract formats (plugin.toml / qol-config.toml / qol-runtime.toml). Rust internals and the Profile feature have their own skills.
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
| Host-owned native plugin settings | `qol-plugin-gpui-surfaces` |
| Generic workspace Rust style (error handling, graceful shutdown, idle-cost loops) | `rust-conventions` |
| Cross-platform compartmentalization methodology | `qol-arch-code` |
| Profile export/import, sync, backups | `qol-tray-feature-profile` |
| Verification stack | `qol-tray-rust` |

## Tray menu

Feature-driven: the menu appends each registered feature's items, an update item
when a newer version is available, then `Quit`. There are no per-plugin tray items.

## Plugin system (the model)

- Plugins live in `~/.config/qol-tray/plugins/`, external to this codebase. Each has a `plugin.toml` manifest, binary entrypoints, and an optional `config.json`.
- Loading scans the plugin dir, parses + validates each manifest, and resolves a source per plugin.
- Execution is manifest-driven: eligible native settings route to the
  tray-owned settings host first; all other actions use **daemon-socket
  dispatch first, runtime-binary fallback.**
- Source resolution unifies installed, dev-linked, and worktree-linked plugins through the registry (`src/plugins/registry/` + `resolver.rs`). The `SlotSource` variants and the per-slot fallback are defined there - read the enum, never memorize a list. Dev-link/worktree resolution is `#[cfg(feature = "dev")]`-gated; prod resolves installed plugins only.
- A plugin's id is whatever `[plugin].id` declares in its manifest; the manifest is the identity authority (`require_declared_id` rejects an absent or malformed id). Directory names - source or installed - carry no identity. To find a plugin, read manifests and match the declared id; never match a directory name.
- **When a `SlotSource` variant is added, audit every `matches!(source, ...)` branch** - the autostart guard, the execution-contract binary search, and the profile-sync-lock filter each special-case the source. A missed branch silently mis-handles the new kind.

## Plugin manifest (`plugin.toml`)

```toml
[plugin]
id = "plugin-name"               # mutable display label
uid = "<uuid-v4>"                # frozen identity, authored once, never changed
name = "Plugin Name"
description = "Description"
version = "1.0.0"
platforms = ["linux"]            # optional - omit for all platforms

[runtime]
command = "plugin-binary"

[action.run]
label = "Run"
args = ["run"]

[action.settings]
label = "Settings"
kind = "settings"

[action.toggle]
label = "Enable"
kind = "toggle-config"
config_key = "general.enabled"

[capabilities]
gpui = true
doctor = true

[[shortcuts]]
id = "calendar"
name = "Calendar"
action = "run"

[menu]
label = "Menu Label"
items = []

[daemon]                          # optional
enabled = true
command = "plugin-binary"
socket = "/tmp/qol-plugin.sock"

[[dependencies.binaries]]
name = "plugin-binary"
repo = "owner/plugin-repo"
pattern = "plugin-binary-{os}-{arch}"
```

Action types: `run` (daemon socket or runtime binary), `toggle-config` (flip a
boolean in `config.json` at `config_key`), `settings` (hosted contract panel
when eligible, otherwise the mapped daemon/runtime action). With an enabled
daemon socket the tray sends the action id; it runs `runtime.command` with
`args` (default `[id]`) only when there is no socket or the runtime binary is
not the daemon's. A shortcut runs `action`, default `open`. `[menu] items` is
read only when the manifest declares no `[action.*]`, and a checkbox item is
never shown.

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
`qr_code`, plus `color` against config) are what the native settings host renders
into live, keyboard-navigable controls.

## Daemon protocol

`DaemonResponse::Handled { data: Option<Value> }` carries structured JSON back to
qol-tray; plugins handling **query** actions must populate `data`. The dispatch
layer extracts the payload and returns it to the caller. Plain actions work with
or without a payload.

HTTP surface for the contracts:
- `POST /api/plugins/<id>/actions/<action_name>` - dispatches via the action executor.
- `GET  /api/plugins/<id>/queries/<query_name>` - validates the query exists, dispatches, returns the JSON payload.

## Contract-driven settings rendering

The shared native GPUI settings host renders directly from `qol-config.toml`;
it owns no second schema. On Linux and macOS, a settings action with
a config contract is intercepted by one
tray-owned native settings host. Other platforms and failed host starts
continue through the plugin's mapped settings target.

There is no per-plugin custom-UI path. New settings express their UI through
field kinds; expand the shared contract and the host renderer if a kind is
missing. The host lifecycle, one-window rule, and fallback contract live in
`qol-project:qol-plugin-gpui-surfaces`.

## Contract and delivery rules

- Commands are strict binary basenames (`[A-Za-z0-9_-]+`) - never `.sh`, absolute paths, or traversal.
- When `runtime.actions` is present, every executable menu action requires a mapping (strict coverage).
- Command resolution is symlink-safe: canonicalized targets must stay under the plugin root.
- Dev-mode binary resolution order is **plugin root first, then `target/debug/`, then `target/release/`**. Do not leave stale binaries in the plugin root - they win over a fresh `target/debug/` build.
- In dev mode qol-tray runs `cargo build` directly; a plugin needs a `Cargo.toml`, not a Makefile.
- Plugin reload (`/api/dev/reload`) is single-flight via an `AtomicBool` guard; concurrent requests get `409`. The build runs in `spawn_blocking` so it never blocks axum workers.
- Every plugin must include a contract-validation test that parses `plugin.toml` and calls `manifest.validate()`, with `qol-tray` + `toml` in `[dev-dependencies]`.

## Contracts are honoured to the letter

Every key in `plugin.toml`, `qol-config.toml` and `qol-runtime.toml` must change
what the tray or the plugin does. A key serde drops, a field nothing reads or an
action nothing handles lies to whoever reads the file: a setting that does
nothing, a shortcut that runs nothing, a menu entry that never appears.

The `qol-plugin-contract` hook (qol-project) denies an edit that adds such a key
or removes the code that honoured one, and `qac lint` checks every contract
file in CI. It reads the contract structs (`PluginManifest`, `ConfigSpecV1`,
`RuntimeSpec`) and their serde attributes from the Rust source, so a new field
or rename changes the rule without touching the hook. It checks:

- **Shape**: each key is a field after renames, aliases and `flatten`, each value
  has the field's type, required keys exist and enum names are valid. Under
  `deny_unknown_fields` an unknown key makes the tray refuse the whole file.
- **Reads**: code in `apps/` or `libs/` outside tests reads every field a key
  sets. A key a flattened map swallows passes only when code looks it up by
  name.
- **Dispatch**: each run or settings action reaches the plugin the way the
  tray sends it (above), and the plugin's source or path dependencies mention
  that token, as one literal or two joined. A settings action the native host
  serves (`capabilities.gpui` plus a `qol-config.toml`) needs no token.
- **Targets**: shortcuts name a run or settings action and have unique ids,
  `toggle-config` names a stored field, sections list declared actions, and
  `[config] scope` keys are top-level keys of stored fields.
- **Binaries**: the plugin's `Cargo.toml` builds `runtime.command`,
  `daemon.command` and every `dependencies.binaries` name.
- **Icon**: `plugin.icon` is a `qol_theme` mark name.
- **Doctor**: `capabilities.doctor = true` exactly when the plugin registers
  doctor checks.
- **Menu**: no `[menu] items` beside `[action.*]`, and no checkbox items.
- **Settings**: every stored `qol-config.toml` field binds to a field of a
  plugin `Deserialize` struct that code reads, and the plugin mentions every
  `qol-runtime.toml` action and query.

Edits, and `qac lint --base` in CI, are judged on what they add, so existing
debt never blocks unrelated work. A finding keeps its identity (file, rule and
the key or id it names) while its wording changes, and a second copy of one
counts as added. `qac lint` without a base reports every finding in each
contract file. There is no bypass. Fix the code or delete the key.

Incident (2026-10-20): lights declared `duration_seconds` on a runtime action
the spec has no field for, its stream `throttle_ms` was never read by the
settings host, shot kept a menu checkbox the tray never shows, and the template
shipped settings no code read.

Residual: reads and dispatch match by name. A field read only through a
computed key, a token built from three or more pieces, and a handler that
exists but misbehaves all pass.

## Hotkeys

qol-tray grabs global hotkeys at the X11 level (`src/hotkeys/`), intercepting them
before the window manager. Bindings are profile-scoped across two layers:
`<profile>/core/hotkeys.json` (shared across machines) merged with
`<profile>/os/<os>/hotkeys.json` (OS-specific), read through
`paths::core_hotkeys_path()` and `paths::hotkeys_path()`. Each binding carries
`id`, `key`, `plugin_uid`, `action`, `enabled` (legacy `plugin_id` still read via
serde alias); key/modifier names are defined in
`src/hotkeys/types.rs`. To replace an OS shortcut: disable it in System Settings,
add the binding, restart so qol-tray grabs the key exclusively.

## Cross-platform tray

Platform tray impls live in `src/tray/platform/` (linux: GTK loop on its own
thread; macOS: `NSApplication.run()` on the main thread via objc2; windows:
Condvar blocking). The **one hard host-app invariant**: the macOS tray icon and
`NSApplication.run()` must be created on the main thread, with tokio on a
background thread. Broader Rust platform gotchas → `qol-tray-rust`; the
strategy-pattern methodology that replaces scattered `#[cfg]` → `qol-arch-code`.

## Icon

The tray icon is embedded at compile time from `assets/icon.rgba` (raw RGBA,
generated from `assets/icon.png`). Update the PNG, regenerate the RGBA, rebuild.

## Verification

Run the repo-native build + test first (via `qol`), then the cargo
`-D warnings` stack. The full command set and rules live in `qol-tray-rust`
(Verification) - do not report core work green until they pass.
