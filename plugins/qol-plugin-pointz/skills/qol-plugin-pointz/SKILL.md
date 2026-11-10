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
6. Pairing requests are forwarded to qol-tray, which owns discovery, pairing, and command authentication; see `libs/peers/src/service/pointz/` and `apps/tray/src/features/linked_devices/pointz.rs`. Pairing is SPAKE2 (RFC 9382 on edwards25519, `spake2.rs`, ADR POINTZ-2): the phone proves it knows the 6-digit code without sending it, the desktop draws a fresh secret for every hello, and the device key is sealed with the key the exchange derives. Commands arrive in envelope version 3 (`envelope.rs`, ChaCha20-Poly1305 bound to the version, send time and device id); a device paired before SPAKE2 keeps the version 2 HMAC envelope until it pairs again (`sealed_only` on the device record). The discovery reply tags the schemes (`pair-spake2-v2`, `sealed-v3`) so the phone can tell an older desktop from an older app; bump the tags, `vector.rs` and the phone's vector test together.

The command port answers the phone in two cases, both in `transport.rs`: an authenticated `Ping` command gets a sealed `Pong` naming the ping's nonce and is never forwarded to this plugin, a command that opens with the device key but carries a clock outside the skew window gets a sealed `Rejected` with reason `clock`, and a command from an unknown device gets a clear `Rejected` with reason `unknown_device` and the refused nonce, so a removed phone stops showing connected. A wrong key, a replay and a v2 envelope from a sealed-only device stay silent. Only the unknown-device reply goes to an unauthenticated sender, and it must stay smaller than the datagram it answers. The discovery reply's `status` tag advertises these replies; it is optional on the phone, so adding it needed no change to the required scheme tags.

The UDP ports are defined in `src/config/mod.rs` and reported through the `connection_info` daemon query consumed by `qol-config.toml`. They are not `daemon.extra_ports`; the manifest test asserts that list stays empty. Coordinate protocol changes with the PointZ mobile client.

A settings-page action field (`qol-config.toml` `type = "action"`, such as Pair a phone) runs through the tray's action executor, which refuses any action id that `plugin.toml` does not declare once that manifest lists one action: every such field needs a `[action.<id>]` block with its `args`, as `[action.begin_pairing]` has. `qol-runtime.toml` describes the daemon's actions but does not grant them. A live test with `qol pr try` swaps binaries only, so a manifest change is not on the host until the installed `plugin.toml` carries it.

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

**Change discovery or pairing:** these are owned by qol-tray in `libs/peers/src/service/pointz/` and `apps/tray/src/features/linked_devices/`; this plugin only reports host identity and forwards pairing requests. Keep the mobile wire contract synchronized with the PointZ client: the shared SPAKE2 vector (`vector.rs`, `phone.rs` test client) must stay reproducible on both sides, and the discovery scheme tags change whenever the exchange or the envelope does.

**Change daemon status:** update the daemon response and its corresponding `qol-runtime.toml` query plus `qol-config.toml` consumer.

**Change settings behavior:** keep the host-specific opening logic in `src/qol/`; editable settings belong in `qol-config.toml`.

## Verification

Run the package build, Clippy with warnings denied, tests, and checks for every
platform declared by `plugin.toml`. Cross-check targets from the host when their
Rust targets are installed. If a check stops at a shared-library platform
guard, report that boundary and do not claim plugin support until it is fixed.
