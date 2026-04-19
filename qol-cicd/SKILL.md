---
name: qol-cicd
description: Use when working on shared CI, versioning, and release automation in qol-cicd, especially reusable workflows consumed by qol repos.
---

# qol-cicd

## Scope

`qol-cicd` owns shared GitHub Actions workflows and release/versioning standards for qol repos.

For `qol-tray`, the repo-local workflows are intentionally thin:
- `.github/workflows/version.yml` calls the reusable `plugin-version.yml`
- `.github/workflows/release.yml` calls the reusable `qol-tray-release.yml`

Keep release implementation in `qol-cicd`, not in individual app repos, unless the caller workflow contract itself needs to change.

## Current QoL Tray Release Contract

The reusable workflow at `.github/workflows/qol-tray-release.yml` is the source of truth for `qol-tray` tagged releases.

- Linux release always builds and publishes
- macOS release is conditional on Apple signing secrets being present
- When macOS signing is configured, the workflow builds a universal app bundle, signs it, notarizes it, staples it, and publishes:
  - `qol-tray-macos-universal.dmg`
  - `qol-tray-macos-universal.tar.gz`

Required Apple secrets are optional at the workflow boundary. If they are absent, macOS release is skipped and Linux release still proceeds.

## Versioning

Version computation is centralized in `.github/workflows/plugin-version.yml`.

- It validates manifest version consistency before bumping
- It computes the next semver from commit history
- It updates manifests, commits `chore(release): vX.Y.Z`, tags `vX.Y.Z`, and pushes both

For `qol-tray`, `version.yml` currently passes `Cargo.toml` as both cargo and plugin manifest because the app has no separate `plugin.toml`.

## Editing Guidance

- Prefer reusable workflows over copy-pasted repo-local workflow logic
- Keep secrets optional unless the entire caller workflow must hard-fail without them
- Be careful with GitHub workflow evaluation rules: `workflow_call` secret requirements are validated before jobs start
- When changing reusable release contracts, update the README in the same change

## Local Verification

Useful checks:

```bash
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/qol-tray-release.yml"); puts "ok"'
git diff --check
```

Python versioning tests live in `standards/versioning/tests` and should be run from the `qol-cicd` repo root when `pytest` is available.
