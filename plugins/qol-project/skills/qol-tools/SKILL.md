---
name: qol-tools
description: Use when working anywhere in the qol-tools org (qol-tray, qol-config, qol-plugin-api, qol-cicd, plugin-* repos, workspace docs/specs). Covers org-level conventions, workspace layout, inter-repo dependency model, branch and commit policy, and pointers to more specific skills.
---

# qol-tools — org-level knowledge

## Scope and audience

`qol-tools` is a GitHub org with a single human contributor (kmrh47). AI assistants are the second author in practice. Licensed under **PolyForm-Noncommercial 1.0.0** across every crate and plugin. Not a public-facing community project today; third-party plugin authorship is planned (plugin-template exists, CI workflows are reusable) but there is no external user base yet. Treat decisions with that framing: aggressive refactors are fine, breaking changes to unpublished internals are fine, and docs speak to future-Daisy + future-agent rather than to an outside community.

## Workspace layout

Repos are siblings under the qol-tools workspace directory — typically `~/repos/private/qol-tools/` on Mac or `/media/kmrh47/WD_SN850X/Git/qol-tools/` on Linux. Adjust to your machine:

- `workspace/` — the "meta" repo. Holds `docs/` (specs, plans, status notes), `.claude/skills/`, cross-repo scripts, planning material. No Rust code. Docs live under `docs/superpowers/specs/YYYY-MM-DD-*.md` and `docs/superpowers/plans/YYYY-MM-DD-*.md`. Currently on `main` — no feature branches here.
- `qol-tray/` — the host app (Rust + Preact UI). The tray, plugin loader, resolver, plugin-store, dev-linking, HTTP server.
- `qol-config/` — contract schema library. Parses plugin `qol-config.toml` and `qol-runtime.toml` contracts. Declares `ConfigSpec`, `RuntimeSpec`, `FieldKind`, etc.
- `qol-plugin-api/` — SDK crate plugins depend on. Runtime message types, daemon protocol helpers.
- `qol-runtime/` — shared runtime protocol crate.
- `qol-cicd/` — reusable GitHub Actions workflows (plugin-release.yml, plugin-version.yml, qol-tray-release.yml, auto-label-plugin.yml).
- `plugin-*/` — individual plugins (plugin-alt-tab, plugin-launcher, plugin-lights, plugin-os-themes, plugin-pointz, plugin-screen-recorder, plugin-template, plugin-window-actions, ...). Each is its own cargo binary + `plugin.toml` manifest.
- `qol-frecency/`, `qol-color/`, `qol-search/`, `qol-fx/`, ... — smaller shared-library crates.

See `workspace/` for the canonical layout; it's the only repo that holds cross-org knowledge.

## Inter-repo dependencies

qol-tray and other host-side crates consume sibling crates via Cargo `path = "../<crate>"` dependencies. Example from qol-tray `Cargo.toml`:

```toml
qol-config = { path = "../qol-config" }
qol-runtime = { git = "..." }      # some remain as git deps
qol-plugin-api = { git = "..." }
```

**Implication:** whichever branch you have checked out in the sibling repo is what the host builds against. This is the "dev-link for crates" equivalent — you edit `qol-config`, rebuild qol-tray, you see the change. No publish step. It's why local work on a new qol-config API shows up immediately in qol-tray development builds.

Plugins, in contrast, are **not** Cargo-linked into qol-tray. They are separate executables. The host loads them at runtime via the plugin registry (see `qol-tray` skill + `2026-04-16-plugin-registry-unification-design.md` spec).

## Branch and commit policy

- `qol-workflow:git-trees` is the canonical contribution-flow skill. It owns the worktree-only rule, direct-vs-PR decision, and final squash delivery invariant.
- **Main clones stay on `main`.** Feature branches live in worktrees under the shared worktree layout, never in the main clone.
- **Feature branches span repos by topic.** When a feature touches multiple repos, use the same topic branch name in every participating repo. The sibling `path = "../<crate>"` dependency model means the host builds against whichever sibling branch is checked out in that feature lane.
- **Worktree commits are scratch history.** Before a worktree branch reaches `main`, merge that repo's branch diff into the local main clone as one polished conventional commit unless the user explicitly asks for multiple delivered commits.
- **PRs are rare and explicit.** Default is direct commit/push to `main`. If the user asks for branch isolation or review, use a worktree branch, then squash-merge it into the local main clone and push from there. If the user explicitly asks for a PR, land it with GitHub squash merge.
- **Clean up after landing.** Once the squashed worktree diff reaches `main`, remove the local worktree and delete local/remote feature branches.
- **Conventional commits.** `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`. One-liners. No fluff, no co-authors in the message.
- **Atomic delivered commits.** The commit that lands on `main` is one coherent delivery. WIP/fixup commits inside a worktree should be amended or squashed away.
- **No pushing without being asked.** Commit locally, push at explicit session boundaries.
- **Plugin repos follow release-flow skills** (e.g., `plugin-alt-tab-release-flow`, `plugin-launcher-release-flow`) when cutting a tagged release. Default is just commit + push.

## Install + dev flows (qol-tray-centric)

- `make dev` in qol-tray → runs with `--features dev`. Enables dev-link overrides, mock targets, self-recompile endpoints, log controls, worktree scanning.
- `make install` in qol-tray → builds release and runs the installer binary. Installs qol-tray itself + autostart + creates empty plugins dir. **Does not install plugins.**
- Plugin install is via the in-app plugin store: `POST /api/install/{id}` → `git clone github.com/qol-tools/{id}.git → download release asset or cargo-build fallback → rename into plugins_dir/<id>/`. Tightly scoped to the qol-tools GitHub org.
- Dev-linking: `POST /api/dev/links` with a path to a local source tree. Dev builds resolve the dev-link over the installed plugin. (In-progress spec: unify this into a single pointer-based registry regardless of cargo feature flag — see `2026-04-16-plugin-registry-unification-design.md`.)

## Docs and skills — where things live

- **Design specs:** `workspace/docs/superpowers/specs/YYYY-MM-DD-<topic>.md`. Living proposals. Updated in place as thinking evolves; older specs remain as context.
- **Implementation plans:** `workspace/docs/superpowers/plans/YYYY-MM-DD-<topic>.md`. Step-by-step execution plans derived from specs.
- **Status notes:** `workspace/docs/superpowers/` (sibling dir, ad-hoc files). Feature-branch status, handoff notes.
- **Skills:** workspace-owned skills now live in the `qol-skills` repo (cloned to `~/repos/private/qol-tools/qol-skills/`) and are surfaced into the workspace via `.claude/skills` symlink. Skills under the `qol-*` namespace are workspace-owned. Skills under `superpowers:`, `commit-commands:`, etc. are plugin-provided and should not be edited.

## More specific skills to invoke when appropriate

| If you're touching... | Skill |
|---|---|
| qol-tray core (plugin loader, resolver, platform, features) | `qol-tray` |
| qol-tray UI (`ui/`) | `qol-tray-ui-systems` |
| qol-tray frontend diagnostic logging | `qol-tray-dev-logging` |
| Preact htm + hooks patterns | `preact-conventions` |
| World canvas / dive traits / spatial nav | `qol-world-canvas` |
| qol-tray profile sync feature | `qol-tray-feature-profile` |
| Task runner + IDE checkout | `qol-tray-task-runner-ide-checkout` |
| Specific plugin internals | `qol-plugin-<id>` (e.g. `qol-plugin-alt-tab`) |
| Shared libraries before adding plugin-local code | `qol-shared-libs` |
| CI / release workflows | `qol-cicd` |
| Plugin release tagging | `plugin-<id>-release-flow` |
| qol-tray release tagging | `qol-tray-release-flow` |
| Rust plugin patterns | `rust-conventions` |
| GPUI plugins (launcher, alt-tab internals) | `gpui-conventions` |
| Tests for apps and plugins | `qol-apps-testing` |
| Any code, universal | `coding-general` |
| Coordinated multi-repo worktrees | `git-trees` |
| Pushing any repo | `git-push` |

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
| "the 9 plugins under qol-tools" | "every repo matching `qol-tools/plugin-*`" |
| "plugin-alt-tab, plugin-launcher, plugin-lights, ..." | "each `plugin-*` repo's release-flow skill" |
| "qol-tray + qol-config + qol-plugin-api + qol-runtime" | "siblings under the qol-tools workspace that declare `path = \"../<crate>\"` deps" |
| "the 3 file migrations: v3.15->v3.16, v3.16->v3.17, v3.17->v3.18" | "every migration registered in `PreFlightRegistry::current()`" |
| "`OLDEST_SUPPORTED = 3.15.0`" | "below `OLDEST_SUPPORTED` (slides per release)" |
| "active branch is `world-canvas-overhaul`" | omit, or point at `workspace/docs/superpowers/` for current state |
| "as of qol-config 1.3.0" | omit, or "the current qol-config API" |
| "754 lib tests" | "the full lib test suite" |
| "the May 2026 wipe incident" | "the wipe-then-clone incident that motivated this section" (date only if it anchors a specific commit a reader needs to find) |

If the count or list is genuinely essential (rare), generate it from source at read time (`ls plugins/`, `cargo metadata`, `git log`, the runtime API), and say so, rather than restating it.

Two corollaries:

- A commit message that says "the May 2026 incident" is preferable to "the X = 0.1.0 stamp bug from 2026-05-22" because the date appears once in git history naturally. Restating it in prose creates a second moving part.
- A skill that enumerates "siblings" or "neighboring features" must say what makes a thing a sibling, not list the current siblings. The enumeration belongs in the description or a path glob.

This rule applies to every skill in `qol-skills/`. When you author or extend one, audit your draft for "as of", "current", "the N <things>", "the X, Y, Z <things>", and "in version V" - those are the lexical fingerprints of snapshot drift.

## Current project-state pointers

- Active branch on qol-tray: `world-canvas-overhaul`. Carrying multiple intertwined refactors (world canvas UI, divable traits, peripheral-preview, atmosphere, and soon: plugin registry unification).
- Active branch on qol-config: `world-canvas-overhaul` — carries 1.3.0 APIs (RuntimeSpec, parse_runtime_spec, new FieldKinds like color-wheel).
- Most plugin repos: `main`/`master` — no cross-repo feature branches.
- Pending specs that will shape near-term work:
  - `docs/superpowers/specs/2026-04-11-world-confinement-design.md`
  - `docs/superpowers/specs/2026-04-15-divable-traits-design.md`
  - `docs/superpowers/specs/2026-04-16-plugin-registry-unification-design.md`
