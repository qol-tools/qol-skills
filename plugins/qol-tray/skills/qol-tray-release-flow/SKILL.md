---
name: qol-tray-release-flow
description: Use when cutting, tagging, or preparing a release for qol-tray or any plugin release unit in the monorepo, or when release CI does not trigger as expected.
---

# qol-tray-release-flow

This skill defines the release pipeline for `qol-tray` as it lives in the
`qol-monorepo` workspace. `qol-tray` is the host app under `apps/qol-tray`; it
is released as one "release unit" alongside the bundled `plugins/*`.

## 1. Versioning is local, not gated on CI

- The versioner is the repo-local workflow `.github/workflows/plugin-version.yml`
  ("Version and Release Plugins"), which runs `.github/scripts/plugin_version.py`.
  It is NOT a reusable `qol-cicd` workflow.
- It triggers on every `push` to `main` and on `workflow_dispatch`. It does NOT
  wait for `CI` to pass; the two run independently, so a red `CI` run does not
  block a version bump.
- The script computes a bump per release unit from conventional-commit history
  since that unit's last tag (`feat` -> minor, `fix`/`perf` -> patch,
  `!`/`BREAKING CHANGE` -> major), counting only commits that touch the unit's
  package or its workspace dependency closure.

## 2. Release units (plugins + the host)

- Each plugin under `plugins/*` that carries a `plugin.toml` is a release unit.
- The host app `apps/qol-tray` is also a release unit. It has Cargo metadata
  only and NO `plugin.toml`. Never add one - that contaminates plugin semantics.
- To force one unit's release, dispatch `plugin-version.yml` with the
  `plugin_id` input (for the host, `qol-tray`).

## 3. Bump commit and tags

- The versioner stages `Cargo.lock`, `plugins/*/Cargo.toml`,
  `plugins/*/plugin.toml`, and `apps/qol-tray/Cargo.toml`, then commits them as
  the literal message `chore(plugins): bump plugin versions` and pushes.
  `CI`'s plan job skips commits with exactly that prefix.
- It then creates and pushes one tag per released unit:
  `<plugin-id>-vX.Y.Z` for plugins, `qol-tray-vX.Y.Z` for the host.
- The historical `chore(release): vX.Y.Z` and `chore(qol-tray, release): vX.Y.Z`
  formats are pre-monorepo. Do not expect or require them.

## 4. Release trigger (dispatch, because token-pushed tags are inert)

- A tag pushed with the default `GITHUB_TOKEN` does NOT trigger another
  workflow. So the versioner explicitly dispatches the matching release workflow
  per tag:
  - `qol-tray-v*` -> `qol-tray-release.yml` (host release)
  - every other `*-v*` -> `release.yml` (plugin release; its tag-push trigger
    explicitly excludes `qol-tray-v*`)
- Both release workflows also accept a `workflow_dispatch` `tag` input and check
  out `refs/tags/<tag>`; that is the path the dispatch uses.

## 5. Host release logic and artifacts

- `qol-tray-release.yml` is self-contained in the monorepo. It is NOT a thin
  caller to `qol-cicd`.
- Linux: a `.deb` (cargo-deb) plus `qol-tray-linux-<arch>.tar.gz`.
- macOS: a universal (aarch64 + x86_64) `.app` bundle, ad-hoc codesigned
  (`codesign --sign -`), shipped as `qol-tray-macos-universal.tar.gz`. macOS is
  always built; there is no Apple-signing-secret gate and no `.dmg`.
- A final job publishes a GitHub Release for the tag with generated notes.

## 6. Operator notes

- Versioning is Cargo-manifest based, not npm.
- Prefer the automated push-to-`main` path (or a `plugin_id` dispatch) over
  hand-tagging locally.
- If `qol-tray` stops releasing, check that the script still discovers it as a
  release unit (`python3 .github/scripts/plugin_version.py` prints the plan) and
  that the bump commit still stages `apps/qol-tray/Cargo.toml`.
