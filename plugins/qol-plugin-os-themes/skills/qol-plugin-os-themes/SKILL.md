---
name: qol-plugin-os-themes
description: Use when working on the qol-tray OS themes plugin. Covers cursor effects, native theme control, daemon lifecycle, target-specific adapters, config contracts, and settings integration.
---

# qol-plugin-os-themes

OS Themes owns reversible desktop appearance behavior and cursor effects. Feature and platform availability comes from the checked-out manifest, adapters, and tests; do not maintain a roadmap or support table in this skill.

## Contract sources

- `plugin.toml` owns actions, daemon metadata, platform availability, and release artifacts.
- `qol-config.toml` owns settings sections, fields, defaults, and action references.
- `qol-runtime.toml` owns the runnable contract referenced by settings.
- `Cargo.toml` owns target-specific native dependencies.

Update referenced action names across the manifest, runtime contract, config contract, and dispatcher together. Run contract validation rather than copying those values here.

## Source ownership

| Path | Responsibility |
|---|---|
| `src/main.rs` | Thin action entrypoint. |
| `src/app/` | Action routing and daemon orchestration. |
| `src/daemon.rs` | Shared daemon lifecycle and socket boundary. |
| `src/config.rs` | Config loading and typed values. |
| `src/cursor/control.rs` | Platform-neutral cursor capability contract. |
| `src/cursor/platform/` | Target-selected cursor implementations and typed-error fallbacks. |
| `src/theme/` | Platform-neutral theme actions. |
| `src/theme/platform/` | Target-selected desktop theme adapters and typed-error fallbacks. |

Keep cfg selection in each capability's `platform/mod.rs`. App/config code must call the capability boundary without target gates.

## Common changes

**Add a cursor effect:** define platform-neutral behavior under `src/cursor/`, implement each supported adapter under `cursor/platform/`, expose settings through `qol-config.toml`, and keep unsupported targets as typed errors.

**Add a theme action:** add the action contract first, implement the capability in `src/theme/`, and preserve the host desktop state needed to reverse the change when the daemon exits.

**Change detection or animation tuning:** edit the config contract and typed config together. Defaults and ranges belong only in `qol-config.toml`; tests should consume or validate that source.

**Expand platform support:** add a real adapter, target-scoped dependencies, and platform verification before changing `plugin.toml`. A compiling stub is not user-facing support.

## Invariants

- Every host mutation is reversible and cleanup runs on normal exit and error paths.
- Native implementations stay behind cursor/theme capability boundaries.
- Unsupported operations return typed errors; never use `compile_error!` or `unimplemented!()`.
- Platform availability is declared only after runtime behavior is verified on that platform.
- Missing permissions or desktop APIs surface as actionable errors.
- Settings are host-rendered from the contract; no plugin-local native settings window.

## Verification

Run format, build, Clippy with warnings denied, tests, and `cargo run -q -p qol -- check`. Compile every manifest-declared target. Runtime appearance claims require evidence from the actual desktop adapter, including cleanup after exit.
