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

## Sibling repo checkout in CI

When a qol-* repo declares a sibling as a Cargo path dep (e.g. `qol-tray` consumes `qol-migrations` at `path = "../qol-migrations"`), CI has to check out the matching branch of the sibling next to the consumer, then run cargo from the consumer's subdir.

Workflow shape:

```yaml
steps:
  - name: Checkout consumer
    uses: actions/checkout@v4
    with:
      path: qol-tray            # consumer goes into a subdir

  - name: Checkout other sibling
    uses: actions/checkout@v4
    with:
      repository: qol-tools/qol-config
      path: qol-config

  - name: Resolve sibling ref
    env:
      HEAD_REF: ${{ github.head_ref }}
      REF_NAME: ${{ github.ref_name }}
    shell: bash
    run: |
      if [ -n "$HEAD_REF" ]; then
        printf 'SIBLING_REF=%s\n' "$HEAD_REF" >> "$GITHUB_ENV"
      else
        printf 'SIBLING_REF=%s\n' "$REF_NAME" >> "$GITHUB_ENV"
      fi

  - name: Checkout qol-migrations at matching ref
    uses: actions/checkout@v4
    with:
      repository: qol-tools/qol-migrations
      ref: ${{ env.SIBLING_REF }}
      path: qol-migrations

  - name: Build
    working-directory: qol-tray
    run: cargo build

  - name: Test
    working-directory: qol-tray
    run: cargo test
```

Two things make this non-obvious:

- **Env-indirection is mandatory.** Writing `ref: ${{ github.head_ref }}` (or any input on the workflow-injection deny list) directly in a `with:` block is blocked by the security-reminder hook. Pass risky inputs through `env:` first, resolve in a `bash` step, then read from `env.<NAME>` in the `with:`. The example above survives the hook.
- **Both repos check out as siblings.** The consumer must use `path:` so it doesn't land at `$GITHUB_WORKSPACE` root; otherwise the sibling has nowhere to go that satisfies `path = "../<sibling>"`. Run cargo with `working-directory: <consumer>` after.

Branch-parity is the convention: a feature branch in `qol-tray` is built against the same-named branch in `qol-migrations`. The resolver falls back to `github.ref_name` (which is `main` on push-to-main) so the default flow keeps working. If the sibling does not have a matching branch, the checkout step fails loudly - that is the correct failure mode, not a fallback to main with a warning.

A `git = "...", branch = "..."` Cargo dep form looks like it would avoid this dance, but it pins to a SHA in `Cargo.lock`, breaks worktree-local iteration, and contradicts the qol-tray-data-migrations skill. Keep path deps and pay the small CI complexity.

## Local Verification

Useful checks:

```bash
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/qol-tray-release.yml"); puts "ok"'
git diff --check
```

Python versioning tests live in `standards/versioning/tests` and should be run from the `qol-cicd` repo root when `pytest` is available.
