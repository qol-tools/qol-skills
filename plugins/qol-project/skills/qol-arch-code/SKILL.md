---
name: qol-arch-code
description: Use when designing or refactoring Rust plugins/libs that need clean source ownership, cross-platform support, capability-specific backend splits, native GPUI or web UI placement, or headless-first CLI/plugin contracts. Defines plugin source-root hygiene, the ui/ versus src/ui/ boundary, Rust module directory form, strategy-pattern compartmentalization (platform/ subfolders, trait + per-OS impls), capability-local backend boundaries, headless binary layering, mandatory help/doctor commands, and plugin doctor output contracts. Triggers on plugin directory structure, loose files under src/, module file-plus-folder hybrids, native or web UI placement, platform-specific code, multi-OS support, OS-named files, Linux X11/Wayland/compositor splits, headless CLI design, plugin runtime action design, doctor commands, or any time you see #[cfg(target_os)] sprawl. For symbol/import hygiene that prevents dead_code warnings under `-D warnings`, see `qol-arch-cross-platform`. For CI/release workflow contracts that enforce cross-platform builds, see `qol-arch-cicd`.
---

# qol-arch-code: Plugin and Cross-Platform Code Layout

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

## Plugin directory hygiene

The plugin `src/` root is a composition layer, not a dumping ground. New Rust files directly under it are limited to `main.rs`, `lib.rs`, and optional `cli.rs`. Put implementation code under the capability, adapter, or presentation boundary that owns it.

Rules:

- `ui/` at the plugin root is host-served web content: HTML, JavaScript, CSS, and related browser assets discovered by qol-tray.
- `src/ui/` is compiled Rust presentation: GPUI windows, views, panels, toasts, and presentation state. Never swap these two roots.
- A module with children uses `name/mod.rs`. Do not combine `name.rs` with a sibling `name/` directory.
- Keep feature-specific OS code in `src/<capability>/platform/`. Use `src/platform/` only for an OS service genuinely shared by multiple capabilities.
- Do not create catch-all `common/`, `helper(s)/`, or `util(s)/` directories. Name the capability or boundary that owns the code.
- Keep dependency direction inward: entrypoint/adapter -> capability -> platform facade. Presentation may consume capability state; domain code must not depend on GPUI or qol-tray action ids.
- Make layout refactors path-only. Move modules and repair imports first; review behavior changes separately. Preserve stable public paths with facade re-exports when callers depend on them.

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
- `doctor` is read-only by default. Repairs require an explicit flag such as `doctor --fix`.
- `--json` is a global output-mode flag, not a doctor-specific converter. It may appear before or after the command path.
- `--json` is valid only for commands that explicitly register a structured JSON interface.
- Reject `--json` before running a command that does not support structured output.
- `doctor` must support JSON because host doctor aggregation depends on it.
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
<binary> doctor --fix
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

Use this JSON shape for host aggregation:

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

`qol-tray doctor` should be able to invoke each installed plugin's `doctor --json` command and render per-plugin results without hardcoding plugin-specific diagnostic logic in the host.

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

When a feature genuinely cannot work on an OS today (e.g., screen-recorder Linux-only, pointz cursor input), **do not** use `compile_error!` — that breaks cross-compilation, blocks dev on other hosts, and breaks CI matrix builds.

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

The host (qol-tray) decides UX — show "not supported on this platform" toast, hide the menu item, etc. The plugin compiles, clippy passes, tests pass — and unsupported behavior fails gracefully at runtime.

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

## Hard rules

- ❌ **Never add implementation modules directly under a plugin's `src/` root.** New root Rust files are limited to `main.rs`, `lib.rs`, and optional `cli.rs`.
- ❌ **Never represent one Rust module as both `name.rs` and `name/`.** Once it has children, use `name/mod.rs`.
- ❌ **Never mix the two UI roots.** Plugin-root `ui/` is browser content; `src/ui/` is Rust/GPUI presentation.
- ❌ **Never create catch-all source directories** named `common`, `helper(s)`, or `util(s)`. Assign explicit ownership.
- ❌ **Never `compile_error!("only X is supported")`** at module top.
- ❌ **Never sprinkle `#[cfg(target_os = "...")]` in business logic.** If you see more than one cfg per file outside `platform/mod.rs`, refactor.
- ❌ **Never mix platform module forms** in one `platform/` directory. Choose all flat OS files or all OS directory modules.
- ❌ **Never branch on platform identity in business logic.** Runtime OS checks, OS-specific imports, OS command choices, and OS-keyed storage/path routing belong in a facade/resolver/scope store.
- ❌ **Never force distinct capability substrates into `linux.rs`** when they have different contracts. Create a capability-local backend split and have the OS adapter select or use it.
- ❌ **Never have a trait method that exists only on one OS via cfg.** Add it to the trait, stub it on others.
- ❌ **Never return `unimplemented!()` from a stub** — it panics. Return a typed `Err` so the caller can handle it.
- ✅ **Name the backend by capability/substrate** (`x11_snapshot`, `systemd_user`, `dbus_session`, `mqtt_bridge`) when that is the real boundary.
- ✅ **Always provide a stub for every OS,** even if the stub just returns `Err("not supported")`. Code must compile on Linux, macOS, and Windows.

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
5. **Stub the missing OSes.** If linux-only today, add `macos.rs` and `windows.rs` with stub `Platform` structs returning typed errors.
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
- New `name.rs` + `name/` module hybrids. Modules with children use `name/mod.rs`.
- New files under catch-all plugin source directories named `common`, `helper(s)`, or `util(s)`.
- Rust files under plugin-root `ui/`, and browser assets under `src/ui/`.
- `compile_error!(...)` — anywhere.
- `#[cfg(target_os = ...)]` (including `all/any/not(target_os = ...)`) outside the canonical mod.rs re-export pattern (`#[cfg(target_os = "X")] mod X;` or `#[cfg(target_os = "X")] pub use X::Platform;`).
- OS-named files (`linux.rs`, `macos.rs`, `windows.rs`) placed outside a `platform/` directory — these must always live under `platform/` (per-feature or top-level).
- Platform decision signals outside an architecture boundary: `cfg!(target_os)`, `std::env::consts::OS`, OS API imports, OS command dispatch, platform-token branching, or platform-token storage/path routing.

Allowed without challenge:
- Existing legacy root modules and hybrids remain editable so the guard does not freeze plugins awaiting migration. New layout debt is blocked; existing debt should be removed during the next ownership refactor.
- Host-served browser assets under plugin-root `ui/`, and Rust/GPUI code under `src/ui/`.
- OS-named files inside any `platform/` directory — those *are* the OS impl, cfg inside is redundant but harmless.
- Files under `tests/` and `examples/`, or named `*_test.rs` / `*_tests.rs` — cross-platform tests legitimately need cfg gates.
- Main-session and subagent edits are checked the same way.

Bypass for one-off legitimate exceptions (and you should be very sure it's legitimate — usually it isn't):

```bash
# next 1 edit passes
touch .claude/bypass-qol-arch-code
# next N edits pass
echo 5 > .claude/bypass-qol-arch-code
```

The marker is auto-consumed per edit; no cleanup needed.

Implementation: Node.js (`bin/check-qol-arch-code.cjs`) — Claude Code requires Node, so the dependency is free across Linux, macOS, and Windows. Wired through the shared hook launcher in `hooks/hooks.json`, which uses `CLAUDE_PLUGIN_ROOT` when Claude provides it and resolves the installed Codex plugin cache when Codex does not.

## Sibling skills

This skill covers code *layout*. Two sibling skills ship in the same plugin and cover orthogonal aspects of the same overall infrastructure-health story:

- **`qol-arch-cross-platform`** — symbol/import hygiene that catches dead_code-on-other-platform errors under `-D warnings`. The ones that compile on Linux, fail on macOS, and waste a roundtrip in CI to learn about. Hook bans `#[allow(dead_code)]`/`#[allow(unused_mut)]` outside `platform/` (forces honest cfg-gating instead of hiding the symptom) and `#[cfg(target_os)]` on `use` statements (almost always a refactor leftover that becomes `unused_imports`).
- **`qol-arch-cicd`** — the CI/release workflow contract. `RUSTFLAGS=-D warnings` everywhere, plugin CI matrix derived from `plugin.toml` `platforms`, qol-config sibling-checkout-and-rewrite parity between ci.yml and release.yml, conditional deps belong in `[target.'cfg(target_os = ...)'.dependencies]`. Hook lints workflow YAML and Cargo.toml at edit time.

The three skills together cover the loop: prevent it in code (this skill), prevent it from sneaking through symbol-hygiene cracks (`qol-arch-cross-platform`), catch it in CI on every platform when it does (`qol-arch-cicd`).
