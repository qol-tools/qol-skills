---
name: qol-architecture
description: Use when designing or refactoring Rust plugins/libs that need cross-platform support. Defines the strategy-pattern compartmentalization that replaces scattered #[cfg(target_os)] gates and compile_error! fallbacks. Triggers on platform-specific code, multi-OS support, plugin platform modules, or any time you see #[cfg(target_os)] sprawl.
---

# qol-architecture: Cross-Platform Strategy Pattern

## Principle

**Don't sprinkle `#[cfg(target_os)]` through business code.** Compartmentalize platform differences behind a trait or struct facade, with one implementation per OS. Business code calls the platform abstraction; cfg gates exist only at the wiring layer in `mod.rs`.

This makes the codebase:
- Compile on every host (no `compile_error!` blocking macOS devs)
- Easy to verify in CI on a matrix
- Clear about which behavior is genuinely platform-specific vs accidentally so

## Required structure

For any module with platform differences:

```
src/<feature>/
  mod.rs           # Trait definition + cfg-aliased re-export of active impl
  linux.rs         # impl Trait for LinuxImpl
  macos.rs         # impl Trait for MacosImpl  (stub if unsupported)
  windows.rs       # impl Trait for WindowsImpl (stub if unsupported)
```

`mod.rs`:

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

Each `<os>.rs` exports a `pub struct Platform;` and `impl WindowOps for Platform`.

Business code:

```rust
use crate::platform::{Platform, WindowOps};

let p = Platform;
p.focus(window_id)?;
```

**Zero cfg in business code.**

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

- ❌ **Never `compile_error!("only X is supported")`** at module top.
- ❌ **Never sprinkle `#[cfg(target_os = "...")]` in business logic.** If you see more than one cfg per file outside `platform/mod.rs`, refactor.
- ❌ **Never have a trait method that exists only on one OS via cfg.** Add it to the trait, stub it on others.
- ❌ **Never return `unimplemented!()` from a stub** — it panics. Return a typed `Err` so the caller can handle it.
- ✅ **Always provide a stub for every OS,** even if the stub just returns `Err("not supported")`. Code must compile on Linux, macOS, and Windows.

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

Step-by-step migration from cfg-sprawl to strategy pattern:

1. **Identify the platform surface.** Grep for `#[cfg(target_os` and `compile_error!`. List every function/method that has OS-specific behavior.
2. **Group by feature.** Cursor/input, window management, theme detection, etc. Each feature gets a `src/<feature>/` module with `platform/` inside, OR a single top-level `src/platform/` if the surface is small.
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

On the host you're on. CI should run the same on Linux + macOS + Windows runners (qol-cicd is the place to set up the matrix).

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
