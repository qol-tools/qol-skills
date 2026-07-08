---
name: qol-arch-cicd
description: >
  Use when authoring or modifying CI / release workflows (`.github/workflows/*.yml`) or `Cargo.toml` files in the qol-monorepo. Encodes the cross-platform infrastructure contract that prevents the "compiles on CI today, breaks on release tomorrow" class of failure: platform matrices derived from `plugin.toml` `platforms`, warning parity between CI and release builds, conditional dependencies expressed as `[target.'cfg(target_os = ...)'.dependencies]` rather than as cfg gates in source. Triggers on edits to workflow YAML, on changes to `Cargo.toml` `[dependencies]` / `[target...]` sections, on the words "release pipeline", "plugin CI", "matrix build", "RUSTFLAGS". For the code patterns the matrix exists to catch, see `qol-arch-code` and `qol-arch-cross-platform`.
---

# qol-arch-cicd: Cross-Platform CI/CD Infrastructure Contract

## Why this skill exists

The two sibling skills (`qol-arch-code`, `qol-arch-cross-platform`) try to prevent cross-platform breakage at edit time.
Static analysis can only see so much.
The **deterministic, can't-be-bypassed** catch is **building on every supported OS in CI, with warnings denied**.

The pre-monorepo history shows the cost when this slips: a qol-tray release once failed on its tag with green CI behind it because the release workflow had drifted from `ci.yml`, and sixteen `dead_code` errors reached `main` (`d797294`) because plugins declaring `platforms = ["linux", "macos"]` were only ever built on Linux.
The monorepo removed the multi-workflow drift class (one checkout, workspace deps), but platform coverage and warning parity still have to be enforced deliberately.

## Hard rules

### 1. Platform coverage derives from `plugin.toml` `platforms`

Release builds resolve their matrix from the plugin's declared `platforms` (`.github/scripts/plugin_matrix.py`), and CI's affected-crate planning reads the same field.

| Plugin platform | Runner |
|---|---|
| `linux` | `ubuntu-latest` |
| `macos` | `macos-latest` |
| `windows` | `windows-latest` |

No matrix-padding for OSes the plugin doesn't claim - macOS runners cost ~10x Linux, and red builds on platforms a plugin never meant to support train the reader to ignore red.
Never hardcode a runner list for plugin builds; if a plugin's platform set changes, `plugin.toml` is the only place that changes.

### 2. Warning parity between CI, release, and local builds

CI gates with clippy `--all-targets -- -D warnings`; the release workflows build with `RUSTFLAGS: -D warnings`.
A pipeline that is more lenient than the others hides breakage until the strictest one finally runs - and that one is usually the release.
When you add a workflow that runs `cargo`, match the strictness of the existing ones; when you loosen anything, leave a comment explaining why.

### 3. Conditional dependencies belong in `Cargo.toml`, not source

```toml
# ✅ Cargo.toml
[target.'cfg(target_os = "linux")'.dependencies]
x11rb = "0.13"
```

```toml
# ❌ Cargo.toml
[dependencies]
x11rb = "0.13"     # only used by the Linux backend, but Cargo pulls it on macOS/Windows too
```

A platform-specific crate in plain `[dependencies]` compiles everywhere until it doesn't, adds build time on every OS, and defeats the point of the platform matrix.
Known platform-specific crates: `x11rb`, `xkbcommon`, `objc2`, `core-foundation`, `cocoa`, `windows`, `windows-sys`, `wayland-*`.

### 4. Workflows are workspace-shaped

The monorepo builds from a single checkout with workspace path deps; no workflow needs to check out anything else to run `cargo`.
If a workflow change starts adding extra checkouts or manifest rewrites to make `cargo` resolve, the change is fighting the workspace layout - stop and rethink.

## Verification matrix

A change to a workflow or `Cargo.toml` passes when:

- Plugin build matrices derive from `plugin.toml` `platforms`, not a hardcoded runner list.
- The new/edited workflow keeps warning parity with the existing ones (clippy `-D warnings` in CI, `RUSTFLAGS: -D warnings` in release builds).
- Platform-only deps live in `[target.'cfg(target_os = ...)'.dependencies]`, not `[dependencies]`.

## Enforcement: PreToolUse hook (currently dormant)

`bin/check-qol-arch-cicd.cjs` ships with this skill but its workflow checks encode the pre-monorepo layout (sibling checkout-and-rewrite), so it is not active and must not be re-enabled as-is.
The `Cargo.toml` platform-dep check is the part worth reviving; the workflow checks need a redesign against the current pipeline before the gate is re-pointed at `qol-*` paths.

## `make ci-local`: developer-side parity

Crates that ship a `Makefile` expose a `ci-local` target mirroring the CI gate locally:

1. `cargo fmt --all -- --check`
2. `cargo clippy --all-targets --all-features -- -D warnings`
3. `RUSTFLAGS="-D warnings" cargo test --all-features`

`plugin-template` ships the same target, so every new plugin starts with it.

## Sibling skills

- **`qol-arch-code`** - code layout (the strategy pattern). This skill makes sure the layout *gets exercised on every OS in CI*.
- **`qol-arch-cross-platform`** - symbol/import hygiene. This skill is the deterministic backstop when symbol hygiene leaks anyway.
- **`qol-cicd`** - the workflow inventory itself (what each `.github/workflows/*.yml` does).
