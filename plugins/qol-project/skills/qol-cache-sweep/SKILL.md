---
name: qol-cache-sweep
description: Use when the disk holding cargo build caches keeps filling up, when the user asks what removed a build cache or why a build recompiled after a pause, or when a session-start line from [qol-cache-sweep] needs explaining. Covers the automatic `qol clean --prune` run at session start, what it keeps and removes, and how to preview or run it with /qol-project:cache-sweep.
---

# qol-cache-sweep

Every worktree builds into the one shared cargo build dir, so each build reuses what is compiled already and compiles only what changed.
Nothing removes what builds stop using: rustc leaves every replaced incremental session behind, and outputs of old dependency versions, old features and deleted worktrees stay forever.
That is how the disk lost hundreds of GiB. `qol clean --prune` removes it; this hook runs it without anyone remembering to.

## The flow

1. A session starts anywhere inside a cargo workspace (the nearest `Cargo.toml` that declares `[workspace]`).
2. The SessionStart hook prints one line about the previous sweep of that workspace, only when it freed at least 1 GiB, hit a problem, or found a `qol` too old to prune.
3. If no sweep of that workspace started in the last hour, the hook launches `qol clean --prune --json` in the background and returns at once.
4. The report goes to `~/.cache/qol-cache-sweep/<workspace-key>.json` for the next session.

## What a prune keeps and removes

The rules live in `libs/dev-build/src/target_cache` in qol-monorepo; `qol clean help` states them.

| Cache | Result |
|---|---|
| Any build output a build used in the last 3 days, and everything that output depends on | kept |
| A profile cargo is building in right now (its build lock is held) | skipped; the next sweep retries |
| The qol-check, qol-env, qol-dev, qol-lint and sherpa-onnx-prebuilt roots | never touched |
| Build outputs no build used in 3 days | removed |
| Incremental sessions rustc replaced with a newer one | removed |
| Incremental caches of crates no build compiled in 3 days | removed |

A disk that does not record file reads (noatime) only loses caches cargo can no longer use: replaced sessions and outputs without a fingerprint.
Removals first move into `.qol-sweep-trash` inside the cache dir, which is emptied at the end; the next sweep empties any trash an interrupted one left.

## Running it by hand

`/qol-project:cache-sweep --dry-run` shows what a sweep would free; without the flag it prunes now.
The script is `scripts/cache-sweep.mjs [dir] [--dry-run] [--pretty]`: JSON by default, exit 3 outside a cargo workspace, exit 4 when `qol` failed or is too old.
`qol clean --prune --dry-run [dir...]` runs the prune directly, with per-category counts.

## When the line says to run qol setup

The installed `qol` predates `qol clean --prune`. `qol setup` from qol-monorepo installs the current one; until then the hook only reports.
