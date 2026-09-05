---
name: qol-arch-cicd
description: >
  Use when authoring or modifying CI / release workflows (`.github/workflows/*.yml`), `Cargo.toml`, or `Cargo.lock` in the qol-monorepo. Encodes the cross-platform infrastructure contract that prevents CI/release parity failures: platform matrices derived from `plugin.toml` `platforms`, strictness parity between CI and release builds (both `-D warnings` and `--locked`), conditional dependencies expressed as `[target.'cfg(target_os = ...)'.dependencies]` rather than as cfg gates in source. Triggers on edits to workflow YAML, on changes to `Cargo.toml` `[dependencies]` / `[target...]` sections, on a stale or regenerated `Cargo.lock`, and on the words "release pipeline", "plugin CI", "matrix build", "RUSTFLAGS", "lockfile", "--locked". For the code patterns the matrix exists to catch, see `qol-arch-code` and `qol-arch-cross-platform`.
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

### 2. Strictness parity between CI, release, and local builds

CI gates with clippy `--all-targets -- -D warnings`; the release workflows build with `RUSTFLAGS: -D warnings`.
A pipeline that is more lenient than the others hides breakage until the strictest one finally runs - and that one is usually the release.
When you add a workflow that runs `cargo`, match the strictness of the existing ones; when you loosen anything, leave a comment explaining why.

**Lockfile strictness is part of parity.** Release builds pass `--locked` (`.github/scripts/release_candidate.py`), and production installs do too, so every earlier gate must as well.
A `Cargo.toml` that declares a dependency `Cargo.lock` does not record is invisible to a lenient gate: cargo simply rewrites the lockfile and carries on.
Two consequences make that failure expensive rather than merely late - the rewrite dirties the working tree mid-build, which trips the clean-tree gate in `qol install` and in the release identity export, and because the repo commits direct to `main`, a post-merge discovery means `main` is already broken.

Do not mistake `cargo metadata --locked --no-deps` for a freshness check.
`--no-deps` skips dependency resolution and exits 0 against a stale lockfile; only a full resolve (`cargo metadata --locked`) or a `--locked` build detects it.
That exact blind spot let a stale lockfile reach `main` and fail 25 `Versioning` jobs while `CI` stayed green.

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
- Every gate that runs `cargo build` / `test` / `clippy` passes `--locked`, matching the release pipeline, and lockfile freshness is asserted with a full resolve rather than `--no-deps`.
- Platform-only deps live in `[target.'cfg(target_os = ...)'.dependencies]`, not `[dependencies]`.

## Enforcement source

Hook activation is defined by the plugin hook manifest, not by the presence of
`bin/check-qol-arch-cicd.cjs`. Before enabling or changing that checker, compare
its assumptions with the workflow and workspace layout in the checked-out
monorepo and require fixtures for every enforced shape. Never re-enable a
layout-sensitive check merely because the script exists.

## Developer-side parity: `qol check`

There is no `ci-local` equivalent in the `qol` CLI and none is being added. The local parity gate is `qol check`, which covers `cargo fmt --all --check`, clippy over the affected crates with `-D warnings`, cargo tests, the qol-tray UI tests, and the `.github/scripts` release tests.

The only checks the retired `ci-local` target ran that `qol check` does not are the cross-target clippy runs. Run those manually when the toolchains are installed locally:

```bash
cargo clippy --target x86_64-pc-windows-gnu --all-targets --all-features -- -D warnings
cargo clippy --target x86_64-apple-darwin --all-targets --all-features -- -D warnings
```

## Build-script dependency boundaries

Keep foundational build-script helpers outside the `workspace-hack` dependency
chain. Its application-wide feature union can make a small identity emitter wait
for unrelated networking, image, and GPU crates. Declare helper exclusions in
`.config/hakari.toml` under `final-excludes.workspace-members`; retain their
transitive feature contributions for application consumers. Hakari owns dependency
removal through `cargo hakari manage-deps`, and generated manifests and Cargo.lock
must remain current. Do not remove application feature unification wholesale.

The [Hakari configuration contract](https://docs.rs/cargo-hakari/latest/cargo_hakari/config/index.html#final-excludes)
defines these exclusion semantics. Revalidate them when upgrading cargo-hakari or
changing a helper's dependencies. Compare fresh-target builds with identical
profiles and compiler-cache settings, and verify both helper tests and application
builds. Report helper timings separately from whole-workspace improvements.

## Sibling skills

- **`qol-arch-code`** - code layout (the strategy pattern). This skill makes sure the layout *gets exercised on every OS in CI*.
- **`qol-arch-cross-platform`** - symbol/import hygiene. This skill is the deterministic backstop when symbol hygiene leaks anyway.
- **`qol-cicd`** - the workflow inventory itself (what each `.github/workflows/*.yml` does).
