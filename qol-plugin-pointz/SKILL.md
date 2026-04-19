---
name: qol-plugin-pointz
description: Use when working on the qol-tray pointz desktop server plugin. Covers UDP discovery, TCP command transport, status HTTP API, daemon lifecycle, and platform input injection on Linux/macOS/Windows. Pair with the pointz-client skill when changes touch the mobile-side protocol.
---

# qol-plugin-pointz

Desktop-side daemon for PointZ — the mobile remote-control feature. Lives in the `qol-tools/plugin-pointz` repo. The Rust binary is named `pointzerver` (not `plugin-pointz`) and runs as a long-lived qol-tray daemon. The mobile client is a separate Flutter app — see the `pointz-client` skill.

## Plugin Contract

`plugin.toml`:

- `runtime.command = "pointzerver"`
- `runtime.actions = { settings = ["--action", "settings"] }`
- `[daemon] enabled = true`, `socket = "/tmp/qol-pointz.sock"` (env-overridable via `TMPDIR`)
- `[menu]` exposes one item: `Settings`
- Platforms: `linux`, `macos` (Windows partially compiled — `windows` cargo deps present, but the plugin manifest does not declare windows yet)
- Binary download repo: `qol-tools/pointzerver`, pattern `pointzerver-{os}-{arch}`

`qol-config.toml`:

- Single `[section.service]` with the `settings` action — no editable fields. Settings UI lives in the embedded mobile-friendly status page served by the status server.

There is no `qol-runtime.toml` because there are no named action/query references in `qol-config.toml`.

## Architecture

| File / Dir | Purpose |
|---|---|
| `src/main.rs` | Entry: parses `kill`, `--action <name>`, otherwise starts daemon. CLI is delegated to `daemon::send_*` helpers when an instance is already running. |
| `src/daemon.rs` | Wraps `qol_plugin_api::daemon` with `DaemonConfig { default_socket_name: "qol-pointz.sock", use_tmpdir_env: true, support_replace_existing: false }`. Commands: `Settings`, `Kill`, plus implicit `ping` health check. |
| `src/status_server.rs` | axum HTTP server on `127.0.0.1:45460` exposing `/status` (hostname, IP, ports, app download URL) and `/health`. Permissive CORS — mobile app polls this from the local network. |
| `src/features/discovery/discovery_service.rs` | UDP discovery responder on port `45454`. Listens for `DISCOVER` broadcasts, replies with hostname JSON. Multi-interface support for hotspot discovery. |
| `src/features/command/command_service.rs` | UDP command receiver on port `45455`. Decodes JSON commands and dispatches into the `InputHandler`. |
| `src/input/{macos,unix,windows,other}.rs` | Per-OS input injection. macOS/Linux use `rdev`; Windows uses `windows-rs` `Win32_UI_Input_KeyboardAndMouse`; `other.rs` is a stub. |
| `src/platform/{linux,macos,windows,other}.rs` | Per-OS `open_settings()` — opens the qol-tray UI URL in the default browser/app. |
| `src/domain/` | Transport-agnostic command/config models. |

## Daemon Lifecycle

1. qol-tray launches `pointzerver` at boot (because `daemon.enabled = true`).
2. Daemon binds `/tmp/qol-pointz.sock` (or `$TMPDIR/qol-pointz.sock`). If another instance owns the socket, the new invocation forwards `settings` to the existing daemon and exits.
3. Three concurrent loops run under tokio:
   - **Discovery**: UDP broadcast listener on 45454.
   - **Status server**: axum HTTP on 45460.
   - **Command service**: UDP listener on 45455 driving `InputHandler`.
4. Background thread reads commands from the socket channel: `Settings → platform::open_settings()`, `Kill → cleanup + exit(0)`.
5. `pointzerver kill` from CLI sends `Kill` to the running daemon; `pointzerver --action settings` sends `Settings`.

## Ports

| Port | Protocol | Purpose |
|---|---|---|
| 45454 | UDP | Discovery (mobile broadcasts `DISCOVER`, server replies with hostname) |
| 45455 | UDP | Mouse/keyboard commands (JSON) |
| 45460 | TCP | Status HTTP API (`/status`, `/health`) — used by mobile to fetch hostname/IP and download URL |

The mobile-side protocol is documented in the `pointz-client` skill.

## Common Tasks

**Add a new command type**: extend the JSON enum in `domain/`, add a handler arm in `command_service`, and route into `InputHandler`. Watch for the per-OS input crate API differences — `rdev`'s key codes differ from `windows-rs`.

**Change daemon ports**: defined as constants in `domain/config.rs` (`ServerConfig::DISCOVERY_PORT`, `COMMAND_PORT`) and `status_server.rs` (`STATUS_PORT`). Keep them in lockstep with the mobile client.

**Change settings UI**: there isn't one in this plugin — `open_settings()` shells out to the qol-tray web UI. If you need editable per-plugin fields, add them to `qol-config.toml` and let qol-tray's auto-config render them.

**Mobile client changes**: distinct repo (`qol-tools/pointz`). Use the `pointz-client` skill instead.

## Gotchas

- **`pointzerver` binary symlink** sits in the plugin root next to `Cargo.toml`. Do not commit a stray locally-built `pointzerver` next to it — `qol-tray` resolves binaries plugin-root-first and the stale binary will shadow `target/debug/pointzerver`.
- **`rdev` on Linux requires X11 grabs.** Wayland support is not implemented in `unix.rs` — `rdev` itself does not support it.
- **macOS Accessibility permission** is required for input injection. The plugin does not request it; the user must grant it in System Settings → Privacy & Security → Accessibility.
- **Status server CORS is wide-open** (`Any` origin). That's intentional — the mobile app loads from `https://github.com/qol-tools/pointz/releases/latest` URLs and needs to fetch `/status`. Do not tighten without thinking through the client side.
- **`use_tmpdir_env: true`** means the socket path follows `$TMPDIR` when set. macOS users hit per-user tmpdir paths; Linux users typically get `/tmp`. Do not hardcode `/tmp/qol-pointz.sock` in tests.

## Shared library usage

- `qol-plugin-api::daemon` for the socket protocol (no custom IPC).
- No `qol-config` use today — the contract is bare; if the plugin grows editable settings, switch to `qol_config::load_plugin_config()` and add them to `qol-config.toml`.

## Build / Dev

- `cargo test` validates the contract (every plugin includes the standard `validate_plugin_contract` test).
- No Makefile in this repo. qol-tray uses `cargo build` directly in dev mode.
- Release flow: tag-driven via `qol-cicd`. `pointzerver` binaries publish to `qol-tools/pointzerver` releases.
