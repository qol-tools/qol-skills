---
name: qol-plugin-launcher
description: Use when working on the qol-tray launcher plugin, including retained GPUI behavior, discovery and ranking, launching, daemon activation, hotkey diagnostics, config, and tests.
---

# qol-plugin-launcher

Launcher is a long-lived GPUI search surface activated through qol-tray. The checked-out manifest, source, and tests own its exact features and platform set; this skill owns architectural boundaries and invariants.

## Contract sources

- `plugin.toml` owns the runtime command, public actions, daemon transport, capabilities, platform availability, and release artifacts.
- `qol-config.toml` owns settings fields and defaults.
- `Cargo.toml` owns package/dependency selection.
- The host action executor and launcher daemon parser jointly own activation routing.

When tracing activation, follow the manifest action into qol-tray's action executor, daemon transport, launcher parser, and UI command channel. Derive action names and endpoints from source rather than a copied sequence here.

## Source ownership

| Path | Responsibility |
|---|---|
| `src/main.rs`, `src/lib.rs` | Process boundary and public composition. |
| `src/app/` | Daemon IPC and retained-process command lifecycle. |
| `src/config/` | Typed launcher settings. |
| `src/discovery/` | Entry discovery, indexing/cache, search/ranking, and platform application sources. |
| `src/launch/` | Target-selected execution of a chosen entry. |
| `src/ui/` | GPUI state machine, input, layout, render, retained window host, click-away behavior, keepalive, and trace events. |
| `tests/` | Executable properties for search, navigation, ranking, layout, caches, modifiers, and other pure behavior. |

Keep platform differences inside feature-owned `platform/` modules. Keep ranking/navigation/layout deterministic and testable without GPUI or OS processes.

## Retained surface invariants

- The daemon amortizes GPUI startup and reuses its window host across activations.
- The keepalive surface cannot become focusable, visible in Alt-Tab, or an empty desktop window.
- Each activation reloads the inputs that may have changed and applies monitor placement before reveal.
- Query and selection state reset according to config through one controller transition.
- Blocking discovery/index work never occupies GPUI executor workers.
- Reveal follows the shared compositor-safe surface contract.

## Search and launch invariants

- Discovery produces typed entries; ranking is a pure function over entries, query, config, and stable history inputs.
- File caches are versioned/validated and fail closed to a rescan when corrupt or incompatible.
- Time arithmetic saturates under clock skew; frecency cannot underflow or become negative.
- Property-test generators must actually distinguish query and padding alphabets.
- Launch functions receive structured paths/arguments. Never reconstruct shell command strings for application bundles or user paths.
- Unsupported target behavior returns a typed error from its adapter.

## Hotkey capture boundary

Source-check the selected Linux hotkey backend before diagnosing conflicts. If it uses X11 passive grabs, registration success does not prove delivery: another desktop client may own the same combination. Compare desktop shortcut configuration and process start order, and surface the conflict through doctor diagnostics.

If replacing passive grabs with evdev/uinput:

- Keep device discovery, exclusive grab, virtual-device forwarding, modifier state, hotplug, and cleanup inside a dedicated input capability.
- Route matches through the same host action executor as every other activation.
- Ungrab every device on shutdown and panic; failure can make physical input unavailable until descriptors close.
- Require explicit permissions/udev diagnostics and a fallback path when exclusive input is unavailable.

Doctor diagnostics for this boundary report release-asset versus dev-link provenance, rebuild need, and a detected desktop hotkey owner. Derive registry paths, endpoints, and action IDs from host source.

## Common changes

**Add a discovery source:** implement it behind discovery's platform/source boundary, normalize entries before ranking, and add cache/search properties.

**Change ranking:** write pure examples and properties covering ordering, monotonicity, empty queries, and clock skew before UI integration.

**Change the GPUI window:** verify cold, retained, resized, cross-monitor, blur, and click-away behavior using shared surface traces.

**Change contract/config:** update TOML, typed consumers, daemon routing, and tests together.

## Verification

Run format, build, Clippy with warnings denied, plugin tests, and `cargo run -q -p qol -- check`. Compile every manifest-declared target. Input capture and retained-window claims require live platform evidence.
