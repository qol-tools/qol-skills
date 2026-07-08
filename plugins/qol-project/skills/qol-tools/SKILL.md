---
name: qol-tools
description: Use when working anywhere in the qol-tools world - the qol-monorepo (apps/, libs/, plugins/, tools/, docs/) or the qol-skills repo. Covers org-level conventions, monorepo layout, dependency model, branch and commit policy, and pointers to more specific skills.
---

# qol-tools — org-level knowledge

## Scope and audience

`qol-tools` is a GitHub org with a single human contributor (kmrh47), and all product code is consolidated into one repo: `qol-monorepo`.
AI assistants are the second author in practice.
Licensed under **PolyForm-Noncommercial 1.0.0** across every crate and plugin.
Not a public-facing community project today; third-party plugin authorship is planned (plugin-template exists) but there is no external user base yet.
Treat decisions with that framing: aggressive refactors are fine, breaking changes to unpublished internals are fine, and docs speak to future-Daisy + future-agent rather than to an outside community.

## Workspace layout

All qol code lives in one repo: `qol-monorepo`.
Locate the root with `git rev-parse --show-toplevel`; never hardcode machine paths.

- `apps/` - user-facing binaries (the tray host).
- `libs/` - shared crates, consumed as workspace path deps; no publish step.
- `plugins/` - one directory per plugin binary, each with its `plugin.toml` manifest.
- `tools/` - developer tooling (the `qol` CLI).
- `docs/` - specs, plans, status notes.

## Dependency model

One workspace `Cargo.toml`; whatever is checked out is what everything builds against.
You edit a crate in `libs/`, rebuild a consumer, and see the change - no publish step, no branch coordination.
Plugins remain separate executables loaded by the host at runtime; they are never Cargo-linked into it.

## Branch and commit policy

- `qol-workflow:git-trees` is the canonical contribution-flow skill. It owns the worktree-only rule, direct-vs-PR decision, and final squash delivery invariant.
- **The main clone stays on `main`.** Feature branches live in worktrees, never in the main clone.
- **Worktree commits are scratch history.** Before a worktree branch reaches `main`, land it as one polished conventional commit unless the user explicitly asks for multiple delivered commits.
- **PRs are rare and explicit.** Default is direct commit to `main`. If the user asks for a PR, land it with GitHub squash merge.
- **Clean up after landing.** Remove the worktree and delete local/remote feature branches.
- **Conventional commits.** `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`. One-liners. No fluff, no co-authors in the message.
- **Atomic delivered commits.** The commit that lands on `main` is one coherent delivery.
- **No pushing without being asked.** Commit locally, push at explicit session boundaries.
- **Releases follow `qol-tray-release-flow`.** The host and every plugin under `plugins/*` with a `plugin.toml` are release units with `<id>-v*` tags.

## Install + dev flows

- The `qol` CLI owns setup, build, install, and dev workflows; command facts come from `qol --help` (see the `qol-cli` skill).
- `qol dev` starts qol-tray as a child with dev features (dev-link overrides, self-recompile endpoints, log controls, worktree scanning).
- Plugin install is via the in-app plugin store, which resolves each plugin's latest `<id>-v*` GitHub release asset, with a cargo-build fallback.
- Dev-linking: `POST /api/dev/links` with a path to a plugin source directory. Dev builds resolve the dev-link over the installed plugin.

## Docs and skills — where things live

- **Design specs:** `docs/superpowers/specs/YYYY-MM-DD-<topic>.md`. Living proposals, updated in place.
- **Implementation plans:** `docs/superpowers/plans/YYYY-MM-DD-<topic>.md`.
- **Status notes:** `docs/superpowers/` (ad-hoc files).
- **Skills:** the `qol-skills` repo, surfaced as Claude Code plugins via the marketplace. Skills under the `qol-*` namespaces are workspace-owned. Skills under `superpowers:`, `commit-commands:`, etc. are third-party and must not be edited.
- Current project state lives in git (`git branch`, `git log`) and `docs/`; read it at need instead of trusting prose.

## More specific skills to invoke when appropriate

| If you're touching... | Skill |
|---|---|
| qol-tray core (plugin loader, resolver, platform, features) | `qol-tray-core` |
| qol-tray UI (`ui/`) | `qol-tray-ui-systems` |
| qol-tray frontend diagnostic logging | `qol-tray-dev-logging` |
| Preact htm + hooks patterns | `preact-conventions` |
| World canvas / dive traits / spatial nav | `qol-world-canvas` |
| qol-tray profile sync feature | `qol-tray-feature-profile` |
| Task runner + IDE checkout | `qol-tray-task-runner-ide-checkout` |
| Specific plugin internals | `qol-plugin-<id>` (e.g. `qol-plugin-alt-tab`) |
| Shared libraries before adding plugin-local code | `qol-shared-libs` |
| CI / release workflows | `qol-cicd` |
| Release tagging (host or any plugin) | `qol-tray-release-flow` |
| Rust plugin patterns | `rust-conventions` |
| GPUI plugins (launcher, alt-tab internals) | `gpui-conventions` |
| Tests for apps and plugins | `qol-apps-testing` |
| Any code, universal | `coding-general` |
| Worktree workflow | `git-trees` |
| Pushing | `git-push` |

## Key conventions to remember

- **No comments in code** unless a comment explains a non-obvious WHY (see `coding-general`). Rare.
- **No emojis in code or commits** unless explicitly requested.
- **No builds or tests unless asked.** Do not run `cargo build`, `cargo test`, `make`, etc. — they're expensive, and user has their own workflow.
- **No automatic pushing.** Commit locally. Push when asked.
- **Keyboard-first UI.** Every interaction must work via keyboard before mouse is considered.
- **Deep modules over shallow.** Hide complexity behind clean APIs; max ~50 lines per function as guidance.
- **Property-based tests preferred** for state machines and invariants. Example-based is fine for simpler logic.
- **Named constants, not magic numbers.** Named color tokens, not inline hex. (See `qol-tray-ui-systems` for the token taxonomy.)

## Use invariants, not state snapshots

Any prose written into the qol-tools world (CLAUDE.md, SKILL.md, README, commit body, PR description, design spec) must reference scopes by invariant, not by enumerating current state.

**Why:** a snapshot is correct on the day it is written and silently wrong the moment state changes. Nobody updates prose to track filesystem reality. A reader trusts what they read, so stale prose is worse than no prose. The next agent acts on it as if it were current and ends up either rebuilding work that has already happened or skipping work that has not.

**How:** point at the description, the path pattern, or the source-of-truth location instead of restating state.

| Snapshot (wrong) | Invariant (right) |
|---|---|
| "the 9 plugins in the monorepo" | "every directory matching `plugins/*` with a `plugin.toml`" |
| "plugin-alt-tab, plugin-launcher, plugin-lights, ..." | "each release unit under `plugins/*`" |
| "qol-config + qol-plugin-api + qol-runtime" | "workspace members under `libs/`" |
| "the 3 file migrations: v3.15->v3.16, v3.16->v3.17, v3.17->v3.18" | "every migration registered in `PreFlightRegistry::current()`" |
| "`OLDEST_SUPPORTED = 3.15.0`" | "below `OLDEST_SUPPORTED` (slides per release)" |
| "active branch is `world-canvas-overhaul`" | omit, or point at `docs/superpowers/` for current state |
| "as of qol-config 1.3.0" | omit, or "the current qol-config API" |
| "754 lib tests" | "the full lib test suite" |
| "the May 2026 wipe incident" | "the wipe-then-clone incident that motivated this section" (date only if it anchors a specific commit a reader needs to find) |

If the count or list is genuinely essential (rare), generate it from source at read time (`ls plugins/`, `cargo metadata`, `git log`, the runtime API), and say so, rather than restating it.

Two corollaries:

- A commit message that says "the May 2026 incident" is preferable to "the X = 0.1.0 stamp bug from 2026-05-22" because the date appears once in git history naturally. Restating it in prose creates a second moving part.
- A skill that enumerates "siblings" or "neighboring features" must say what makes a thing a sibling, not list the current siblings. The enumeration belongs in the description or a path glob.

This rule applies to every skill in `qol-skills/`. When you author or extend one, audit your draft for "as of", "current", "the N <things>", "the X, Y, Z <things>", and "in version V" - those are the lexical fingerprints of snapshot drift.
