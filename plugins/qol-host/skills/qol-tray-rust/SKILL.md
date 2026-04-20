---
name: qol-tray-rust
description: Rust backend deep dive for qol-tray — plugin system, daemon supervision, IPC/runtime endpoints, feature modules, shared qol-* crate placement, cross-platform strategy pattern, tokio concurrency and thiserror/anyhow error handling. Use when modifying files under src/plugins/, src/daemon/, src/runtime/, src/features/, src/sync/, src/menu/, src/tray/, src/app/, src/updates/, or src/profile/, or when adding socket/HTTP endpoints, wiring a new feature module, touching Cargo.toml dependencies, deciding whether logic belongs in qol-tray or a shared qol-* crate (qol-plugin-api, qol-platform, qol-config, qol-runtime, qol-search, qol-frecency, qol-color, qol-fx, qol-wasm), or reviewing Rust concurrency and error-handling patterns in qol-tray.
---

# qol-tray Rust Backend Reference

Pairs with the `qol-tray` (cross-platform overview + make commands) and `qol-world-canvas` (UI side of dive targets) skills. This skill focuses on the Rust internals: plugin system, daemon supervision, IPC, feature modules, concurrency and error-handling idioms, and shared-crate placement.

## Layout (`src/`)

- `main.rs`, `lib.rs` — three binaries (`qol-tray`, `qol-tray-install`, `qol-tray-doctor`) share a library facade.
- `app/` — app bootstrap, config resolution, lifecycle orchestration.
- `plugins/` — plugin discovery, loading, contract wiring. Consumes `qol-plugin-api`.
- `daemon/` — per-plugin daemon process management and hot-reload.
- `tray/` — tray icon and menu chrome. Platform-abstracted via `src/tray/platform/{linux,macos,windows}.rs`.
- `menu/` — menu building and action dispatch.
- `features/`, `hotkeys/`, `shortcuts/`, `logs/`, `profile/`, `sync/`, `updates/` — cross-cutting features.
- `runtime/` — IPC endpoints consumed by the UI (`/api/*`).
- `installer/`, `doctor/`, `dev/` — companion binaries.
- `build.rs` — compile-time asset embedding and version stamping only, no runtime logic in disguise.

## Plugin system

Plugins are separate binaries, not dynamic libraries:
- Each plugin is its own Cargo crate (`plugin-*`) with its own daemon process.
- Communicates with the tray via JSON over local socket / HTTP.
- Declares its contract via `qol-plugin-api`: config schema, actions, status, dive targets.
- Opts into hot-reload in dev mode (linked plugins rebuild and restart their daemon on change).

Invariants to preserve when touching plugin-system code:
- **Isolation** — a panic in a plugin must never take down the tray.
- **Hot-reload** — linked plugins detect rebuilds and restart cleanly.
- **Contract versioning** — `qol-plugin-api` is a public surface; keep it backwards-compatible.
- **Dive-target claims** — changes to dive-target registration ripple to the world canvas; coordinate with `qol-world-canvas`.

## Shared qol-* crates

Before adding new functionality directly into qol-tray, check whether it belongs in a shared crate:

| Concern | Crate |
|---|---|
| Plugin-facing API / used by >1 plugin | `qol-plugin-api` |
| OS / platform (filesystem, process, window, input) | `qol-platform` |
| Config schema, validation, migration | `qol-config` |
| Runtime primitives (scheduler, cache, shared state) | `qol-runtime` |
| Fuzzy search | `qol-search` |
| Frecency ranking | `qol-frecency` |
| Color handling | `qol-color` |
| FX / animations | `qol-fx` |
| WASM integration | `qol-wasm` |

If code belongs in a shared lib, put it there. qol-tray should not become a dumping ground for logic other consumers need.

## Cross-platform strategy pattern

Platform-specific behavior lives behind trait-based strategies. Reference: `src/tray/platform/{linux,macos,windows}.rs`.

Rule for new code: do **not** scatter `#[cfg(target_os = "...")]` across feature modules. If a feature needs platform-specific behavior, extract a trait, put adapters in a `platform/` sub-module, and call the trait from the feature.

Existing `#[cfg]` in `main.rs` (macOS lifecycle) is pragmatic legacy — leave it. Target new additions.

## Error handling

- `thiserror` for library-style errors with named variants.
- `anyhow` only at the application boundary (main, CLI parse, top-level request handlers).
- No `.unwrap()` / `.expect()` in production paths. Reserve for tests and genuinely-infallible contexts (literal constants, post-validation state).
- `?` propagation; avoid `match err { ... }` ladders when the pattern is just propagation.
- Map internal errors to friendly messages at the IPC/UI boundary; internal errors stay rich.

## Concurrency

- Tokio for I/O-bound work; `std::thread` for CPU-bound.
- Shared state: prefer `tokio::sync::{mpsc, oneshot, watch}` over `Arc<Mutex<T>>`.
- When `Arc<Mutex<T>>` is unavoidable, keep lock scope narrow — **never** hold a lock across `.await`.
- Cancellation: explicit via `CancellationToken` or dropped senders, never ad-hoc `AtomicBool` flags.
- Track every `tokio::spawn` `JoinHandle`. Detached unbounded tasks are how leaks and zombie daemons happen.

## IPC / runtime endpoints

UI ↔ backend communication lives in `src/runtime/`. When adding an endpoint:
- Define request/response shapes as serde-friendly structs with explicit `#[serde(rename_all = ...)]` if the UI expects a specific casing.
- Keep the handler thin. Business logic belongs in a feature module or shared crate — the runtime layer is transport only.
- Match existing URL/path conventions (`/api/<area>/<resource>`).
- Return structured errors, not stringly-typed ones. Let the serializer render them.

## Feature modules

Each cross-cutting feature (hotkeys, shortcuts, task-runner, logs, profile, sync) is self-contained:
- Public surface is a small facade.
- Internals are private — don't leak internal state types into the facade.
- If a feature grows beyond a single file, extract a sub-module with its own error type and tests.

## Build and release

- `Cargo.toml` version and any peer manifest (e.g., `plugin.toml` for plugins) must stay in lockstep — qol-cicd's version workflow fails on drift.
- Release trigger: a `chore(release): vX.Y.Z` commit subject.
- Feature flags live in `[features]`: `default = []`, `dev = []` unlocks the Developer tab.
- `build.rs` is compile-time only (asset embedding, version stamping).

## Verification

Before marking Rust work complete (unless the user explicitly opts out):

```bash
cargo build --all-targets
cargo clippy --all-targets -- -D warnings
cargo test --all-features
```

Run `cargo fmt -- --check` when you've touched files likely to drift; CI enforces it.

## Review checklist

When reviewing Rust PRs in qol-tray, evaluate in order:
1. **Idiomatic Rust** — `?` over match ladders, iterators over hand-rolled loops, correct borrowing, no stray clones.
2. **Cross-platform** — new platform-specific code behind a trait, no scattered `#[cfg]`.
3. **Error handling** — `thiserror` for libs, `anyhow` at the boundary, no `.unwrap()` in production.
4. **Concurrency safety** — no locks across `.await`, no detached unbounded tasks, no data races.
5. **Deep modules** — hidden complexity behind clean APIs; no shallow wrappers that just forward.
6. **Shared-lib placement** — is this in the right crate? Would another plugin reuse it?
7. **Testability** — pure logic extractable and testable without tokio/platform deps.
