---
name: qol-shot
description: Use when working on the qol-shot screenshot and screen-recording plugin, including capture lifecycle, native overlays, retained GPUI surfaces, output, clipboard, config, and platform adapters.
---

# qol-shot

qol-shot coordinates capture/recording behavior while platform adapters own native selection, display, conversion, clipboard, and overlay details. Exact actions, daemon metadata, platform availability, and tools come from the checked-out manifest/source.

## Contract sources

- `plugin.toml` owns runtime actions, daemon/capability declarations, platform availability, menus, and release artifacts.
- `qol-config.toml` and `qol-runtime.toml` own settings plus named runtime references.
- `Cargo.toml` and build scripts own native/tool dependencies.
- Plugin tests and `qol check` own validation.

Never keep a second action/platform/tool inventory in this skill.

## Source ownership

| Path | Responsibility |
|---|---|
| `src/main.rs`, `src/lib.rs`, `src/cli.rs` | Thin process and command boundary. |
| `src/app/` | Daemon/action orchestration. |
| `src/capture/` | Platform-neutral capture lifecycle, geometry, output, recording/screenshot operations, frozen-frame flow, and completion. |
| `src/config/` | Contract-backed capture settings. |
| `src/platform/` | Target-selected native capture, display, clipboard, selector, conversion, and system integration. |
| `src/platform/macos_swift/` | Swift implementation compiled as part of the macOS adapter. |
| `src/ui/` | GPUI selector, preview, pinned image, capture-status adapter, settings fallback, and shortcuts. Shared transient-surface rendering lives in `qol-gpui`. |

Keep OS implementation files under `platform/<os>/`; keep cross-platform capture policy in `capture/` and UI behavior in `ui/`.

## Capture lifecycle invariants

- Screenshot and recording actions are idempotent and serialize ownership of native capture resources.
- The screenshot thumbnail is the primary post-selection response. Carry only bounded thumbnail pixels into GPUI, then release full-resolution crop/encoding from the preview-presented event; preview failure releases it immediately. Saved/status feedback remains asynchronous, while failures may replace the preview path with shared status UI.
- The daemon record action remains a toggle during its visible countdown. A second invocation aborts the countdown before capture state, processes, or output exist, then reports cancellation through the shared capture-status surface.
- Cancellation, failure, daemon shutdown, and normal completion all remove overlays, release input grabs, and restore desktop state.
- Selection geometry is converted through explicit coordinate spaces; never mix logical, physical, desktop, and display-local coordinates implicitly.
- Output paths are validated and created atomically; clipboard/toast failures do not corrupt a successful capture.
- External process arguments are structured and validated, never shell-concatenated.
- Missing permissions, capture APIs, codecs, or tools produce actionable errors.

## GPUI surface rules

Preview, pinned, and selector surfaces share the qol-gpui surface boundary.
Capture and recording status messages use the shared `Toast` and `ToastHost`;
qol-shot owns only stage policy, semantic tone, safety-barrier invocation, and
trace context. A retained or keepalive window must be compositor-safe,
non-focusable when hidden, absent from Alt-Tab, and never appear as an empty
black/transparent desktop window.

Selector viewport bounds and physical monitor bounds are distinct coordinate
spaces. Every monitor-relative transient uses the shared `qol-gpui` placement
contract with physical monitor bounds, then converts the result to window-local
coordinates when rendering inside an overlay. A spanning selector viewport is
never a monitor.

Use `qol-project:qol-plugin-gpui-surfaces` and `qol-langs:gpui-conventions`; verify cold and retained reveal in the compositor-backed environment.

## Platform work

Source-check the selected adapter before proposing display-server alternatives. Add support by implementing the platform capability and cleanup semantics first, then update `plugin.toml`. Record unsupported substrate work in issues/specs, not a skill TODO section.

## Verification

Run format, build, Clippy with warnings denied, tests, and `cargo run -q -p qol -- check`. Compile every manifest-declared target. Capture, overlay, pin, and cleanup claims require live platform evidence; a compile check is not runtime support.
