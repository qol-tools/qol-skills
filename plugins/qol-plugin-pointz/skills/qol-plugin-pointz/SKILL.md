---
name: qol-plugin-pointz
description: Use when working on the qol-tray PointZ desktop server plugin. Covers daemon IPC, UDP discovery and command transport, status queries, QoL settings integration, and target-specific input injection. Pair with the pointz-client skill when changes touch the mobile-side protocol.
---

# qol-plugin-pointz

PointZ is the desktop daemon for remote mouse and keyboard control from the separate PointZ mobile client. Locate its source through the `plugins/*/plugin.toml` manifest declaring `id = "qol-pointz"`; derive executable names from `runtime.command` and `daemon.command`. Paths below are relative to that plugin.

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
| `src/network/` | Hostname/display metadata and inherited-or-standalone UDP binding |
| `src/security/` | `CommandGate`, server identity, paired-device registry, pairing, authenticated wire envelope, and replay protection |
| `src/qol/` | qol-tray settings integration |

Keep OS files below `src/input/platform/`; do not move them back beside `input/mod.rs`. Keep qol-tray URLs and action context out of command, discovery, and input domain code.

## Daemon lifecycle

1. qol-tray launches the manifest's daemon command and provides the daemon socket plus named UDP listeners.
2. `src/app/daemon.rs` starts the shared socket listener. A second process forwards its action to the existing daemon and exits.
3. `src/app/mod.rs` starts the discovery responder and command service.
4. Discovery answers with display metadata plus `server_id` and pairing state from `CommandGate`; a hostname is not trusted identity.
5. The command service passes the wire envelope through `CommandGate::authenticate` before decoding the command payload and calling `InputHandler`.
6. `InputHandler` delegates every operation to the target selected in `input/platform/mod.rs`.

The UDP ports are defined in `src/config/mod.rs` and declared as named `daemon.extra_ports` entries in `plugin.toml`. Change both sides together and coordinate protocol changes with the PointZ mobile client.

## Security and client/server contract

`src/security/mod.rs` owns `CommandGate`: it holds `ServerIdentity`, the paired-device registry, pairing state, and replay state. `secret.rs` and `registry.rs` own durable identity and paired keys; `wire.rs` owns envelope parsing and MAC verification; `pairing.rs` and `pairing_status.rs` own pairing exchange and status. Preserve timestamp, paired-key, MAC, and replay checks before command payload execution.

Protocol changes span `src/config/mod.rs`, `src/discovery/model.rs`, `src/command/model.rs`, and the security wire/pairing modules. Inspect those sources together with the active client checkout; command JSON alone is not the transport contract. Desktop source evidence does not establish Flutter compatibility.

## Proposed core migration

If the proposed core peer service is delivered, PointZ must cut over in the same usable delivery: gate compatible versions, stop the legacy writer before snapshot, import once under the core writer lock without widening permissions, durably commit state and the migration marker, and prevent legacy restart or reimport. Pairing, discovery, and authentication must then use core's authority. Wire and mobile compatibility are required delivery evidence, not assumed support. Detailed authority: [linked-computers design](../../../../../qol-monorepo/docs/specs/2026-09-27-linked-computers-design.md), “PointZ migration is part of the foundation”. Until implemented, the PointZ owners above remain current.

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

**Add a mobile command:** extend `src/command/model.rs`, preserve the security/client contract above, route the authenticated command through `InputHandler`, and implement the method consistently across every input platform module.

**Change discovery:** update `discovery/` and keep the mobile request/response contract synchronized with the PointZ client.

**Change daemon status:** update the daemon response and its corresponding `qol-runtime.toml` query plus `qol-config.toml` consumer.

**Change settings behavior:** keep the host-specific opening logic in `src/qol/`; editable settings belong in `qol-config.toml`.

## Verification

Run the package build, Clippy with warnings denied, tests, and checks for every
platform declared by `plugin.toml`. Cross-check targets from the host when their
Rust targets are installed. If a check stops at a shared-library platform
guard, report that boundary and do not claim plugin support until it is fixed.
