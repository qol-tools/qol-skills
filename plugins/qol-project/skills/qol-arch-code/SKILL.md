---
name: qol-arch-code
description: Use when designing or refactoring Rust plugins/libs that need clean source ownership, cross-platform support, capability-specific backend splits, native GPUI or web UI placement, or headless-first CLI/plugin contracts. Defines plugin source-root hygiene, the ui/ versus src/ui/ boundary, Rust module directory form, strategy-pattern compartmentalization (platform/ subfolders, trait + per-OS impls), capability-local backend boundaries, headless binary layering, mandatory help/doctor commands, what a plugin doctor command must report, and plugin doctor output contracts. Triggers on plugin directory structure, loose files under src/, module file-plus-folder hybrids, native or web UI placement, platform-specific code, multi-OS support, OS-named files, Linux X11/Wayland/compositor splits, headless CLI design, plugin runtime action design, doctor commands, output categories (log via `log::`, trace via `qol_runtime::probe!`, command output in `cli` modules; `println!`/`eprintln!`/`dbg!` outside them), or any time you see #[cfg(target_os)] sprawl. For symbol/import hygiene that prevents dead_code warnings under `-D warnings`, see `qol-arch-cross-platform`. For CI/release workflow contracts that enforce cross-platform builds, see `qol-arch-cicd`.
---

# qol-arch-code: Plugin and Cross-Platform Code Layout

For extracting confirmed components from a large module, follow the
[component extraction workflow](references/component-extraction.md). It provides
disjoint lane ownership, a deterministic scope/LOC checker, and preservation
review before the repository verification gate. Use it for structural extraction;
deduplication and behavior changes are separate objectives.

## Principle

**Don't sprinkle `#[cfg(target_os)]` through business code.** Compartmentalize platform differences behind a trait or struct facade, with one implementation per OS unless a specific feature capability has its own backend split. Business code calls the abstraction; cfg gates exist only at the wiring layer in `mod.rs`.

`target_os` is the first question, not automatically the final module boundary. Start from the feature capability. If it only needs OS primitives, keep one OS module form: `platform/linux.rs` inside an all-flat `platform/` directory, or `platform/linux/mod.rs` inside an all-directory `platform/` directory. If that capability must choose between runtime substrates with different contracts, model those as private backends behind the capability facade. The substrate split belongs next to the capability it implements, not as a global Linux taxonomy.

This makes the codebase:
- Compile on every host (no `compile_error!` blocking macOS devs)
- Easy to verify in CI on a matrix
- Clear about which behavior is genuinely platform-specific vs accidentally so

## Headless-first feature shape

Prefer applications and plugins that work as standalone headless tools first. The qol-tray integration should be an adapter over that tool, not where the feature's core behavior lives.

Layer Rust plugins like this:

```
plugin-name/
  ui/                    # optional host-served HTML, JavaScript, and CSS
  src/
    main.rs              # tiny binary entrypoint
    lib.rs               # crate composition and public facade
    cli.rs               # optional argument parsing and command UX
    app/                 # long-running orchestration and daemon transport
    config/              # config model and config-specific actions
    ui/                  # native Rust/GPUI presentation
    <capability>/         # headless domain behavior owned by one capability
      mod.rs
      platform/          # OS strategy owned by that capability
    platform/            # only OS services shared across capabilities
```

The headless layer owns useful behavior: lifecycle, validation, state machines, file planning, domain errors, and testable pure helpers. Adapters own context: CLI args, plugin action ids, host-injected config, tray settings URLs, and user-facing presentation.

For plugins:

- Keep `plugin.toml` runtime actions mapped to CLI/API commands the binary also supports standalone.
- Load host-injected qol config only in the adapter layer; pass typed config into the headless API.
- Keep plugin action names out of domain modules unless they are genuine domain commands.
- Put system UI and OS APIs behind `platform/`; put qol UI URLs and manifest-specific behavior behind a `qol`, `plugin`, or `adapter` module when they are not generally useful CLI behavior.
- Do not force every command into one generic engine. Share primitives such as geometry, path planning, and state parsing; keep different lifecycles as explicit modules.

Good dependency direction:

```text
main.rs -> cli/plugin adapter -> headless feature API -> platform facade
```

Bad dependency direction:

```text
feature logic -> plugin action ids / tray settings / env contract
```

This keeps the tool useful from a terminal, script, test, or future host while still letting qol-tray consume the same API.

## Rust module and directory hygiene

Every crate's `src/` root is a composition layer. Keep public facades and required entrypoints there; place implementation beneath the capability, adapter, or presentation boundary that owns it. The host has the strictest application root: `apps/qol-tray/src/` contains only `main.rs` and `lib.rs`. Plugins allow only `main.rs`, `lib.rs`, and optional `cli.rs` at their source root. Ordinary libraries may keep stable public facade modules at the root, but implementation growth moves behind owned directories.

Rules for every Rust crate:

- A module with children uses `name/mod.rs`. Do not combine `name.rs` with a sibling `name/` directory.
- Within one `platform/` directory, use either flat OS modules or directory-backed OS modules uniformly. Never mix the two forms. When one OS adapter grows a second file, every sibling in that directory converts to the directory form in the same commit, even the ones that stay a single small file.
- Do not create catch-all `common/`, `helper(s)/`, or `util(s)/` source directories. Name the capability or architecture boundary that owns the code.
- Make ownership refactors path-only first. Repair module wiring and stable facade re-exports, verify behavior, and review semantic changes separately.
- Before moving code, derive the inventory from the source tree and module declarations. Do not copy a file list or count into a skill as maintained truth.

## Plugin-specific directory hygiene

The plugin `src/` root is a composition layer, not a dumping ground. New Rust files directly under it are limited to `main.rs`, `lib.rs`, and optional `cli.rs`. Put implementation code under the capability, adapter, or presentation boundary that owns it.

Rules:

- `ui/` at the plugin root is host-served web content: HTML, JavaScript, CSS, and related browser assets discovered by qol-tray.
- `src/ui/` is compiled Rust presentation: GPUI windows, views, panels, toasts, and presentation state. Never swap these two roots.
- Keep feature-specific OS code in `src/<capability>/platform/`. Use `src/platform/` only for an OS service genuinely shared by multiple capabilities.
- Keep dependency direction inward: entrypoint/adapter -> capability -> platform facade. Presentation may consume capability state; domain code must not depend on GPUI or qol-tray action ids.
- Preserve stable public paths with facade re-exports when callers depend on them.

Before changing a grown plugin, inventory direct `src/*.rs` files, native and web UI roots, platform directories, and every `name.rs` + `name/` hybrid. Classify each file by ownership before moving it. The canonical monorepo reference is `docs/plugin-layout.md`.

## Headless CLI contract

Every application/plugin binary is a standalone CLI first. `qol-tray` invokes that CLI; it does not own the feature.

Every binary must support:

```text
<binary> help
<binary> help <command-path>
<binary> <command-path> help
<binary> doctor
<binary> --json doctor
<binary> doctor --json
```

Rules:

- `help` is a real command, not only `--help`. `--help` may alias to `help`.
- `help` may appear as the first token for general/lookup help or as the final token for contextual help.
- `help <command-path>` and `<command-path> help` are equivalent.
- `help` in the middle of a command path is invalid. Reject it with guidance instead of guessing.
- Contextual help documents command intent, important flags, output behavior, and exit behavior.
- `doctor` is read-only, always. `qol-headless` treats the one token after `doctor` as a check id, so `doctor --fix` fails with ``Unknown doctor check `--fix` `` (`libs/headless/src/lib.rs`, `execute_doctor` and `selected_doctor_checks`). A repair is its own command (`apply_host_fix <fix-id>` is the shipped precedent), and the failing check carries that command in `.with_fix(...)` so the fix travels with the diagnosis.
- `--json` is a global output-mode flag, not a doctor-specific converter. It may appear before or after the command path.
- `--json` is valid only for commands that explicitly register a structured JSON interface.
- Reject `--json` before running a command that does not support structured output.
- `doctor` must support JSON because host doctor aggregation depends on it.
- A plugin that ships `doctor` declares it in its manifest capabilities; that declaration is what makes the host aggregate the plugin. Manifest validation rejects the declaration unless the plugin also declares a standalone `[runtime]` command to invoke.
- Normal human output goes to stdout; diagnostics, progress, and logs go to stderr.
- JSON mode prints parseable JSON to stdout and nothing else to stdout.
- Successful user cancellation (for example pressing Esc during selection) exits `0`; operational failures exit non-zero with an actionable message.

Examples:

```text
<binary> help doctor
<binary> doctor help
<binary> help config show
<binary> config show help
<binary> --json doctor
<binary> doctor --json
```

All are valid. `<binary> config help show` is invalid because `help` is in the middle.

Do not implement `--json` as "serialize whatever happened." A command supports JSON only when it declares a stable structured output contract:

```rust
Command::new("doctor")
    .run_human(run_doctor_human)
    .run_json(run_doctor_json)

Command::new("settings")
    .run_human(open_settings)
```

`qol-headless` owns the output-mode gate and should return a standard unsupported-output error for commands without a JSON handler.

Recommended universal commands:

```text
<binary> version
<binary> doctor
<binary> apply_host_fix <fix-id>
```

Command names should be explicit domain verbs. Host action ids map to CLI commands; they are not the domain model.

Good:

```toml
actions = { record = ["toggle"], settings = ["settings"] }
```

Avoid leaking tray semantics into the feature:

```text
recording.rs -> "tray record action fired"
```

Prefer:

```text
recording.rs -> toggle_recording(config)
```

Config precedence for standalone-capable plugins:

```text
1. explicit CLI flags
2. explicit --config path
3. host-injected qol config, when present
4. standalone user config
5. defaults
```

`doctor` should check at least:

```text
platform_supported
required_binaries
permissions
config_readable
runtime_dirs
external_services
```

`qol-headless` owns the serialized doctor contract - the report, per-check,
per-plugin, and aggregate types plus the status enum. Serialize those types
rather than hand-rolling the payload, and read that module for the
authoritative field set; the shape below only illustrates it:

```json
{
  "plugin_id": "qol-shot",
  "status": "ok|warn|fail",
  "checks": [
    {
      "id": "required_binaries",
      "status": "warn",
      "message": "ffmpeg is missing; non-MOV conversion is unavailable",
      "fix": "Install ffmpeg"
    }
  ]
}
```

`qol-tray doctor` invokes each installed plugin's `doctor --json` command and renders per-plugin results without hardcoding plugin-specific diagnostic logic in the host. The `qol` CLI's `doctor` command is a front door onto that same host aggregate, not a second implementation - keep new diagnostics in the host or the owning plugin so both entry points inherit them.

## Required structure

OS-specific code lives in a `platform/` subfolder. Two valid placements:

**Per-feature** (most common — when the platform surface is specific to one feature):

```
src/<feature>/
  mod.rs                 # feature API; calls platform::Platform
  platform/
    mod.rs               # cfg-aliased re-export of active impl
    linux.rs             # impl Trait for Platform
    macos.rs             # stub if unsupported
    windows.rs           # stub if unsupported
```

**Top-level** (when one platform surface is shared across the crate):

```
src/platform/
  mod.rs                 # cfg-aliased re-export of active impl
  linux.rs               # impl Trait for Platform
  macos.rs               # stub if unsupported
  windows.rs             # stub if unsupported
```

In both cases the OS-named files (`linux.rs`, `macos.rs`, `windows.rs`) sit inside a directory named `platform`. **Don't put OS files directly under a feature dir** — that's how cfg sprawl creeps back in over time. This is the default shape; only add deeper backend structure when a specific capability has genuinely different runtime contracts.

Use exactly one Rust module form per `platform/` directory:

```
platform/
  linux.rs              # flat form: no private OS child modules
  macos.rs
  windows.rs
```

or:

```
platform/
  linux/
    mod.rs              # directory form: OS impls may have private child modules
    x11_window_ops.rs
  macos/
    mod.rs
  windows/
    mod.rs
```

Never mix flat OS files and OS directories in the same `platform/` directory. `platform/linux.rs` next to `platform/linux/` is the worst case, but `linux/mod.rs` next to `macos.rs` is also forbidden. The mixed shape is legal Rust, but forbidden here because it hides ownership and makes future backend splits easy to misread. If the child module is a capability substrate rather than an OS-local helper, put it under the capability's `backends/` directory instead.

`platform/mod.rs`:

```rust
pub trait WindowOps {
    fn focus(&self, id: u64) -> anyhow::Result<()>;
    fn move_to_monitor(&self, id: u64, monitor: usize) -> anyhow::Result<()>;
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
pub use linux::Platform;
#[cfg(target_os = "macos")]
pub use macos::Platform;
#[cfg(target_os = "windows")]
pub use windows::Platform;
```

Each `<os>.rs` exports a `pub struct Platform;` and `impl WindowOps for Platform`. (For trivial single-fn surfaces it's also fine to skip the trait + struct and just `pub(crate) use linux::install;` — see the simpler section below.)

Business code:

```rust
use crate::platform::{Platform, WindowOps};

let p = Platform;
p.focus(window_id)?;
```

**Zero cfg in business code.**

### Simpler shape: free functions + re-export

When the platform surface is a single static method, the trait + Platform struct is overhead. Free functions are an acceptable substitute:

```
src/<feature>/platform/
  mod.rs                 # cfg-aliased re-export of `install` (or whatever)
  linux.rs               # pub(crate) fn install(...) -> Result<()>
  macos.rs               # pub(crate) fn install(...) -> Result<()>  (stub)
  windows.rs             # pub(crate) fn install(...) -> Result<()>  (stub)
```

`mod.rs`:

```rust
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
pub(crate) use linux::install;
#[cfg(target_os = "macos")]
pub(crate) use macos::install;
#[cfg(target_os = "windows")]
pub(crate) use windows::install;
```

Same `platform/` subfolder rule applies. Use this shape when there's no shared mutable state to hang on a Platform struct.

## Capability-specific backends

Do not create a generic `platform/linux/{x11,wayland,...}` tree just because code runs on Linux. Split only inside the capability that owns the differing contract. Normal Linux-only code should stay in the OS module (`platform/linux.rs`, or `platform/linux/mod.rs` when that `platform/` directory uses directory form).

When one capability has multiple runtime substrates, keep the public feature API stable and put the backend split under that capability:

```
src/<feature>/
  mod.rs
  platform/
    mod.rs
    linux.rs          # selects/uses the capability backend when Linux-specific
    macos.rs
    windows.rs
  <capability>/
    mod.rs            # trait/facade, selection, fallback policy
    backends/
      <substrate_a>.rs
      <substrate_b>.rs
```

Examples:

```
src/preview/
  mod.rs
  provider.rs
  providers/
    x11_snapshot.rs
    wayland_portal.rs
    cinnamon_muffin.rs

src/service_control/
  mod.rs
  backends/
    systemd_user.rs
    dbus_session.rs
    process_probe.rs

src/light_bridge/
  mod.rs
  backends/
    zigbee2mqtt.rs
    http_daemon.rs
```

Backend names should describe the real boundary (`x11_snapshot`, `wayland_portal`, `systemd_user`, `mqtt_bridge`), not the OS by itself. Use this split only when contracts differ: lifecycle, permissions, dependencies, trace semantics, failure modes, or fallback behavior. Do not create sub-backends for trivial filename differences.

## Stubs for unsupported OSes

When a feature genuinely cannot work on an OS, **do not** use `compile_error!` — that breaks cross-compilation, blocks dev on other hosts, and breaks CI matrix builds.

Cover Linux, macOS, and Windows in the target-selection facade. Use either a
dedicated OS adapter or an explicitly selected `fallback` / `unsupported`
adapter. Every selected adapter exposes the same callable surface; adding a
callable to one adapter requires adding its real implementation or typed-error
stub to the others before adding the consumer.

Cover **every unlisted target** as well, with the complement cfg. The
linux/macos/windows-only facade compiles nowhere else: on FreeBSD, NetBSD, or
any other target the `Backend`/`Platform` re-export is undefined and the whole
crate fails to build. The house convention (qol-platform, qol-process, qol-fs,
qol-tray paths, window-actions, alt-tab capture) is a named `fallback` (or
`unsupported`) module re-exported under the complement cfg, returning the same
typed errors as the macOS and Windows stubs:

```rust
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
mod fallback;

#[cfg(target_os = "linux")]
pub(crate) use linux::Platform;
#[cfg(target_os = "macos")]
pub(crate) use macos::Platform;
#[cfg(target_os = "windows")]
pub(crate) use windows::Platform;
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
pub(crate) use fallback::Platform;
```

Verify the complement by checking the exotic target locally (`rustup target add
x86_64-unknown-freebsd`, then `cargo check`/`clippy --all-targets` for that
target) — the exotic-target build also exercises the stub paths in dependency
crates, so it catches interface drift the three-OS matrix never sees.

Provide a stub impl that returns a typed error at runtime:

```rust
// platform/macos.rs (stub — feature genuinely unsupported on macOS)
use anyhow::{anyhow, Result};
use crate::platform::WindowOps;

pub struct Platform;

impl WindowOps for Platform {
    fn focus(&self, _id: u64) -> Result<()> {
        Err(anyhow!("plugin-foo: window focus is not implemented on macOS"))
    }
    fn move_to_monitor(&self, _id: u64, _monitor: usize) -> Result<()> {
        Err(anyhow!("plugin-foo: monitor movement is not implemented on macOS"))
    }
}
```

A question the platform could not answer is its own case, never a
success-shaped default. A listing may legitimately return empty, but "no
client installed", "the service did not answer", and "this OS cannot be
inspected" are not "everything is fine": model them as an explicit unknown
variant carrying the reason, and let the caller decide. `DoctorStatus` is
`Ok`, `Warn`, `Fail` only (`libs/headless/src/doctor/contract.rs`), so an
unknown maps to `Warn` naming what could not be read, never to `Ok`. A stub
that answers a health, capability, or readiness question with the healthy
value makes every unsupported host report success forever, which is the
silent failure the mission forbids.

When a fallback guard type (a `ProcessTreeGuard`, lock guard, or similar)
stands in for a real one, mirror the real guard's surface including a no-op
`impl Drop`. Shared code that calls `drop(guard)` to bound a lifetime window is
then a genuine `Drop` invocation on every target, and clippy's
`drop_non_drop` stays quiet under `-D warnings` on the exotic-target build —
otherwise the same `drop()` call that runs real cleanup on Linux is a lint
error on FreeBSD.

## Cross-platform capability libraries

`qol-shared-libs` decides whether a shared library should exist and where it
goes. This section is about its shape once it does, because a capability whose
real implementation exists on one OS will leak that OS into every consumer
unless the boundary is drawn deliberately.

- **Name the library and its modules for the question, not for one platform's
  vocabulary.** A module called `graph/` holding links and channels is PipeWire
  vocabulary in a crate macOS and Windows also compile, and every file above it
  starts reading as Linux code. `health/` asks "is this working"; `platform/`
  knows what a link is.
- **Answer and execute from the same boundary.** When the real operations exist
  only on one OS, expose "which operations does this system offer, in order"
  plus "run this one", and keep the operation opaque to the caller. A consumer
  that matches on operation variants to call them has taken the platform
  knowledge back, and the cfg it avoided returns as a match arm it cannot
  satisfy on another OS.
- **Keep the numbers with the caller.** Bookkeeping generalizes: counters,
  claims, ordering, retry state. Policy does not: cooldowns, caps, budgets,
  and timeouts are the consumer's product decision. A default value for one of
  those inside the library is policy wearing a library's clothes.
- **Put host facts behind probes on the library** (is this OS supported, is the
  client installed, does the service answer, with a typed reason each). That is
  what lets a plugin ship diagnostics with no `platform/` directory and no cfg
  of its own.
- **Put the discriminator in the shared type, filled in by `platform/`.** When
  consumers need to know what kind of thing something is, the kind is a field
  on the shared value, not a prefix a consumer parses out of a host identifier.
  String-matching a host id to learn what something is reconstructs the
  platform branch the facade exists to own.

## Platform-specific dependencies

Conditional dependencies belong in `Cargo.toml`, not the source tree:

```toml
[target.'cfg(target_os = "linux")'.dependencies]
x11rb = "0.13"

[target.'cfg(target_os = "macos")'.dependencies]
objc2 = "0.5"
core-foundation = "0.10"

[target.'cfg(target_os = "windows")'.dependencies]
windows = { version = "0.58", features = ["Win32_UI_WindowsAndMessaging"] }
```

The `<os>.rs` source files use these unconditionally — the cfg gate at the manifest level guarantees they're only compiled when relevant.

## Output: log, trace, command output

Every line a qol process writes belongs to exactly one of three categories. Each category has one way to write it and one place it lands.

| Category | Write it with | Lands in | In `qol dev` |
|---|---|---|---|
| **Log** | `log::error!`, `log::warn!`, `log::info!`, `log::debug!` | qol-tray: its tracing subscriber, which writes stderr and the log file in `qol_log::log_dir()`. Every other process: stderr through `qol_log::init_stderr()`, which the tray relays into its daemon log for plugins. | Logs view, filterable by level and target (the module path). |
| **Trace** | `qol_runtime::probe!` | The trace file (`qol_conventions::TRACE_LOG_PATH`), debug builds only. See `qol-tools:qol-trace`. | Trace view, and `qol trace <target>`. |
| **Command output** | `println!`, `eprintln!`, or `qol_headless` `PlainTextOutput` | The terminal of the person who ran the command. | Nowhere. Commands do not run under `qol dev`. |

The `qol dev` Logs view is a raw capture of the tray's stdout and stderr, with every plugin's stdout and stderr relayed into it. Anything a daemon or plugin prints lands there whether it is a log or not. That is why a daemon never prints: a print carries no level and no target, so it cannot be filtered.

### Log levels

- `error`: an operation someone asked for failed, or state was lost.
- `warn`: something failed and the process recovered, retried or fell back.
- `info`: lifecycle only. Started, ready, listening, stopping.
- `debug`: everything else a developer wants while debugging. Release plugin builds and the tray's default filter hide it.

Do not prefix a message with `[module]`. The target already names the module.

### Where each category may appear

- Log and trace: anywhere.
- Command output, only in these places:
  - a `cli` module: `cli.rs`, `<name>_cli.rs`, or anything under `cli/`, whose first line is `#![allow(clippy::print_stdout, clippy::print_stderr)]` (only the lints it needs);
  - a `tools/` crate, with that allow at the crate root, because the whole crate is a terminal program;
  - a `build` module (`build.rs` or `build/`) that emits `cargo:` directives for build scripts;
  - the tray's `logging/` module and `libs/log/`, which are the log sink itself;
  - `libs/headless/`, which writes plugin CLI output;
  - `examples/` and tests. `clippy.toml` allows prints in tests.
- `dbg!`: nowhere outside tests.

### Rules

- Every process except qol-tray calls `qol_log::init_stderr()` first thing in `main`. Without it every `log::` call in that process is dropped, because `log` discards records until a logger is installed.
- A library never prints. When library code produces something a person should read, it returns it (a `String`, a report, a `Result`) and the calling `cli` module prints it. `host_exec::run_exec` returns `Err(message)`: `qol-tray exec` prints it, and the launcher turns it into a launch error.
- Moving a print into a `cli` module means moving the code that decides what to print, not wrapping the print in a helper called from daemon code.
- `writeln!(std::io::stderr(), ...)` is still a print. The same location rules apply to raw `io::stdout()` and `io::stderr()` handles.

### Enforcement

- **Compiler.** `[workspace.lints.clippy]` in the root `Cargo.toml` sets `print_stdout`, `print_stderr` and `dbg_macro` to `deny`, and every crate opts in with `[lints] workspace = true`. A crate with its own `[lints.clippy]` table (qol-tray, voice, watch, migrations, terminal-sessions) cannot inherit, so it repeats the three lints. CI runs clippy with `-D warnings` on Linux and macOS for every affected crate, so a stray print fails the PR. Windows-only files are not linted in CI; the hook covers them.
- **Edit time, the fastest check.** The `qol-logging` PreToolUse hook rejects an edit before it lands when it adds a print, a raw stdout or stderr handle, or a print allow outside the places above, or a `dbg!` anywhere outside tests. It answers in milliseconds, so an agent never waits for clippy to hear it. There is no bypass: the allowed places are the escape hatch.
- **Shell edits too.** An agent once added `eprintln!` debug probes to `libs/peers` through a `python3` heredoc in Bash, which the edit-time check never saw. The same hook now also runs on Bash. Before the command, it refuses one whose text carries a print into a qol `.rs` file through a write (heredoc, `sed -i`, `perl`, `python`, `node`, `tee`, `patch`, `git apply`, a `>` redirect). After the command, it compares every changed `.rs` file in the repo against its state before the command and tells the agent to remove any print the command added. Debug a runtime flow with `qol_runtime::probe!` or `log::debug!`, never a temporary print. Residual: the after-command check sees only the repo the command started in, and a print written into another repo slips past until clippy runs.

## Hard rules

- ❌ **Never add implementation modules directly under a plugin's `src/` root.** New root Rust files are limited to `main.rs`, `lib.rs`, and optional `cli.rs`.
- ❌ **Never add implementation modules directly under qol-tray's `src/` root.** Only `main.rs` and `lib.rs` belong there.
- ❌ **Never represent one Rust module as both `name.rs` and `name/`.** Once it has children, use `name/mod.rs`.
- ❌ **Never mix the two UI roots.** Plugin-root `ui/` is browser content; `src/ui/` is Rust/GPUI presentation.
- ❌ **Never create catch-all source directories** named `common`, `helper(s)`, or `util(s)`. Assign explicit ownership.
- ❌ **Never `compile_error!("only X is supported")`** at module top.
- ❌ **Never sprinkle `#[cfg(target_os = "...")]` in business logic.** If you see more than one cfg per file outside `platform/mod.rs`, refactor.
- ❌ **Never mix platform module forms** in one `platform/` directory. Choose all flat OS files or all OS directory modules.
- ❌ **Never branch on platform identity in business logic.** Runtime OS checks, OS-specific imports, OS command choices, and OS-keyed storage/path routing belong in a facade/resolver/scope store.
- ❌ **Never force distinct capability substrates into `linux.rs`** when they have different contracts. Create a capability-local backend split and have the OS adapter select or use it.
- ❌ **Never have a trait method that exists only on one OS via cfg.** Add it to the trait, stub it on others.
- ❌ **Never print outside a `cli`, `build` or `tools/` module.** Daemons, plugins and libraries write `log::` or `qol_runtime::probe!`; see "Output: log, trace, command output".
- ❌ **Never return `unimplemented!()` from a stub** — it panics. Return a typed `Err` so the caller can handle it.
- ❌ **Never keep load-bearing state only in a daemon's memory.** A plugin daemon is stopped and restarted at any moment: the host reloads it after a config save, an update replaces it, it crashes. Attempt counters and ownership of a host resource belong in a file under the runtime dir, so a restart does not silently reset them.
- ❌ **Never let two plugins mutate one host resource on intent alone.** There is no plugin-to-plugin channel (`qol-arch-channels`), so "only one of us touches this" is not enforceable by a sentence in a design. Put the neutral contract in `libs/` and give the resource a claim record with an owner and an expiry that the daemon and the standalone CLI both take, so a crashed owner frees it and a terminal command cannot race the daemon.
- ❌ **Never answer a question the platform could not answer with a success value.** See "Stubs for unsupported OSes".
- ✅ **Name the backend by capability/substrate** (`x11_snapshot`, `systemd_user`, `dbus_session`, `mqtt_bridge`) when that is the real boundary.
- ✅ **Always cover every OS and every unlisted target in the facade,** with a dedicated adapter or an explicitly selected fallback. Code must compile on Linux, macOS, and Windows — and on exotic targets via the complement-cfg `fallback`/`unsupported` module (see "Stubs for unsupported OSes").
- ✅ **Keep facade parity,** so each selected adapter exposes the same callable surface. Adapter-private helpers do not belong in the facade; follow `qol-arch-cross-platform` for consumer locality.

## Facade decision points

Platform-specific behavior is broader than `#[cfg(target_os)]`. Any code that chooses a path, backend, command, dependency, or contract branch because the machine is Linux/macOS/Windows is platform behavior.

This includes:

- `cfg!(target_os = "...")`
- `std::env::consts::OS`
- OS API imports such as `core_graphics`, `objc2`, `x11rb`, or `windows::Win32`
- OS launcher commands such as `open`, `osascript`, `xdg-open`, `powershell`, or `cmd.exe`
- platform manifest logic such as `platforms.len() == 1`
- OS-keyed storage such as `profile.join("os").join(current_os)`

Those decisions live in a named architecture boundary: `platform/`, `*facade.rs`, `*strategy.rs`, `*resolver.rs`, `*scope.rs`, or `*scope_store.rs`. Callers use the boundary. They do not reconstruct the branch.

Concrete profile lesson: `core/`, `os/<os>/`, and `device/` are not special to the hook. They are one example of the general rule: OS-keyed storage routing is platform behavior, so it belongs in `ProfileScopeStore` or an equivalent resolver, not in sync/import/plugin-loader business code.

## When to use trait+impls vs simpler shapes

| Shape | Use when |
|---|---|
| `pub trait + Platform struct + impls` | Multi-method, stateful, testable. The default. |
| `pub use <os>::*;` (re-export) | Module-level free functions, all OSes implement same surface. Faster to write but no compile-time enforcement of API parity. Acceptable when stable. |
| `pub fn` per OS gated by cfg in `mod.rs` | Single function with no shared API. Last resort — usually means you should refactor to a trait. |

Re-export pattern (acceptable for simple cases):

```rust
// platform/mod.rs
#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "linux")]
pub use linux::*;
#[cfg(target_os = "macos")]
pub use macos::*;
#[cfg(target_os = "windows")]
pub use windows::*;
```

Each `<os>.rs` exports the same set of public symbols. If they drift, you'll get a compile error on the OS that's missing one — useful but less explicit than a trait.

## Refactoring an existing plugin

First repair ownership without changing behavior:

1. Inventory every direct `src/*.rs` file, both possible UI roots, every `platform/` directory, and every `name.rs` + `name/` hybrid.
2. Classify each implementation file as app orchestration, config, native UI, a named domain capability, or a genuinely shared platform service.
3. Move files into those ownership directories and repair module paths. Convert parent modules with children to `name/mod.rs`.
4. Preserve stable public imports with deliberate re-exports from `lib.rs`; update internal callers to the ownership path.
5. Format, compile, lint, and test the move-only patch before making behavior changes.

Then migrate cfg-sprawl to the strategy pattern:

1. **Identify the platform surface and capability boundary.** Grep for `#[cfg(target_os` and `compile_error!`. List every function/method that has platform-specific behavior, then ask whether the real boundary is OS, a feature capability, a display/windowing substrate, a service/session API, a hardware protocol, or a rendering/capture path.
2. **Group by feature first.** Cursor/input, window management, preview capture, theme detection, service control, protocol bridge, etc. Each feature gets a `src/<feature>/` module with `platform/` inside, OR a single top-level `src/platform/` if the surface is small. If one capability has multiple incompatible substrates, put backends under that capability and let the capability facade or OS adapter select the backend.
3. **Define the trait.** Look at the linux impl (usually the most complete) and write a trait that captures its public methods. Use `Result` for fallible operations.
4. **Move existing OS code into `<os>.rs` files.** Each implements the trait via `impl Trait for Platform`.
5. **Stub the missing OSes.** For a Linux-only capability, add `macos.rs` and `windows.rs` with stub `Platform` structs returning typed errors.
6. **Replace cfg gates in business code.** Import `Platform` from the platform module; call methods. Delete inline cfg blocks.
7. **Verify.** Run `cargo fmt --check`, `cargo clippy --all-targets --all-features --keep-going -- -D warnings`, `cargo build`, `cargo test` on the host you're on. The plugin must now compile on macOS, Linux, and Windows.
8. **Update `plugin.toml` if needed.** If the manifest declares `platforms = ["linux"]`, decide whether that's still correct (the binary now compiles cross-platform but may be runtime-stub on other OSes — keep `platforms = ["linux"]` so the host doesn't offer it where it's non-functional).

## Verification matrix

After refactor, the plugin must satisfy ALL of:

```bash
cargo fmt --check
cargo clippy --all-targets --all-features --keep-going -- -D warnings
cargo build
cargo test
```

On the host you're on. CI should run the same on Linux + macOS + Windows runners (qol-cicd is the place to set up the matrix). Capability backends that cannot all run on one CI host should still have unit tests or mocks for backend selection and fallback behavior.

If any step fails, the refactor isn't done. No "it compiles on linux so we're good" — the whole point is cross-platform.

## Anti-pattern reference: what NOT to do

```rust
// ❌ src/whatever.rs
fn handle(&self) {
    #[cfg(target_os = "linux")]
    self.x11_thing();
    #[cfg(target_os = "macos")]
    self.cocoa_thing();
    #[cfg(target_os = "windows")]
    self.win32_thing();
}
```

```rust
// ❌ src/platform/mod.rs
#[cfg(not(target_os = "linux"))]
compile_error!("only Linux is supported");
```

```rust
// ❌ src/foo.rs
#[cfg(target_os = "linux")]
pub fn do_thing() { /* linux body */ }

#[cfg(target_os = "macos")]
pub fn do_thing() { /* macos body */ }
```

All three should be replaced with the trait+impls pattern above.

## Enforcement: PreToolUse hook

This skill ships with a Claude Code PreToolUse hook (`bin/check-qol-arch-code.cjs`) that blocks Edit/Write/MultiEdit/NotebookEdit operations introducing the violations listed above. Cross-platform checks are active on `*.rs` files under a `qol-*` repo path; plugin-layout checks activate when the nearest crate root contains `plugin.toml`. Specifically blocks:

- New Rust implementation modules directly under a plugin's `src/` root. Only `main.rs`, `lib.rs`, and optional `cli.rs` may be introduced there.
- New `name.rs` + `name/` module hybrids in any Rust crate. Modules with children use `name/mod.rs`.
- Mixed flat and directory-backed OS module forms within one `platform/` directory.
- New files under catch-all Rust source directories named `common`, `helper(s)`, or `util(s)`.
- New Rust implementation modules at the qol-tray source root; only `main.rs` and `lib.rs` are accepted.
- Rust files under plugin-root `ui/`, and browser assets under `src/ui/`.
- `compile_error!(...)` — anywhere.
- `#[cfg(target_os = ...)]` (including `all/any/not(target_os = ...)`) outside the canonical mod.rs re-export pattern (`#[cfg(target_os = "X")] mod X;` or `#[cfg(target_os = "X")] pub use X::Platform;`).
- OS-named files (`linux.rs`, `macos.rs`, `windows.rs`) placed outside a `platform/` directory — these must always live under `platform/` (per-feature or top-level).
- New target-selection facades that omit Linux, macOS, or Windows without selecting an explicit fallback, and callable-surface drift between complete OS adapter sets.
- Platform decision signals outside an architecture boundary: `cfg!(target_os)`, `std::env::consts::OS`, OS API imports, OS command dispatch, platform-token branching, or platform-token storage/path routing.

Allowed without challenge:
- Existing legacy root modules and hybrids remain editable so the guard does not freeze plugins awaiting migration. New layout debt is blocked; existing debt should be removed during the next ownership refactor.
- Host-served browser assets under plugin-root `ui/`, and Rust/GPUI code under `src/ui/`.
- OS-named files inside any `platform/` directory — those *are* the OS impl, cfg inside is redundant but harmless.
- Files under `tests/` and `examples/`, or named `*_test.rs` / `*_tests.rs` — cross-platform tests legitimately need cfg gates.
- Test-gated items anywhere: a `#[cfg(test)]` module, field, block, or item, and anything carrying `#[test]` / `#[tokio::test]` / `#[rstest]`. A platform cfg on a test states which OS the test can run on; that is correct, not OS branching in business logic. The hook evaluates the compiled non-test view of the file.
- Comments. Platform names, `cfg!(target_os = ...)`, and `platforms.len() == 1` written in prose or commented-out code are not platform decisions.
- Non-platform cfg predicates such as `cfg(debug_assertions)` and `cfg(feature = ...)`.
- Platform tokens that never meet a branch: carrying a `platforms` field, or passing `target_os` through to a facade, is not a decision. The composite platform-token signals require the token and the branch/routing to appear together, not merely somewhere in the same file.
- Platform decision signals that the edit did not introduce. The guard reports only signals absent from the file before the edit, so an unrelated edit is not blocked by pre-existing debt. New debt still blocks.
- Main-session and subagent edits are checked the same way.

Bypass for one-off legitimate exceptions (and you should be very sure it's legitimate — usually it isn't):

```bash
# next 1 edit passes
touch .claude/bypass-qol-arch-code
# next N edits pass
echo 5 > .claude/bypass-qol-arch-code
```

The marker is auto-consumed per edit; no cleanup needed.

### Enforcement: design guard

The same hook blocks code that does not follow the Bone and Amber design every qol
surface shares (`qol-project:qol-gpui-theme` is the contract). It mirrors the guard
tests in `libs/theme/tests/theme.rs` at edit time instead of minutes later in CI,
and every block names what to use instead. The rules live in
`bin/qol-design-guard.cjs`.

Native gpui surfaces (`libs/gpui/src`, `apps/tray/src`, `plugins/*/src`):

- Motion is `qol_gpui::motion::animation(Motion::*)`, or `qol_gpui::motion::after_hold(Motion::*, hold)` when it holds before it moves; no `Animation::new`, `.with_easing`, hand easing.
- Hover is `kit.pointable`; no `.hover(` or `group_hover(` outside `kit.rs` and `settings_panel/components/`.
- Text is `.text(TextStyle::…)`; no `.text_size`, `.font_weight`, `.font_family`, `.line_height`. Headings are `kit.heading`, `kit.heading_title` or `SettingsGroupHeader`.
- Keys in hints are a `qol_gpui::Key`, never a string.
- Every non-ASCII character a window draws is in the shipped fonts (the hook reads their cmap tables); anything else is `qol_gpui::icon::icon`.
- Colour comes from the theme (`kit.grounds.*`, `kit.washes.*`, a kit recipe, a semantic hue); no `rgb(0x…)`, `rgba(…)` or `hsla(…)` literal outside `kit.rs`. `rgba(0)` is transparent and allowed.
- Heights of 28 px or more, radii and (in settings scope) spacing sit on the ladders read from `libs/theme/src/lib.rs`; settings scope also bans rem helpers such as `.gap_2()` and local spacing constants.
- Depth comes from the theme: no hand alpha, `BoxShadow`, line width or literal opacity. Chips are `kit.chip`, windows are `kit.window()` and square, every scrolling list ends in `kit.scroll_cue`, a running phrase never ends in an ellipsis, and no surface draws a coloured side line.
- Settings scope composes recipes: no leaf `.bg`, `.text_color`, `.border`, `.rounded` outside the recipe owners, no raw `kit.palette.<field>` beyond the semantic hues, one focus owner, spinners only through the components.

The settings page shape, derived from the core tool pages (Hotkeys, Shortcuts and
Updates all have it; the pre-redesign Linked computers page had none of it). A file
under `apps/tray/src/settings_surface/` that implements `CustomSettingsBreadcrumbs`
must:

- lay its rows out in `settings_list()`, windowed by `visible_range` and closed by `kit.scroll_cue(ScrollSource::Window { .. })`;
- group rows under `SettingsGroupHeader::new(title, Some(colophon), kit)`;
- put values and actions on the right in `settings_value_group()` (`settings_value_text`, `settings_action_affordance`);
- name its keys in `settings_hints` with `SettingsHint::new(Key::…, label)`;
- route keys through `intent(..)` and `escape_step(..)` rather than raw key names.

Web settings page (`apps/tray/ui`, `plugins/*/ui`):

- CSS takes colour from semantic tokens or `rgba(var(--*-rgb), a)`, sizes from `var(--qol-text-*)` or `var(--fs-*)`, fonts from `var(--font-sans|mono|ui|data)`, times from `var(--qol-motion-*)` or `var(--dur-*)`, shadows from `var(--qol-shadow-*)`, and never draws a coloured left border.
- Views under `ui/views/` (the dev gallery excepted) use no static `style="…"`, no bare `<p>`, and no `<h3>` to `<h6>`: a group is a `<section>` whose `.section-header` holds an `<h2>`, and prose is a classed part.

Only violations the edit introduces are reported, counted per rule, so an unrelated
edit to a file with existing debt passes and a second copy of that debt does not.
Tests, examples, `*_tests.rs`, `*.test.js`, `generated-*` files and `vendor/` are
skipped.

To audit a tree, run the guard directly. It exits 1 if any file is flagged:

```bash
node plugins/qol-project/bin/qol-design-guard.cjs <qol-monorepo> apps/tray/src/settings_surface apps/tray/ui/views
```

Bypass one edit with `touch .claude/bypass-qol-design`, or N edits with
`echo N > .claude/bypass-qol-design`.

Implementation: Node.js (`bin/check-qol-arch-code.cjs`) — Claude Code requires Node, so the dependency is free across Linux, macOS, and Windows. Wired through the shared hook launcher in `hooks/hooks.json`, which uses `CLAUDE_PLUGIN_ROOT` when Claude provides it and resolves the installed Codex plugin cache when Codex does not.

### Enforcement: output guard

`bin/check-qol-logging.cjs` enforces "Output: log, trace, command output" at edit time. It counts each signal (`eprintln!`, `eprint!`, `println!`, `print!`, `io::stdout()`, `io::stderr()`, a `clippy::print_*` allow, `dbg!`, a `clippy::dbg_macro` allow) in the production view of the file, with comments and the `#[cfg(test)]` module stripped, and denies the edit when a count goes up outside the places that section allows. Clippy is the backstop for anything written without an Edit or Write tool.

### Enforcement: settings guard

A plugin declares every setting in its `qol-config.toml` and reads its config only through `qol_config::load_plugin_config_from_env_with_contract` (or `load_plugin_config_with_contract`). It never locates, reads or writes its config file itself.

The host owns that file: stored values beat contract defaults, and saves go through the tray. The contract is the one source for the settings panel, validation and defaults, so a hand-rolled read skips contract defaults and drifts from what the panel shows.

`bin/check-qol-arch-code.cjs` enforces this at edit time for production code under a plugin's `src/` (a directory with a `plugin.toml`). It denies an edit that adds any of:

- a contract-less loader: `load_plugin_config`, `load_plugin_config_or`, `load_plugin_config_from_env`
- a raw config file path: `plugin_config_paths`, `plugin_config_paths_from_env`
- the host config tree: `qol_config::config_dir`

Counts are compared before and after the edit, so existing uses (the shot doctor, the monitor legacy path, the memory doctor) only block when they grow. Bypass one edit with `touch .claude/bypass-qol-arch-code`.

Residual: a path built by hand from `HOME` or `XDG_CONFIG_HOME`, or a settings window drawn outside the contract, passes this guard. The per-plugin `validate_contract_defaults_match_type` test catches a config type that drifts from the contract.

### Lint: `qac`

The edit-time hooks only see new violations, so existing debt stays invisible until someone touches the file. `qac lint [path ...]` runs the qol-arch-code, cross-platform, cicd and logging hooks over whole tracked and untracked files (the whole repo when no path is given), counting every violation already there. It never consumes a bypass marker, and it skips `vendor/` and `third_party/`. Each hook exposes `lintFile(path, content)` through `bin/hook-lint-mode.cjs`, so a new filter in any of them is linted too.

Type `qac lint` as a bare prompt (the `hooks/qac-intercept.mjs` typed-verb hook answers with no model turn), run `/qac [path ...]`, or call `node scripts/qac.mjs lint --pretty`. Without `--pretty` it prints JSON; exit 0 is clean, 1 has findings, 2 is a bad verb, 3 is outside a git repository.

While it runs, it writes `$XDG_RUNTIME_DIR/agent-progress/qac.json` (the spool softwords uses), so the claude-statusline bar shows files done out of total and then the finding count for ten seconds. Every run writes a self-contained HTML report to `$XDG_RUNTIME_DIR/qac/<repo>.html`: a filterable list of flagged files beside a code view that highlights each violating line with its note inline, located from the hook's `line N` references or its exported `LOCATORS` patterns (`src/locate.mjs`). `--open` (on for the prompt hook and `/qac`) opens it in the default web browser rather than the `text/html` handler, so the console only gets one summary line.

`qac fix [path ...]` is the fix path. Most findings need a design move (a facade, a moved symbol, a contract field), so no rewrite runs blind: the typed-verb hook lints the paths (by default a batch of the files with the most findings, `FIX_FILE_LIMIT` in `src/qac.mjs`) and passes the findings, their line numbers and each hook's guidance, bypass hints removed, to the current session as context, with the rule to fix in place, never bypass or silence, and re-run `qac lint` on those files. When nothing is found it answers with no model turn. Each file in the report has a Copy fix command button.

## Sibling skills

This skill covers code *layout*. Two sibling skills ship in the same plugin and cover orthogonal aspects of the same overall infrastructure-health story:

- **`qol-arch-cross-platform`** — symbol/import hygiene that catches dead_code-on-other-platform errors under `-D warnings`. The ones that compile on Linux, fail on macOS, and waste a roundtrip in CI to learn about. Hook bans `#[allow(dead_code)]`/`#[allow(unused_mut)]` outside `platform/` (forces honest cfg-gating instead of hiding the symptom) and `#[cfg(target_os)]` on `use` statements (almost always a refactor leftover that becomes `unused_imports`).
- **`qol-arch-cicd`** — the CI/release workflow contract. `RUSTFLAGS=-D warnings` everywhere, plugin CI matrix derived from `plugin.toml` `platforms`, qol-config sibling-checkout-and-rewrite parity between ci.yml and release.yml, conditional deps belong in `[target.'cfg(target_os = ...)'.dependencies]`. Hook lints workflow YAML and Cargo.toml at edit time.

Together, this skill prevents layout drift, `qol-arch-cross-platform` catches symbol-hygiene cracks, and `qol-arch-cicd` catches platform failures in CI.
