---
name: qol-plugin-pointz
description: Use when working on the qol-tray PointZ desktop server plugin. Covers daemon IPC, UDP discovery and command transport, status queries, QoL settings integration, and target-specific input injection. Pair with the pointz-client skill when changes touch the mobile-side protocol.
---

# qol-plugin-pointz

PointZ is the desktop daemon for remote mouse and keyboard control from the separate PointZ mobile client. The Rust binary is `pointzerver` and the plugin source is the `plugins/*` directory whose manifest declares `id = "plugin-pointz"`.

## Runtime contract

Treat the plugin manifests as the source of truth:

- `plugin.toml` declares the binary, supported platforms, settings action, daemon socket, and inherited UDP ports.
- `qol-config.toml` declares the status and QR fields rendered by qol-tray.
- `qol-runtime.toml` declares the daemon queries used by those fields.

`src/app/daemon.rs` owns the accepted socket messages and response shapes. Keep
every public action/query identifier synchronized across that dispatcher and
the contract files; inspect them at read time instead of copying the inventory
here.

## Source ownership

| Path | Owner |
|---|---|
| `src/main.rs` | Thin CLI and plugin-action adapter |
| `src/app/` | Long-running orchestration and daemon socket transport |
| `src/command/` | Mobile command model and UDP command service |
| `src/config/` | Shared protocol and input constants |
| `src/discovery/` | Discovery response model and UDP responder |
| `src/input/` | Platform-neutral input facade and command dispatch |
| `src/input/platform/` | Target-selected input implementations and typed-error fallback |
| `src/network/` | Host identity and inherited-or-standalone UDP binding |
| `src/qol/` | qol-tray settings integration |

Keep OS files below `src/input/platform/`; do not move them back beside `input/mod.rs`. Keep qol-tray URLs and action context out of command, discovery, and input domain code.

## Daemon lifecycle

1. qol-tray launches `pointzerver` and provides the daemon socket plus named UDP listeners.
2. `src/app/daemon.rs` starts the shared socket listener. A second process forwards its action to the existing daemon and exits.
3. `src/app/mod.rs` starts the discovery responder and command service.
4. Discovery answers the mobile broadcast with host identity.
5. The command service decodes the mobile JSON model and calls `InputHandler`.
6. `InputHandler` delegates every operation to the target selected in `input/platform/mod.rs`.

The UDP ports are defined in `src/config/mod.rs` and declared as named `daemon.extra_ports` entries in `plugin.toml`. Change both sides together and coordinate protocol changes with the PointZ mobile client.

## Platform input

Each adapter under `src/input/platform/` owns its native substrate, permission
requirements, and error translation. The manifest may claim a platform only
when both the selected input adapter and the shared daemon lifecycle work at
runtime. Verify display-server/session variants explicitly; a target name alone
does not prove every substrate on that OS.

Windows daemon support depends on a Windows host-death watchdog in
`qol-plugin-daemon`; add Windows to the manifest only when that shared boundary
compiles and passes its lifecycle tests. Other targets use the typed-error
fallback. Never replace it with `compile_error!` or `unimplemented!()`.

Keep cfg selection in `src/input/platform/mod.rs`. The input facade and the rest of the plugin must remain free of target selection.

## UDP binding

`network::bind_udp_or_inherit` adopts the listener provided for a named `daemon.extra_ports` entry. When running outside qol-tray, it binds the requested port directly.

The inherited descriptor must be restored, marked non-blocking, and converted to `tokio::net::UdpSocket` in that order. Preserve the regression tests when changing this path.

## Common changes

**Add a mobile command:** extend `command/model.rs`, route it through `InputHandler`, and implement the method consistently across every input platform module.

**Change discovery:** update `discovery/` and keep the mobile request/response contract synchronized with the PointZ client.

**Change daemon status:** update the daemon response and its corresponding `qol-runtime.toml` query plus `qol-config.toml` consumer.

**Change settings behavior:** keep the host-specific opening logic in `src/qol/`; editable settings belong in `qol-config.toml`.

## Verification

Run the package build, Clippy with warnings denied, tests, and checks for every
platform declared by `plugin.toml`. Cross-check targets from the host when their
Rust targets are installed. If a check stops at a shared-library platform
guard, report that boundary and do not claim plugin support until it is fixed.
