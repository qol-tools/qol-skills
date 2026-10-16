---
name: qol-plugin-pointz
description: Use when working on the qol-tray PointZ desktop server plugin. Covers daemon IPC, command dispatch, status queries, pairing hand-off to qol-tray, QoL settings integration, and target-specific input injection. Pair with the pointz-client skill when changes touch the mobile-side protocol.
---

# qol-plugin-pointz

PointZ is the desktop daemon for remote mouse and keyboard control from the separate PointZ mobile client. The Rust package and binary are `qol-pointz`, and its manifest declares `id = "qol-pointz"`.

## Runtime contract

Treat the plugin manifests as the source of truth:

- `plugin.toml` declares the binary, supported platforms, settings action, and daemon socket.
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
| `src/app/` | Long-running orchestration, daemon socket transport, and pairing requests |
| `src/command/` | Mobile command model |
| `src/config/` | Shared protocol, port, and input constants |
| `src/firewall/` | Platform-selected firewall rules for the advertised ports |
| `src/input/` | Platform-neutral input facade and command dispatch |
| `src/input/platform/` | Target-selected input implementations and typed-error fallback |
| `src/network/` | Host identity and interface metadata |
| `src/doctor/` | Read-only health checks |
| `src/qol/` | qol-tray settings integration |

Keep OS files below `src/input/platform/`; do not move them back beside `input/mod.rs`. Keep qol-tray URLs and action context out of command, config, and input domain code.

## Daemon lifecycle

1. qol-tray launches `qol-pointz` and provides the daemon socket.
2. `src/app/daemon.rs` starts the shared socket listener. A second process forwards its action to the existing daemon and exits.
3. `src/app/mod.rs` runs the daemon loop and dispatches settings, pairing, and input actions.
4. Input commands decode through `command/model.rs` and call `InputHandler`.
5. `InputHandler` delegates every operation to the target selected in `input/platform/mod.rs`.
6. Pairing requests are forwarded to qol-tray, which owns discovery, pairing, and command authentication; see `libs/peers/src/service/pointz/` and `apps/tray/src/features/linked_devices/pointz.rs`.

The UDP ports are defined in `src/config/mod.rs` and reported through the `connection_info` daemon query consumed by `qol-config.toml`. They are not `daemon.extra_ports`; the manifest test asserts that list stays empty. Coordinate protocol changes with the PointZ mobile client.

## Platform input

Each adapter under `src/input/platform/` owns its native substrate, permission
requirements, and error translation. The manifest may claim a platform only
when both the selected input adapter and the shared daemon lifecycle work at
runtime. Verify display-server/session variants explicitly; a target name alone
does not prove every substrate on that OS.

The manifest already declares Windows. Daemon lifecycle on every platform
relies on the shared host-death watchdog in `qol-runtime`
(`libs/runtime/src/watchdog/`). Targets outside the manifest use the typed-error
fallback. Never replace it with `compile_error!` or `unimplemented!()`.

Keep cfg selection in `src/input/platform/mod.rs`. The input facade and the rest of the plugin must remain free of target selection.

## Host identity

`src/network/mod.rs` resolves the hostname and local interface metadata that the
`connection_info` query reports. Socket binding for discovery and commands lives
in qol-tray, not this plugin, so do not add UDP binding here.

## Common changes

**Add a mobile command:** extend `command/model.rs`, route it through `InputHandler`, and implement the method consistently across every input platform module.

**Change discovery or pairing:** these are owned by qol-tray in `libs/peers/src/service/pointz/` and `apps/tray/src/features/linked_devices/`; this plugin only reports host identity and forwards pairing requests. Keep the mobile wire contract synchronized with the PointZ client.

**Change daemon status:** update the daemon response and its corresponding `qol-runtime.toml` query plus `qol-config.toml` consumer.

**Change settings behavior:** keep the host-specific opening logic in `src/qol/`; editable settings belong in `qol-config.toml`.

## Verification

Run the package build, Clippy with warnings denied, tests, and checks for every
platform declared by `plugin.toml`. Cross-check targets from the host when their
Rust targets are installed. If a check stops at a shared-library platform
guard, report that boundary and do not claim plugin support until it is fixed.
