---
name: qol-cicd
description: Use when authoring or modifying CI, versioning, or release workflows in the qol-monorepo (.github/workflows/*.yml, .github/scripts/*), or when a release or version bump does not behave as expected.
---

# qol-cicd

## Scope

All CI/CD lives in the monorepo under `.github/workflows/` and `.github/scripts/`.
There are no shared or reusable workflows in a separate repo; each workflow file is the source of truth for its own behavior.

## Workflow inventory, by role

- `ci.yml` - lint + test on push/PR. Plans affected crates via `.github/scripts/affected_crates.py`, then runs fmt, clippy `-D warnings`, and tests on an ubuntu + macos matrix. Skips itself on version-bump commits.
- `plugin-version.yml` - versioning. Runs on push to main (or dispatch); computes a bump per release unit from conventional-commit history, commits `chore(plugins): bump plugin versions`, and pushes `<id>-vX.Y.Z` tags.
- `release.yml` - plugin releases. Fires on a `<id>-vX.Y.Z` tag; resolves the tag to a crate, derives the platform matrix from that plugin's `plugin.toml` `platforms` via `.github/scripts/plugin_matrix.py`, builds, and publishes assets.
- `qol-tray-release.yml` - host release. Fires on a `qol-tray-vX.Y.Z` tag.
- `release-prune.yml` - scheduled cleanup of old releases.

Release units and tagging rules live in the `qol-tray-release-flow` skill; read it before cutting any release.

## Editing guidance

- The Python release scripts under `.github/scripts/` have tests in `.github/scripts/tests/`; `ci.yml` runs them on every push, and any script change needs a matching test change.
- Pin third-party actions to a commit SHA (the existing workflows all do).
- Keep `RUSTFLAGS`/clippy at `-D warnings` parity with local checks; a workflow that is more lenient than the local gate hides breakage until release time.
- Platform coverage derives from `plugin.toml` `platforms` - never hardcode a runner list for plugin builds.
- Run release pruning sub-daily at a non-zero minute and keep manual dispatch available; weekly cleanup allows bursty versioning to accumulate stale releases for too long.

## Shared build setup and cache contract

`.github/actions/rust-setup/action.yml` owns the toolchain, rust-cache, and
Linux apt dependency steps. Every workflow job that compiles the workspace
calls it with its `cache-key` input; never copy those three steps into a
workflow. Setup only: build commands and verify gates stay in the workflows
and scripts. RUSTFLAGS stays declared per job so warning parity remains
visible in each workflow file.

Cache namespaces are one per (build family, platform). Candidates and releases
of the same unit run the same invocation, so they share a namespace:

| Workflow / job | cache-key |
|---|---|
| ci.yml check (ubuntu, macos) | `ci-${{ matrix.os }}` |
| ci.yml process-windows | `ci-windows-sandbox` |
| plugin-version.yml plugin_candidate / release.yml build | `plugin-release-${{ matrix.target }}` |
| plugin-version.yml qol_tray candidates / qol-tray-release.yml builds | `qol-tray-linux`, `qol-tray-macos` |

Every rust-cache use runs with `save-if: ${{ github.ref == 'refs/heads/main' }}`
so only main-fed jobs save caches. Cache keys embed the shared key, runner,
RUSTFLAGS env hash, and lockfile hash; changing a namespace or RUSTFLAGS
invalidates keys, so batch such changes into one deliberate cold wave.

`.github/scripts/cache_prune.py` (run from release-prune.yml) enforces the
deterministic cache budget: the newest two entries per namespace survive and
anything unaccessed for 14 days is deleted. Script changes ship with matching
tests in `.github/scripts/tests/`.

## Local verification

```bash
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/release.yml"); puts "ok"'
python3 -m unittest discover -s .github/scripts/tests -p 'test_*.py'
```
