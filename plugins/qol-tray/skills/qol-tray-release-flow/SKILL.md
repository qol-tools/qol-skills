---
name: qol-tray-release-flow
description: Use when cutting, tagging, or preparing a release for qol-tray or any plugin release unit in the monorepo, or when release CI does not trigger as expected.
---

# qol-tray-release-flow

This skill defines the release pipeline for `qol-tray` as it lives in the
`qol-monorepo` workspace. `qol-tray` is the host app under `apps/tray`; it
is released as one "release unit" alongside the bundled `plugins/*`.

## 1. Versioning starts from successful CI

- The versioner is the repo-local workflow `.github/workflows/plugin-version.yml`
  ("Version and Release Plugins"), which runs `.github/scripts/plugin_version.py`.
  It is NOT a reusable `qol-cicd` workflow.
- Automatic versioning starts from a completed, successful `CI` push run on
  `main`. Manual dispatch verifies that the selected `main` commit has the same
  successful source-CI evidence. Red, cancelled, incomplete, and non-main runs
  never produce a release candidate.
- `CI` runs affected debug lint/tests and release-profile builds on Linux and
  macOS with warnings denied. Release-profile parity is required because debug
  clippy/tests can miss `debug_assertions` and target-specific warnings.
- The script computes a bump per release unit from conventional-commit history
  since that unit's last tag (`feat` -> minor, `fix`/`perf` -> patch,
  `!`/`BREAKING CHANGE` -> major), counting only commits that touch the unit's
  package or its workspace dependency closure.
- The commit title's scope then picks which of those units release. A scope
  naming workspace members that a release unit builds releases every unit that
  builds a named member, any unit whose own files the commit edits, and any
  unit a changed crate or dependency reaches without reaching a named member.
  `Cargo.lock` and root `[workspace.dependencies]` changes count per changed
  name.
- Shared build config (`rust-toolchain`, `.cargo/`, the root profile, patch and
  workspace settings) releases every unit whatever the scope says. Unscoped
  commits, umbrella and unknown scopes, and scopes naming only members no unit
  builds (`fix(cli)`) keep the path rule.
- Only the title sets the scope. The `* type(scope):` lines of a squash body
  count for whether a commit releases and for the bump, never for the scope.
- A shared-lib change scoped to one unit reaches the lib's other dependents only
  at their next release, and their notes never list it. To ship it to every
  dependent now, name the lib too: `fix(explorer,gpui)`.
- `.githooks/pre-push` counts the same way and rejects a direct push to `main`
  that releases half or more of the units; `QOL_ALLOW_WIDE_RELEASE=1` overrides
  it, and only the owner approves that.
- A change to this rule or to the scope list plans again every commit since
  each unit's last tag, so units it skipped can release together. Run
  `python3 .github/scripts/plugin_version.py` first to see the plan.

## 2. Release units (plugins + the host)

- Each plugin under `plugins/*` that carries a `plugin.toml` is a release unit.
- The host app `apps/tray` is also a release unit. It has Cargo metadata
  only and NO `plugin.toml`. Never add one - that contaminates plugin semantics.
- To force one unit's release, dispatch `plugin-version.yml` with the
  `plugin_id` input (for the host, `qol-tray`).

## 3. Exact release candidate before tags

- The versioner stages `Cargo.lock`, `plugins/*/Cargo.toml`,
  `plugins/*/plugin.toml`, and `apps/tray/Cargo.toml`, then commits them as
  the literal message `chore(plugins): bump plugin versions` and pushes.
  `CI`'s plan job skips commits with exactly that prefix.
- The pushed bump commit is not tagged immediately.
  `.github/scripts/release_candidate.py` derives plugin targets from each
  `plugin.toml`; the candidate jobs build each target in the release profile,
  package it, upload the release files as `dist-<tag>-<target>` artifacts
  (kept 90 days), and write machine-readable plan/build reports. `qol-tray`
  always builds and packages Linux, macOS and Windows.
- `attest` refuses unless every planned candidate has a passing build report.
  It then writes one exact-SHA commit status per intended tag, creates
  immutable tags atomically, and dispatches releases. A failed or timed-out
  candidate receives no tag:
  `<plugin-id>-vX.Y.Z` for plugins, `qol-tray-vX.Y.Z` for the host.
- Never move or reuse a failed tag. Land the fix and cut the next version.
- The historical `chore(release): vX.Y.Z` and `chore(qol-tray, release): vX.Y.Z`
  formats are pre-monorepo. Do not expect or require them.

## 4. Release trigger and exact-SHA gate

- A tag pushed with the default `GITHUB_TOKEN` does not trigger another
  workflow, except through explicit `workflow_dispatch` or
  `repository_dispatch`. This is the documented
  [GitHub token recursion contract](https://docs.github.com/en/actions/concepts/security/github_token).
  The versioner explicitly dispatches the matching release workflow per tag:
  - `qol-tray-v*` -> `qol-tray-release.yml` (host release)
  - every other `*-v*` -> `release.yml` (plugin release; its tag-push trigger
    explicitly excludes `qol-tray-v*`)
- Both release workflows also accept a `workflow_dispatch` `tag` input and check
  out `refs/tags/<tag>`; that is the path the dispatch uses.
- Both workflows first require the intended tag's successful
  `qol/release-candidate/<tag>` status on the exact checked-out commit, posted
  by `github-actions[bot]` and pointing at a Versioning run on `main`. A green
  status from another commit, release unit, author or run is not accepted.
- They then download that run's `dist-<tag>-*` artifacts and refuse a missing
  target or platform. Neither workflow rebuilds anything.

## 5. Host release logic and artifacts

- The host is built and packaged by the Versioning candidate jobs;
  `qol-tray-release.yml` only verifies and publishes. It is NOT a thin caller
  to `qol-cicd`.
- Linux: a `.deb` (cargo-deb) plus `qol-tray-linux-<arch>.tar.gz`.
- macOS: a universal (aarch64 + x86_64) `.app` bundle, ad-hoc codesigned
  (`codesign --sign -`), shipped as `qol-tray-macos-universal.tar.gz`. macOS is
  always built; there is no Apple-signing-secret gate and no `.dmg`.
- A final job publishes a GitHub Release for the tag with generated notes,
  filtered by `release_notes.py` to the pull requests that counted toward the
  tray. When that planning fails, the step warns and lists every pull request.
- CI, candidate, and release jobs have explicit timeouts. A timeout is a
  circuit breaker; repair a repeatedly hanging test or build instead of merely
  raising the limit.

## 6. Operator notes

- Versioning is Cargo-manifest based, not npm.
- Prefer the automated push-to-`main` path (or a `plugin_id` dispatch) over
  hand-tagging locally.
- If `qol-tray` stops releasing, check that the script still discovers it as a
  release unit (`python3 .github/scripts/plugin_version.py` prints the plan) and
  that the bump commit still stages `apps/tray/Cargo.toml`.
- Candidate plan, build, source-CI, and attestation reports are retained as
  workflow artifacts. Use them before reconstructing a failed run from logs.
- Re-running a release by dispatch works while the candidate's `dist-*`
  artifacts exist (90 days). An older tag cannot be republished from its
  candidate; cut the next version instead.
