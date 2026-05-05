---
name: qol-arch-cicd
description: Use when authoring or modifying CI / release workflows (`.github/workflows/*.yml`) or `Cargo.toml` files in qol-tools repos, especially the reusable workflows in `qol-cicd`. Encodes the cross-platform infrastructure contract that prevents the "compiles on CI today, breaks on release tomorrow" class of failure: matrix builds derived from `plugin.toml` `platforms`, `RUSTFLAGS=-D warnings` everywhere, qol-config sibling-checkout-and-rewrite parity between every workflow that runs `cargo`, conditional dependencies expressed as `[target.'cfg(target_os = ...)'.dependencies]` rather than as cfg gates in source. Triggers on edits to workflow YAML, on changes to `Cargo.toml` `[dependencies]` / `[target...]` sections, on the words "release pipeline", "plugin CI", "matrix build", "RUSTFLAGS". For the code patterns the matrix exists to catch, see `qol-arch-code` and `qol-arch-cross-platform`.
---

# qol-arch-cicd: Cross-Platform CI/CD Infrastructure Contract

## Why this skill exists

The two sibling skills (`qol-arch-code`, `qol-arch-cross-platform`) try to prevent cross-platform breakage at edit time. Static analysis can only see so much. The **deterministic, can't-be-bypassed** catch is **building on every supported OS in CI**.

The qol-tools history shows the cost when this contract slips. v3.10.0 of qol-tray failed release because `qol-tray-release.yml` checked out the source but didn't sibling-checkout `qol-config` and rewrite the path-dep — even though `ci.yml` for the same repo did exactly that. The two workflows had drifted. `cargo deb` failed with `failed to read /home/runner/work/qol-tray/qol-config/Cargo.toml`. The release was blocked, on a release tag, with a green CI behind it.

Plugin CI had a parallel problem: it ran on `ubuntu-latest` only. Plugins declared `platforms = ["linux", "macos"]` in their `plugin.toml`, but macOS was never built. The first time a plugin saw macOS was when a user installed it. That's how `d797294`'s sixteen `dead_code` errors reached `main` — Linux CI couldn't see them, and there was no macOS CI to see them either.

This skill encodes the contract the workflows must satisfy.

## Hard rules

### 1. `RUSTFLAGS=-D warnings` on every `cargo` invocation in CI

Without this, `dead_code`, `unused_imports`, `unused_mut`, and the rest of the cross-platform-leakage-warning family are warnings — and warnings are silently ignored on a CI dashboard. With it, they are errors.

```yaml
# ✅ env on the step (or on the job)
- name: Clippy Lints
  shell: bash
  env:
    RUSTFLAGS: -D warnings
  run: cargo clippy --manifest-path "$CARGO_MANIFEST" --all-targets --all-features --keep-going -- -D warnings
```

The `-- -D warnings` clippy flag handles clippy lints. The `RUSTFLAGS` env handles `rustc` lints (which is where `dead_code` lives). **You need both.** Just `-- -D warnings` to clippy is a common silent gap.

### 2. Plugin CI must matrix on `plugin.toml` `platforms`

The `qol-cicd` reusable plugin workflow (`plugin-ci.yml`) reads `plugin.toml`'s `[plugin] platforms = [...]` and builds a matrix:

| Plugin platform | Runner |
|---|---|
| `linux` | `ubuntu-latest` |
| `macos` | `macos-latest` |
| `windows` | `windows-latest` |

If `platforms` is missing or empty, default to `[ubuntu-latest]` (back-compat). Plugins that genuinely target one OS only get one runner. Plugins that target two get two. No matrix-padding for OSes the plugin doesn't claim — that wastes minutes and trains the team to ignore failed jobs.

**Why this and not "always run the full 3x3 matrix":** macOS runners cost ~10x Linux on GitHub-hosted runners. Padding the matrix with OSes the plugin doesn't claim is rude to the budget and rude to the contributor (red builds on platforms the plugin was never meant to support). Drive matrix from declared intent.

### 3. Workflows that run `cargo` must handle path-dep checkout uniformly

Any qol-tools workflow that runs `cargo build` / `cargo test` / `cargo clippy` / `cargo deb` / `cargo run` against a manifest with `qol-config = { path = "../qol-config" }` (or equivalent sibling-path dep) must:

1. `actions/checkout@v4` of `qol-tools/qol-config` into the sibling path the manifest expects, AND
2. Rewrite the manifest's `path = "../qol-config"` → `path = "qol-config"` (because GitHub checkouts land under the repo workspace dir, not as siblings of it).

The qol-tray `ci.yml` does this. The qol-tray release pipeline did not — that asymmetry caused v3.10.0. **Workflows that diverge on this rule are the bug.** When you add a new workflow that runs `cargo`, copy the rewrite block, don't try to remember.

The plugin `plugin-ci.yml` handles transitivity: when a plugin pulls `qol-tray` as a git dep and qol-tray itself transitively needs `qol-config`, the workflow checks out `qol-tray` and `qol-config` as siblings AND rewrites the plugin's `qol-tray = { git = ... }` to `path = "qol-tray"`. From qol-tray's manifest dir `<plugin>/qol-tray/`, its own `path = "../qol-config"` then resolves to `<plugin>/qol-config/` — which is exactly where the workflow checked it out. Don't break this layout.

### 4. Conditional dependencies belong in `Cargo.toml`, not source

```toml
# ✅ Cargo.toml
[target.'cfg(target_os = "linux")'.dependencies]
x11rb = "0.13"
xkbcommon = "0.7"

[target.'cfg(target_os = "macos")'.dependencies]
objc2 = "0.5"
core-foundation = "0.10"
```

```rust
// ✅ src/platform/linux.rs — uses unconditionally, the cfg gate is in the manifest
use x11rb::connection::Connection;
```

NOT:

```toml
# ❌ Cargo.toml
[dependencies]
x11rb = "0.13"      # pulled on every OS, wasted compile time, possible link failure
```

```rust
// ❌ src/platform/linux.rs
#[cfg(target_os = "linux")]
use x11rb::connection::Connection;   // belongs in Cargo.toml as a target gate
```

Manifest-level `[target...]` gates also keep `cargo metadata`, IDE indexers, and `cargo audit` honest about what's actually needed where.

### 5. `release.yml` and `ci.yml` must agree on the same dependency layout

If `ci.yml` checks out a sibling, runs a Python rewrite, and then `cargo build`s — `release.yml` for the same repo MUST do the same checkout-and-rewrite before its `cargo build`/`cargo deb`/etc. **Symmetry is the rule.** The release pipeline isn't allowed to be lazier than CI, because the release pipeline is *where the lazy version finally fails*.

When you add a new CI step in `ci.yml`, ask: does the corresponding release pipeline need the same step? Usually yes. If no, leave a comment explaining why.

## Anti-patterns (the hook flags these)

```yaml
# ❌ Workflow runs cargo against a manifest with a sibling path-dep but no checkout/rewrite
jobs:
  build:
    steps:
      - uses: actions/checkout@v4
      - run: cargo build       # implodes if Cargo.toml has qol-config = { path = "../qol-config" }
```

```yaml
# ❌ Plugin reusable CI hardcodes runs-on without a matrix
jobs:
  test:
    runs-on: ubuntu-latest    # plugin claims platforms = ["linux", "macos"] but never builds macOS
```

```yaml
# ❌ Cargo invocation without RUSTFLAGS=-D warnings
- run: cargo clippy --manifest-path "$CARGO_MANIFEST" --all-targets -- -D warnings
  # missing env: RUSTFLAGS=-D warnings — clippy is gated, rustc isn't, dead_code slips through
```

```toml
# ❌ Platform-specific dep declared unconditionally
[dependencies]
x11rb = "0.13"     # only used by Linux backend, Cargo pulls it on macOS/Windows too
```

## Verification matrix

For any change to a `qol-cicd` workflow or to a `Cargo.toml`, the change passes when:

- `RUSTFLAGS=-D warnings` is present on every `cargo (build|test|clippy|deb|run)` step that builds qol-tools code.
- Plugin CI's runs-on derives from `plugin.toml` `platforms` (not a hardcoded `ubuntu-latest`).
- Every workflow that runs `cargo` in a repo whose `Cargo.toml` has `path = "../qol-config"` checks out `qol-tools/qol-config` and rewrites the path.
- Platform-only deps (x11rb, objc2, windows-sys, libc-on-linux, etc.) live in `[target.'cfg(target_os = ...)'.dependencies]`, not `[dependencies]`.
- `release.yml` for a repo passes the same checks `ci.yml` for the same repo passes.

## Enforcement: PreToolUse hook

This skill ships with `bin/check-qol-arch-cicd.cjs`, a Node-based PreToolUse hook that runs on Edit/Write/MultiEdit/NotebookEdit of:

- `**/.github/workflows/*.yml` — flags missing `RUSTFLAGS=-D warnings` on `cargo` runs, hardcoded `runs-on: ubuntu-latest` in any reusable plugin workflow that consumes `plugin.toml`, and `cargo` invocations in workflows that lack a sibling `qol-config` checkout when the repo's `Cargo.toml` declares `path = "../qol-config"`.
- `**/Cargo.toml` — flags top-level `[dependencies]` entries for crates that are known to be platform-specific (`x11rb`, `xkbcommon`, `objc2`, `core-foundation`, `windows`, `windows-sys`, `wayland-*`, `cocoa`, `appkit`).

The hook is heuristic, not perfect — workflow YAML can be arbitrarily complex. False positives are bypass-able per the standard pattern. False negatives are caught by the matrix build itself (the deterministic backstop).

```bash
# next 1 edit passes
touch .claude/bypass-qol-arch-cicd
# next N edits pass
echo 5 > .claude/bypass-qol-arch-cicd
```

## `make ci-local`: developer-side parity

The CI matrix lives on GitHub. The same checks should be runnable locally so you don't burn a CI roundtrip per typo. Each first-party Rust repo (qol-tray + every plugin) ships a `make ci-local` target that runs:

1. `cargo fmt --all -- --check`
2. `RUSTFLAGS="-D warnings" cargo clippy --all-targets --all-features --keep-going -- -D warnings`
3. `RUSTFLAGS="-D warnings" cargo test --all-features`
4. *(optional, if rustup target installed)* `cargo check --target x86_64-pc-windows-gnu` and/or `cargo check --target x86_64-apple-darwin`

Step 4 catches a subset of cross-platform breakage without spinning a CI runner. macOS link-time issues (Apple SDK frameworks) won't surface — those still need a real macOS runner — but type-level `dead_code`/`unused_imports`/cfg-mismatch errors will.

`plugin-template` ships the same target, so every new plugin starts with it.

## Sibling skills

- **`qol-arch-code`** — code layout (the strategy pattern). This skill makes sure the layout *gets exercised on every OS in CI*.
- **`qol-arch-cross-platform`** — symbol/import hygiene. This skill is the deterministic backstop when symbol hygiene leaks anyway.
