---
name: qol-arch-cross-platform
description: >
  Use when adding or refactoring symbols (functions, types, constants, use statements) that *might* be consumed by only one platform's backend, even when the symbol itself looks platform-neutral. Prevents the most common qol-tools cross-platform regression: code that compiles green on Linux but emits dead_code / unused_imports / unused_mut errors on macOS or Windows under `-D warnings`. Triggers on edits to shared modules that border `platform/` directories, on `#[allow(dead_code)]` / `#[allow(unused_mut)]` reaches, on `#[cfg(target_os)]` attributes attached to `use` statements, and any time you find yourself "quieting a lint" on one OS. For the strategy-pattern code layout that this skill builds on, see `qol-arch-code`. For CI-side enforcement that catches the failures across all three OSes, see `qol-arch-cicd`.
---

# qol-arch-cross-platform: Cross-Platform Symbol Hygiene

> Cross-platform warnings are errors: code that compiles green on Linux breaks macOS/Windows under `-D warnings` because `dead_code`, `unused_imports`, and `unused_mut` differ per backend. CI runs `RUSTFLAGS=-D warnings` on every target; this gate is not optional. Full symbol-hygiene patterns and triggers follow.

## Why this skill exists

The `qol-arch-code` skill compartmentalizes platform-specific *bodies* into `platform/{linux,macos,windows}.rs`. That solves the easy half of the problem.

The *hard* half is symbols that look cross-platform but in practice are consumed by only one OS's backend. Those symbols compile clean on the host you're on (because the consumer compiles too), and explode under `-D warnings` on the OS where the consumer is cfg'd out:

- **`dead_code`** — `pub fn`, `pub const`, `pub struct` in a shared module whose only callers live behind `#[cfg(target_os = "linux")]`.
- **`unused_imports`** — `use` statements that pull in symbols only referenced from a cfg-gated function body.
- **`unused_mut`** — function parameters or local bindings that are only mutated in one platform's branch.

The qol-tools commit history is full of these. The `d797294` refactor moved sixteen `dead_code` errors out of macOS-side `qol-tray` builds by relocating a `BindingMatcher` table from the shared `capture/mod.rs` into the linux-only `capture/platform/linux/matcher.rs`. The `33df35d` follow-up flipped a constants module from `pub` to `pub(crate)` to make the linter quiet on a different OS. These are not "lint nits" — they are full red CI builds that block release.

This class of bug is **invisible to single-file static analysis** when looking only at the symbol. You need either (a) cross-module symbol-flow analysis or (b) actually compiling on each platform. The deterministic catch lives in `qol-arch-cicd`'s matrix build. This skill catches the *patterns that produce them* at edit time, before they reach CI.

## Hard rules

### 1. No `#[allow(dead_code)]` outside `platform/`

If a symbol is dead on macOS or Windows, the answer is **not** `#[allow(dead_code)]`. The answer is to either:

- **Move it.** Relocate the symbol into the platform module that actually consumes it (the `d797294` move).
- **Gate it.** Add `#[cfg(target_os = "linux")]` to the symbol so it doesn't exist on the OSes where it has no consumer. The hook permits this on `mod`/`pub use` re-export lines (the canonical pattern from `qol-arch-code`); for non-mod cfg gates you must restructure (see "Refactor recipe" below).
- **Use it.** If the symbol should be cross-platform but has consumers only under one target adapter, add the missing target consumers.

`#[allow(dead_code)]` says "I know this is dead on some platform but I refuse to fix it." That permission slip outlives the situation that justified it and re-rots into mystery code two refactors later. **The hook blocks it in non-`platform/` files.**

Permitted (the hook allows): `#[allow(dead_code)]` *inside* `platform/<os>.rs` files. Inside an OS impl, `dead_code` may legitimately mean "this stub method exists for trait parity but the host doesn't call it on this OS yet" — a defensible case. Outside `platform/`, the symbol is shared, and dead-on-some-OS is a smell.

### 2. No `#[allow(unused_mut)]` outside `platform/`

Same logic. `unused_mut` on a non-platform symbol means one OS's branch never mutates it. Two honest fixes:

- Restructure so the platform that doesn't mutate doesn't see the binding (move the call into the platform impl).
- Make the mutability conditional via `#[cfg(...)] let mut x` / `#[cfg(...)] let x` — but at that point you're back in cfg-sprawl territory; relocate instead.

The hook blocks `#[allow(unused_mut)]` outside `platform/`.

### 3. No `#[cfg(target_os)]` on `use` statements outside `platform/`

```rust
// ❌ src/foo.rs
#[cfg(target_os = "linux")]
use crate::evdev::KeyState;
```

This pattern is almost always a refactor leftover. Either:

- The `KeyState` consumer in this file is *also* `#[cfg(target_os = "linux")]` — in which case the consumer (and its `use`) belong in `platform/linux.rs`, not here. Move both.
- Or the `use` is genuinely only needed on Linux but other items are cross-platform — split the file.

The hook blocks `#[cfg(target_os = ...)] use ...;` outside `platform/`. Inside `platform/<os>.rs` it's redundant (the file is already OS-gated) but harmless; the hook doesn't fire there.

### 4. Trait method parity: every OS impl must have every method

If `WindowOps::move_to_monitor` exists in `platform/mod.rs`'s trait, then `linux.rs`, `macos.rs`, and `windows.rs` must all `impl WindowOps` with `move_to_monitor`. Stub the unsupported OSes with a typed `Err` return — never `unimplemented!()`, never delete the method from the trait "because only Linux needs it". The trait *is* the contract. Stubs honor the contract.

### 5. No adapter-exclusive helpers in the shared parent

Shared domain types and genuinely shared behavior may be consumed by platform
adapters. A callable whose only non-test consumer is one OS adapter belongs in
that adapter, together with its tests. Do not export a Linux parser or command
helper from the feature `mod.rs` merely so `platform/linux.rs` can import it.
The repository-aware hook checks this parent-to-single-adapter leak.

The compiler enforces this for traits. The skill calls it out so you don't reach for the easy escape ("I'll just gate the trait method on Linux") which produces exactly the dead-code-on-other-OS class this skill exists to prevent.

## Refactor recipe: relocating a leaky shared symbol

When you discover a symbol in a shared module is causing dead_code on another platform (typical CI signal: `unused: KEY_LEFTCTRL` on macOS), do this:

1. **Find every consumer.** `rg "KEY_LEFTCTRL"` across the crate. Note which file each consumer lives in.
2. **Check if all consumers are platform-gated.** If every consumer is in `platform/<os>.rs` or behind `#[cfg(target_os = "<os>")]`, the symbol belongs in that platform's module. Skip to step 4.
3. **If consumers span platforms but only some are gated**, the symbol is genuinely cross-platform — but the OS that doesn't have a consumer needs one (perhaps a stub call). Add it.
4. **Move the symbol.** Cut from the shared file, paste into `platform/<os>.rs` (or a sibling `platform/<os>/<feature>.rs` if the symbol is large enough to warrant). Update its visibility: `pub` → `pub(crate)` or `pub(super)` as tight as possible.
5. **Update `use` statements** in consumers.
6. **Verify.** `RUSTFLAGS="-D warnings" cargo clippy --all-targets --all-features --keep-going` on the host you're on. Then trust CI for the other OSes (or run `make ci-local` if cross-compile toolchains are installed locally — see `qol-arch-cicd`).

Concrete example (the `d797294` pattern):

Before — `src/hotkeys/capture/mod.rs`:

```rust
pub struct BindingMatcher { ... }   // <-- 16 dead_code errors on macOS
pub struct ModifierState { ... }
pub mod keycodes { pub const KEY_LEFTCTRL: u16 = 29; ... }
fn mod_to_key_codes(m: Mod) -> [u16; 2] { ... }
```

After:

```rust
// src/hotkeys/capture/mod.rs — only cross-platform surface
pub use binding::{Binding, parse_combo};
pub use platform::install;

// src/hotkeys/capture/platform/linux/matcher.rs — all of it lives here
pub(super) struct BindingMatcher { ... }
pub(super) struct ModifierState { ... }
pub(super) mod keycodes { pub(crate) const KEY_LEFTCTRL: u16 = 29; ... }
fn mod_to_key_codes(m: Mod) -> [u16; 2] { ... }
```

macOS now compiles clean — there's nothing for it to find dead.

## Anti-patterns (the hook blocks these)

```rust
// ❌ src/foo.rs (not under platform/)
#[allow(dead_code)]
pub fn parse_evdev_event(...) -> Event { ... }
```

```rust
// ❌ src/foo.rs (not under platform/)
#[allow(unused_mut)]
fn collect_diagnoses(mut diags: Vec<Diag>) -> Vec<Diag> { ... }
```

```rust
// ❌ src/foo.rs (not under platform/)
#[cfg(target_os = "linux")]
use crate::evdev::KeyState;
```

```rust
// ❌ shared trait method gated by cfg
pub trait WindowOps {
    fn focus(&self, id: u64) -> Result<()>;
    #[cfg(target_os = "linux")]
    fn move_to_monitor(&self, id: u64, m: usize) -> Result<()>;  // breaks parity
}
```

## Permitted patterns

Inside `src/<feature>/platform/<os>.rs`, ANY of these are fine — the file is already OS-gated:

```rust
#[allow(dead_code)]
pub(crate) fn helper_only_used_on_some_paths() { ... }   // ok inside platform/

#[allow(unused_mut)]
fn macos_stub(mut buf: Vec<u8>) { ... }                  // ok inside platform/
```

In tests/ and examples/, cfg gates are unrestricted — cross-platform tests legitimately need them.

## Bypass

The hook is genuinely bypassable for the rare legitimate case (e.g., a vendored generated file you cannot move):

```bash
# next 1 edit passes
touch .claude/bypass-qol-arch-cross-platform
# next N edits pass
echo 5 > .claude/bypass-qol-arch-cross-platform
```

If you find yourself bypassing more than once a quarter, the rule is wrong, not your edit. File an issue against the skill.

## Sibling skills

- **`qol-arch-code`** — strategy-pattern code layout (`platform/` subfolders, trait + impls). This skill assumes that layout exists.
- **`qol-arch-cicd`** — the matrix build that catches the OS-specific failures this skill tries to prevent at edit time. Belt-and-braces: this skill catches the *patterns*, the matrix catches the *escapes*.
