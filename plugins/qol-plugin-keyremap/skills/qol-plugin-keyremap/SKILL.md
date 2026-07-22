---
name: qol-plugin-keyremap
description: Use when working on the qol-tray key remap plugin. Covers config-to-rule resolution, native event interception, per-app policy, hot reload, daemon lifecycle, editor integration, and target adapters.
---

# qol-plugin-keyremap

Key Remap converts declarative config rules into native input-event transformations. `plugin.toml` owns runtime/platform availability, `qol-config.toml` owns rule shapes/defaults, and source/tests own implemented rule semantics.

## Contract ownership

- Never restate the manifest action, platform, daemon, or menu inventory here.
- A config rule kind exists only when contract schema, Rust raw/resolved models, native callback behavior, editor schema/components, and tests agree.
- If config references a named runtime action/query, declare it in `qol-runtime.toml`; otherwise do not add an empty runtime contract.
- Run plugin tests and `qol check` after contract changes.

## Source ownership

| Path | Responsibility |
|---|---|
| `src/main.rs`, `src/daemon.rs` | Process action routing and reload/kill lifecycle. |
| `src/config.rs` | Raw contract-backed configuration. |
| `src/remap.rs` | Validation/resolution into callback-friendly immutable rules and semantic diffs. |
| `src/keycode.rs` | Key name/code translation. |
| `src/platform/mod.rs` | Single target-selection boundary. |
| `src/platform/macos/` | CGEventTap handling and frontmost-app tracking. |
| `src/platform/non_macos.rs` | Typed unsupported-target behavior needed for cross-compilation. |
| `ui/` | Rule editor, schemas, hooks, and persistence. |

Keep native callbacks allocation-light and independent of TOML/UI shapes. Resolve and validate before atomically swapping callback state.

## Daemon lifecycle

1. Load and resolve config before enabling interception.
2. Start the native adapter and socket listener.
3. On reload, build a complete replacement state, report semantic changes, and swap atomically.
4. On kill, error, or shutdown, disable interception and release native resources before removing the socket.

An existing daemon may accept a reload from a second process, but process ownership and cleanup remain single-owner.

## Common changes

**Add a rule kind:** extend contract schema, raw/resolved types, native transformation, editor schema/UI, serialization, and tests in one change.

**Add per-app behavior:** inspect whether each resolved rule carries an explicit target predicate. If policy is only a global exclusion list, restructure around per-rule predicates instead of stacking inverse filters.

**Expand platform support:** implement a real input adapter and permission story, keep target dependencies scoped, verify cleanup, then change `plugin.toml`. A non-target adapter must return typed errors; never use `compile_error!`.

## Native input invariants

- Native callback ownership is explicit; raw-pointer/`Arc::into_raw` lifetimes are paired and tested.
- Reload never exposes partially resolved state to the callback.
- Exclusion/target policy is evaluated from the same frontmost-app snapshot as the event transformation.
- Permission denial is visible and actionable.
- Shutdown cannot leave a tap, grab, or synthetic input device active.
- Dev dependencies require live test references; remove leftovers.

## Verification

Run format, build, Clippy with warnings denied, tests, and `cargo run -q -p qol -- check`. Compile every manifest-declared target plus typed-error fallbacks. Runtime remapping claims require live input and cleanup verification on the adapter platform.
