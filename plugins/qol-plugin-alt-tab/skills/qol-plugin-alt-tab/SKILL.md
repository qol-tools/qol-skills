---
name: qol-plugin-alt-tab
description: Use when working on the qol-tray alt-tab plugin, including its retained GPUI picker, OS window discovery, preview capture, window actions, daemon lifecycle, config, and shared settings surface.
---

# qol-plugin-alt-tab

Alt Tab replaces the host switcher with a retained GPUI picker. Exact actions, daemon metadata, platform availability, and artifact names come from `plugin.toml`; settings fields come from `qol-config.toml`.

## Contract ownership

- `plugin.toml` owns public action IDs, command arguments, daemon endpoints, menu entries, capabilities, platforms, and release artifacts.
- `qol-config.toml` owns renderer-neutral settings and defaults.
- `Cargo.toml` owns platform dependencies and the package binary name.
- Contract validation is executable through the plugin tests and `qol check`.

Change a public action across the manifest, host binding, daemon parser, and tests together. Never copy the action/platform inventory into this skill.

## Source ownership

| Path | Responsibility |
|---|---|
| `src/main.rs`, `src/daemon.rs` | Thin process boundary and daemon action transport. |
| `src/picker/` | Application lifetime, show dispatch, retained-window creation/reuse, gathering, and monitor updates. |
| `src/app/` | GPUI state, input, live-preview coordination, and rendering. |
| `src/discovery/` | Platform-neutral window metadata plus target-selected enumeration. |
| `src/capture/` | Preview capture capability and target-selected capture implementations. |
| `src/preview_plane/` | Platform-specific live preview plane behavior when used. |
| `src/actions/` | Activate, close, quit, minimize, and other host-window operations behind target adapters. |
| `src/rendering/`, `src/shared/` | Shared preview representation, image lifetime, layout, lanes, and trace structures. |
| `src/config.rs` | Typed settings consumed by the picker. |

Keep target cfg wiring inside feature-owned `platform/mod.rs` files. Picker/app code must call feature boundaries without direct OS selection.

## Retained picker invariants

- GPUI initializes in the long-lived daemon; show actions reuse a retained picker rather than paying cold GPU startup.
- A keepalive surface may retain the application, but it must never appear in Alt-Tab or as an empty desktop window.
- Every show refreshes OS window metadata and reloads config before selection/render decisions.
- Dismissal hides/removes the picker without terminating the daemon.
- Reuse reapplies size, monitor placement, transparency, shadow, focus, and first-frame reveal requirements.
- Image ownership drains through the shared registry on view release; never drop the same GPUI image ID twice.

Follow `qol-project:qol-plugin-gpui-surfaces` and `qol-langs:gpui-conventions` for hosted settings and compositor-safe retained-window reveal.

## Discovery and capture

Discovery returns stable window identity and ordering; capture returns preview content for that identity. Do not merge them merely because a platform API supplies both.

Platform availability is real only when discovery, activation, preview capture or an explicit fallback, retained reveal, and runtime tests all work on that target. A compiling stub is not support.

For blank or stale previews, determine whether the limitation is the compositor/windowing substrate, the chosen capture API, image-lifetime handling, or stale discovery identity. Record evidence from the actual adapter; do not add a timeless “known issues” list.

## Settings ownership

The settings action is hosted by qol-tray when the manifest/config capability contract selects native GPUI settings. The daemon may keep a shared-panel or browser fallback, but it must not create a second bespoke settings implementation. Every renderer reads and writes through the same config API.

## Common changes

**Add a window action:** extend the platform-neutral action boundary and implement every target adapter, returning typed errors for unsupported behavior.

**Change preview behavior:** update capture, shared preview representation, image lifetime, and reuse tests together. Verify cold and retained paths.

**Change selection/input:** keep modifier release, explicit confirmation, blur dismissal, and fast-tap fallback within one state machine. Add transition tests before GPUI event glue.

**Change contract/config:** edit owning TOML and typed consumers together, then run contract validation.

## Verification

Run format, build, Clippy with warnings denied, plugin tests, and `cargo run -q -p qol -- check`. Compile every manifest-declared target. Visual/reveal claims require compositor-backed tests, not the developer desktop.
