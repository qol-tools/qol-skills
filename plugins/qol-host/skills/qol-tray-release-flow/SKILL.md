---
name: qol-tray-release-flow
description: Enforces correct release tagging, commit message rules, and CI triggers for qol-tray. Use this when the user asks to create or prepare a release.
---

# qol-tray-release-flow

This skill defines the current release pipeline for `qol-tray`.

## 1. CI and Version Flow
- CI runs on pushes and pull requests targeting `main`, plus manual dispatch.
- The version workflow is triggered from successful `CI` runs on `main`, or manually via `workflow_dispatch`.
- `qol-tray` versioning is implemented by the reusable `qol-cicd` workflow `.github/workflows/plugin-version.yml`.

## 2. Release Commits
- Release commits must use the exact format: `chore(release): vMAJOR.MINOR.PATCH`
- The reusable version workflow is responsible for creating that commit and pushing the matching tag.

## 3. Release Trigger
- Tagged releases are triggered solely by pushing a `v*` tag.
- `qol-tray`'s repo-local `.github/workflows/release.yml` is a thin caller to `qol-cicd/.github/workflows/qol-tray-release.yml`.
- The real release logic lives in `qol-cicd`, not in `qol-tray`.

## 4. Current Artifact Shape
- Linux release artifacts are always produced.
- macOS release artifacts are only produced when Apple signing secrets are configured in the caller repo or org.
- Current macOS artifacts are:
  - `qol-tray-macos-universal.dmg`
  - `qol-tray-macos-universal.tar.gz`

## 5. Operator Notes
- Do not describe the release path as npm-based. `qol-tray` release versioning is Cargo-manifest based.
- Prefer the automated `version.yml` plus tag-driven release path over manual local tagging.
- If a reusable release workflow changes in `qol-cicd`, validate with a fresh tag-triggered run rather than assuming an old rerun will pick up the new workflow definition.
