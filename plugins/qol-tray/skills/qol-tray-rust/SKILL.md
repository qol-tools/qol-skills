---
name: qol-tray-rust
description: Use when working on qol-tray's Rust backend — plugin system, daemon supervision, hosted settings surfaces, IPC/runtime endpoints, feature modules, shared qol-* crate placement, cross-platform strategy pattern, tokio concurrency and thiserror/anyhow error handling. Use when modifying files under src/plugins/, src/settings_surface/, src/daemon/, src/runtime/, src/features/, src/sync/, src/menu/, src/tray/, src/app/, src/updates/, or src/profile/, or when adding socket/HTTP endpoints, wiring a new feature module, touching Cargo.toml dependencies, deciding whether logic belongs in qol-tray or a shared qol-* crate, or reviewing Rust concurrency and error-handling patterns in qol-tray.
---

# qol-tray Rust Backend Reference

Pairs with the `qol-tray-core` (cross-platform overview + make commands) and `qol-world-canvas` (UI side of dive targets) skills. This skill focuses on the Rust internals: plugin system, daemon supervision, IPC, feature modules, concurrency and error-handling idioms, and shared-crate placement.

## Layout (`src/`)

- `main.rs`, `lib.rs` — three binaries (`qol-tray`, `qol-tray-install`, `qol-tray-doctor`) share a library facade.
- `app/` — app bootstrap, config resolution, lifecycle orchestration.
- `plugins/` — plugin discovery, loading, contract wiring. Consumes `qol-plugin-api`.
- `daemon/` — per-plugin daemon process management and hot-reload.
- `tray/` — tray icon and menu chrome. Platform-abstracted via `src/tray/platform/{linux,macos,windows}.rs`.
- `menu/` — menu building and action dispatch.
- `features/`, `hotkeys/`, `shortcuts/`, `logs/`, `profile/`, `sync/`, `updates/` — cross-cutting features.
- `runtime/` — IPC endpoints consumed by the UI (`/api/*`).
- `settings_surface/` — hidden tray-owned GPUI settings process, singleton activation, and platform fallback routing.
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
| Plugin manifest, capability, and restore contracts | `qol-plugin-api` |
| Resident daemon socket and host-death lifecycle | `qol-plugin-daemon` |
| OS / platform (filesystem, process, window, input) | `qol-platform` |
| Config schema, validation, migration | `qol-config` |
| Native surfaces and contract settings rendering | `qol-gpui` |
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

## Background loops: event-driven, not polled

qol-tray runs as an always-on tray daemon. Its background loops (hotkey listener, daemon supervisors, watchdogs, file watchers, sync pollers) share the user's machine with whatever they are actually doing right now: a game, a build, a render, a meeting.

The contract:

- **Idle cost must be zero.** No CPU, no syscalls, no X / DBus / IPC round-trips while nothing is happening.
- **Block on events, do not poll for them.** Use `crossbeam_channel::select!`, `tokio::select!`, `Receiver::recv()`, `inotify`, `signalfd`, OS-native event APIs.
- **Forbidden pattern:** `loop { try_recv(); try_recv(); thread::sleep(Duration::from_millis(N)); }`. That is busy-waiting at `1000/N` Hz. The fact that it looks lightweight on `top` for an idle desktop does not mean it is free; on a fullscreen 3D game with input exclusivity those wakeups serialize against the game's input loop and produce visible lag.
- **If polling is genuinely required** (no event API exists, or the cost of plumbing one is unjustified) then sleep at least 1 second AND gate the polled work behind "is this needed right now" (e.g. only while a relevant UI surface is open, or only while a daemon socket is known-down).
- **Render-rate intervals (16ms / 60fps) are acceptable only inside an active UI surface.** A 60fps tick that runs while the surface is closed is a bug.
- **Doctor / heal loops** wake on event triggers (`mark_needed`), not on a clock. If you find yourself reaching for `tokio::time::interval` in a doctor path, ask whether the trigger should fire on demand instead.

When reviewing background code, the question is not "is this fast?" but "does this run *at all* when the user is not doing anything?". If yes, redesign.

## Boot path: phases and ordering

Boot runs in three ordered phases; respect the boundary when adding startup work:

1. **Pre-tokio (synchronous, main thread)** — CLI-flag/subcommand handling, logging, install registration, the already-running probe, runtime-dir reset, the migration **pre-flight** (`qol_migrations::run_pre_flight`, which runs *before* housekeeping — housekeeping is cleanup, not "the migrations"), and doctor self-heal.
2. **Tokio multi-thread (`block_on` async init)** — update check, the desktop-state socket, plugin load, profile sync (spawned, non-blocking), the daemon, feature registry, the axum server, hotkey capture, the daemon supervisor, and the post-auth migration pass (`run_post_auth_if_authed`).
3. **Main thread (after init returns)** — `TrayManager::new` then the native OS event loop.

New startup work goes in the phase that matches its dependency, not wherever is convenient. Data migrations are pre-flight (phase 1) or post-auth (phase 2) — never folded into housekeeping.

## Boot path: never block on networked I/O

The tray daemon, plugin loading, and `TrayManager::new` must never `await`
on anything that can hang on a remote service. Specifically forbidden on the
boot path:

- Cloud profile pulls (GitHub Gist roundtrips, etc.)
- Update checks beyond the existing 2s timeout
- Plugin marketplace metadata fetches
- Any HTTP/socket call without a hard short timeout

Wrap remote work in `tokio::spawn` so the daemon comes up immediately and
the network call completes in the background. Reference: `pull_on_launch`
in `src/main.rs` is dispatched via `tokio::spawn` for exactly this reason.

A 15s blocked launch behind a single failing remote call is unacceptable.
If a feature truly cannot proceed without a network result, surface that
as a non-blocking status the user sees, not as a startup stall.

## IPC / runtime endpoints

UI ↔ backend communication lives in `src/runtime/`. When adding an endpoint:
- Define request/response shapes as serde-friendly structs with explicit `#[serde(rename_all = ...)]` if the UI expects a specific casing.
- Keep the handler thin. Business logic belongs in a feature module or shared crate — the runtime layer is transport only.
- Match existing URL/path conventions (`/api/<area>/<resource>`).
- Return structured errors, not stringly-typed ones. Let the serializer render them.

## The three communication channels

IPC mechanisms have distinct roles. Discover the maintained set from the host
routers/listeners and do not conflate their contracts:

1. **axum HTTP** (`127.0.0.1:42700`) — the dashboard, the `qol-tray exec` CLI, and the plugin-store API. The CLI does *not* speak a plugin's socket directly; it POSTs to axum, which dispatches onward.
2. **desktop-state Unix socket** (Unix only) — a one-way feed of monitor/cursor/focus state that plugin daemons and external tools *read*. Never used for action dispatch.
3. **per-plugin Unix socket** (path from each `plugin.toml` `daemon.socket`) — the actual plugin RPC; tray + axum dispatch actions here.

The native settings host's singleton socket is internal qtray process control,
not a fourth host/plugin channel. It only asks the retained GPUI host to
activate a plugin contract. Panel persistence uses the existing config route;
`SettingsRuntime::tray` sends queries and actions through axum and the existing
plugin dispatcher. The hidden host subcommand returns before normal tray boot;
the normal tray stops it during shutdown, while `qol-plugin-daemon` supplies
the abnormal host-death watchdog. See
`qol-project:qol-plugin-gpui-surfaces` for the one-window and fallback
invariants.

**EventBus is broadcast, not a dispatch path.** `EventBus` is a `tokio::sync::broadcast` of `DaemonEvent`s — *outbound* state-change notifications from the daemon to subscribers (tray menu, dashboard SSE). Tray clicks never publish to it. A click flows on the request side (native menu callback → menu router → action executor → one-shot subprocess or plugin socket); the bus only appears on the response side, e.g. the tray re-subscribes to rebuild its menu on `PluginsChanged`. When wiring a feature, ask "is this an outbound state change (bus) or a request dispatch (router/socket)?" — they are never the same edge.

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
