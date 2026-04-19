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

- **qol-tray: no PRs.** Commit directly to whatever feature branch you're on. The sole contributor rule applies — PRs would be self-review theater. This is explicit policy, not laziness.
- **Feature branches span repos.** When a feature touches multiple repos (e.g., `world-canvas-overhaul` required qol-config 1.3.0 APIs), create a matching-named branch in every affected repo. qol-tray, qol-config have both been on `world-canvas-overhaul`; other repos stay on `main`/`master`. The sibling `path =` dependency model means you just check out the matching branch on each sibling and the host builds against it.
- **Conventional commits.** `feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`. One-liners. No fluff, no co-authors in the message.
- **Atomic commits.** One logical change per commit. Split bug-fix from refactor from tests.
- **Amend, don't append "fix the fix"** for unpushed work.
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
| Preact htm + hooks patterns | `preact` |
| World canvas / dive traits / spatial nav | `qol-world-canvas` |
| qol-tray profile sync feature | `qol-tray-feature-profile` |
| Task runner + IDE checkout | `qol-tray-task-runner-ide-checkout` |
| Specific plugin internals | `qol-plugin-<id>` (e.g. `qol-plugin-alt-tab`) |
| Shared libraries before adding plugin-local code | `qol-shared-libs` |
| CI / release workflows | `qol-cicd` |
| Plugin release tagging | `plugin-<id>-release-flow` |
| qol-tray release tagging | `qol-tray-release-flow` |
| Rust plugin patterns | `rust` |
| GPUI plugins (launcher, alt-tab internals) | `gpui` |
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

## Current project-state pointers

- Active branch on qol-tray: `world-canvas-overhaul`. Carrying multiple intertwined refactors (world canvas UI, divable traits, peripheral-preview, atmosphere, and soon: plugin registry unification).
- Active branch on qol-config: `world-canvas-overhaul` — carries 1.3.0 APIs (RuntimeSpec, parse_runtime_spec, new FieldKinds like color-wheel).
- Most plugin repos: `main`/`master` — no cross-repo feature branches.
- Pending specs that will shape near-term work:
  - `docs/superpowers/specs/2026-04-11-world-confinement-design.md`
  - `docs/superpowers/specs/2026-04-15-divable-traits-design.md`
  - `docs/superpowers/specs/2026-04-16-plugin-registry-unification-design.md`
