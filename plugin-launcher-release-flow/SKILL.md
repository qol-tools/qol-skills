---
name: plugin-launcher-release-flow
description: Enforces correct release tagging, commit message rules, and CI triggers for plugin-launcher. Use this when the user asks to create or prepare a release.
---

# plugin-launcher-release-flow

This skill defines the strict pipeline for making changes that require a release or triggering CI.

## 1. Commits & CI Triggers
- **Universal Commit Rule:** All commits must adhere to the `commit` skill constraints.
- **Triggering CI:** CI (`ci.yml`) runs automatically on pushes to `main`. If working on another branch, or if you need to force-trigger CI, include the `ci` token in the commit scope (e.g. `fix(bug, ci): fix the parser crash`). This prevents wasting GitHub Actions runner compute unless necessary.
- **Release Commits:** When preparing a release, your commit message MUST exactly follow the format: `chore(release): vMAJOR.MINOR.PATCH`

## 2. Release & Tagging Pre-checks
Before creating any release tags, ALWAYS verify that there are no dangling refs or stray tags on the remote or local repository that might conflict.
- Run `git fetch --tags` to ensure the local state has all upstream tags.
- Compare `git tag -l` with the release version you intend to make.

## 3. Creating the Release
- Release triggers solely rely on pushing a `v*` formatted tag (e.g. `v1.2.3`).
- When a tag is pushed, it triggers the `.github/workflows/release.yml` workflow building cross-compiled Linux and macOS targets.
- Execute the tagging process: `git tag v1.2.3` and then push the tag `git push origin v1.2.3`. 
- **DO NOT** push until the release commit itself has been pushed and verified.
