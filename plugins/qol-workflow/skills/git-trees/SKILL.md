---
name: git-trees
description: Use this when creating, switching, or branching in any qol-* repo. Defines the branch-based worktree workflow, direct-vs-PR route, and final squash delivery invariant.
---

# git-trees

Use this skill any time a change is made on a branch other than `main` in a qol-* repo. The qol-tools workflow is **worktrees-only**: the main clone of every repo MUST stay on `main` forever. Feature branches live in dedicated worktree directories.

## The hard rule (read this first, every time)

**Default changes do NOT get a PR.** Tests, configs, rules, hooks, skill edits, doc fixes, lockfile bumps, normal fixes, refactors, and features commit straight to `main` unless the user asks for branch isolation or a PR. No PID. No draft PR. No mark-ready. No squash-merge dance.

**There are only two normal modes:** direct work on `main`, or feature-branch work in a worktree. If the user asks for a branch, PR, isolated review, coordinated multi-repo lane, or anything that should not land directly on `main` yet, create a worktree. If the change is direct-to-main, stay on `main` in the main clone.

**If unsure, ASK first.** Don't default to ceremony. Don't mint a PID without checking. Asking takes 30 seconds; an unwanted PR wastes 5+ minutes on both sides and creates noise.

**NEVER `git checkout -b`, `git checkout <other-branch>`, `git switch -c`, or `git switch <other-branch>` inside a qol-* main clone.**

The branch-switch ban is enforced by the `branch-deny-checkout-in-main-clone` PreToolUse hook. It exists to keep the main clone on `main` so `qol-sync` and `make dev` see fresh code. Direct-to-main work happens on `main` without switching branches.

### Why

- The main clone is what `qol-sync` and `make dev` operate on. If it sits on a stale feature branch, `qol-sync` silently reports `ok: <feature-branch> -> origin/<feature-branch>` while `main` quietly drifts behind. The next `make dev` runs against out-of-date code.
- After a PR merges with `--delete-branch`, the local feature branch in the main clone becomes orphaned — its remote tracking branch is gone, but the working tree is still checked out on it. Re-running `qol-sync` won't recover; you have to manually `git checkout main && git pull`.
- Worktrees are cheap and isolate this entirely. The main clone stays pristine.

### What the hook allows

- `git checkout main` / `git checkout master` / `git switch main` (returning to main is always fine)
- `git checkout -- <files>` (path checkout, not branch switch)
- `git checkout HEAD~1` / `git checkout <SHA>` (revision checkout)
- Anything inside `<workspace>/worktrees/<feature>/<repo>/` (you're already in a worktree — branch ops are expected)
- Any command suffixed with ` # intentional` (rare recovery path; document why in the same turn)

## PRs are opt-in. Default is commit-direct-to-main.

**The qol-tools workspace is solo.** There is no async team to coordinate with via PR. PRs add review-cycle ceremony that is pure friction when the only reviewer is the same person who wrote the code. Default behaviour: edit on `main`, `git add && git commit && git push`.

**Open a PR ONLY when the user explicitly asks for one** with phrases like "open a PR", "draft a PR", or "make a PR for this". A request to review/test on a branch means "use a worktree branch"; it does not imply PR. **Never offer "or open a PR" as a fallback option** in a "Want me to fix or X?" prompt - drop the X. The choice is fix-now-direct-or-not-now.

The branch-deny-checkout-in-main-clone hook still applies: branching off `main` inside the main clone is blocked. Editing `main` itself in the main clone is fine and is the normal flow. If the user explicitly asks for a PR, see "Worktree creation" below.

### What can get PR'd when explicitly requested

- Multi-week initiatives the user wants to retrospect on (rare).
- Anything the user calls out as "open a PR for this".
- Cross-repo coordinated work where the user wants to review repos together.

### Tests, refactors, fixes, features

All commit direct to `main` by default. Including substantive `src/` / `ui/` changes. The user is the reviewer; they review by reading the commit on `main`, not by clicking through PR UI. If they want to inspect first, they will say so explicitly.

### Bundled commits are fine on main

Tests + a small refactor that makes them testable, in the same atomic commit, is fine when committing direct. Atomic-commit rule still holds (one logical change per commit, repo always green). No need to artificially split tests from the refactor that enabled them.

## Final delivery invariant

**A worktree branch is a staging area, not the contribution unit.** It may contain many WIP, review, or fixup commits while the user and agents iterate. Before it reaches `main`, bring that branch's repo-local diff into the local main clone as **one polished conventional commit** unless the user explicitly asks for multiple delivered commits.

This applies to both routes:

- **Direct route:** from the local main clone, `git merge --squash <feature-branch>`, commit, then push `main`. Never push `HEAD:main` directly from the worktree.
- **PR route:** open/review from the worktree branch, then use GitHub squash merge. Do not merge-commit or rebase-merge the branch stack into `main`.

For multi-repo lanes, squash each repo independently. The result is one final commit on `main` per participating repo, not one global commit across repos. If an agent thinks a worktree should land as multiple commits, it must ask first and name the independently revertible deliveries.

After the squashed feature lands on `main`, clean up both sides: delete the remote feature branch if it exists, delete the local feature branch if it lingers, and remove the local worktree directory.

The direct route always pushes from the local main clone, not from the worktree. This keeps local `main` and `origin/main` moving together and prevents a worktree push from stranding unpublished commits in the main clone.

## Goal

Keep related worktrees grouped by feature, not by repo, while still respecting that each Git worktree belongs to exactly one repository.

## Canonical Layout

Create a shared feature directory under:

`/Users/kaho/repos/private/qol-tools/worktrees/<feature-name>/`

Then place one worktree per repo inside it:

```text
/Users/kaho/repos/private/qol-tools/worktrees/feat-config-contract-v1/
  qol-config/
  qol-tray/
  qol-cicd/
  plugin-window-actions/
  plugin-launcher/
```

`<feature-name>` should usually match the branch name.

## Rules

- One repo, one worktree directory.
- All repos participating in the same initiative MUST use the **same branch name**. See "Cross-repo dev recompile loop" below: qol-tray's active-worktree picker enforces this at runtime.
- Group by feature first, repo second.
- Keep the repo directory name equal to the repo identity.
- Use this layout for coordinated testing where `qol-tray` orchestrates multiple plugins or supporting repos.

## Cross-repo dev recompile loop (CRITICAL)

qol-tray's dev mode exposes an **Active Worktree Branch** picker (Settings, dev panel; persisted at `~/.config/qol-tray/dev/active-worktree.txt`). The selected branch name is applied to every dev-linked plugin repo: each plugin resolves to its worktree on that branch if one exists, otherwise falls back to its main clone.

The implication is a hard naming rule:

> **Coordinated work across qol-tray + N plugin repos shares ONE branch name.**

Concretely:

- The qol-tray branch and any plugin-repo branches that need to move together must all be `<name>`. Pick the name to be **short, stable, and topic-led** (`wasm`, `theming`, `sync-v2`).
- **Do NOT use PID-prefixed branch names** (`tray-32-integration`, `tray-42-foo`) for the qol-tray side of a coordinated initiative. PIDs are per-issue; the active-worktree convention is per-topic and outlives any single PR. Use a PID branch only for single-repo work.
- Plugin repos where `main` already carries the right code need **no worktree**: qol-tray's resolver falls back to main automatically. Don't fabricate empty `wasm` branches just for symmetry.
- The worktree directory under `worktrees/<name>/<repo>/` matches the branch name, same as the single-repo case.

### Example: the wasm migration
- qol-tray branch: `wasm` (worktree at `worktrees/qol-tray/wasm/`).
- plugin-window-ctl / plugin-launcher-wasm / plugin-screen-recorder-wasm: their `main` already IS the wasm version, so no separate branch needed.
- Future plugins that need a wasm fork (e.g. plugin-alt-tab): branch named `wasm` in that repo, worktree at `worktrees/plugin-alt-tab/wasm/`.

When you find yourself naming a qol-tray branch after the issue id, ask: "Will any plugin repo need to move on the same lane?" If yes, pick a topic name instead.

## Why This Layout

- It makes cross-repo work visible as one lane.
- It keeps A/B testing simple by switching all involved repos between the same feature branch and `main`.
- It avoids scattering related worktrees across unrelated repo-local locations.
- It preserves normal Git boundaries while optimizing for the QoL ecosystem workflow.

## Creation Flow

1. Choose a feature branch name, for example `feat/config-contract-v1`.
2. Create the shared feature directory:
   `/Users/kaho/repos/private/qol-tools/worktrees/<feature-name>/`
3. For each participating repo, create a worktree inside that directory using the same branch name when appropriate.
4. Keep all edits for that feature inside those colocated worktrees.
5. When communicating paths, identify both the feature lane and the repo.

### Concrete commands

```bash
FEAT=tray-19-switch-qol-config-cargo-dep-from-path-to-git
mkdir -p /Users/kaho/repos/private/qol-tools/worktrees/$FEAT
git -C /Users/kaho/repos/private/qol-tools/qol-tray worktree add \
  /Users/kaho/repos/private/qol-tools/worktrees/$FEAT/qol-tray \
  -b $FEAT
cd /Users/kaho/repos/private/qol-tools/worktrees/$FEAT/qol-tray
# … edit and commit freely while iterating …
```

After delivery:

```bash
git -C /Users/kaho/repos/private/qol-tools/qol-tray worktree remove \
  /Users/kaho/repos/private/qol-tools/worktrees/$FEAT/qol-tray
git -C /Users/kaho/repos/private/qol-tools/qol-tray branch -D $FEAT  # if local branch lingers
```

The main clone never changed branches — `qol-sync` will pick up `main` cleanly on its next run.

## Recovery: the main clone is already on a feature branch

If you discover the main clone is on a non-main branch (typically because the hook didn't exist yet):

```bash
git -C <repo> stash --include-untracked   # only if dirty
git -C <repo> checkout main               # always allowed by the hook
git -C <repo> pull --ff-only
git -C <repo> stash pop                   # if you stashed
git -C <repo> branch -D <orphan-branch>   # if the merged branch lingers
```

If the work on the feature branch was unmerged and worth saving, push it first to a remote, then create a worktree at the same branch and continue work there.

## Recommended Repo Set

For config and plugin-platform work, the common set is:

- `qol-tray`
- `qol-cicd`
- `qol-config`
- the specific plugin repos involved

Only create worktrees for repos that actually participate in the feature.

## Communication Pattern

When starting work, state:

- the feature lane path
- the repo-specific worktree path
- the branch name

Example:

- feature lane: `/Users/kaho/repos/private/qol-tools/worktrees/feat-config-contract-v1/`
- repo worktree: `/Users/kaho/repos/private/qol-tools/worktrees/feat-config-contract-v1/qol-tray`
- branch: `feat/config-contract-v1`

## Push direct vs open an issue + PR

When work happened on a worktree branch, PR ceremony is still optional. After the work is done, two routes exist.

| Route | When | Flow |
|---|---|---|
| **Push direct to main** | Default for all work, including work that happened on a branch. | Commit freely while iterating → update local main clone → `git merge --squash <feature-branch>` there → commit on local `main` → `git push origin main` → delete branch → `git worktree remove`. No issue, no PR. |
| **Issue + PR** | Only when the user explicitly asks for a PR or issue-backed review. | Create issue only if asked or genuinely needed → branch + worktree → `gh pr create --draft` → mark ready when approved → GitHub squash-merge into `main`. |

Do not infer PR from blast radius. If unsure whether the user wants a branch or PR, ask; otherwise land directly on `main`.

The `qol-skills` marketplace and similar low-blast-radius repos are the canonical home of the no-PR route. If a worktree branch already exists for that change, squash and push it as below.

### Direct push, concretely

```bash
FEAT=docs-clarify-daemon-lifecycle
git -C <main-clone> worktree add ../worktrees/$FEAT/<repo> -b $FEAT
cd ../worktrees/$FEAT/<repo>
# … edit, commit freely while iterating …

git status --short  # worktree must be clean; commit/stash first if not
cd <main-clone>
git status --short  # main clone must be clean too
git pull --ff-only origin main
git merge --squash $FEAT
git commit -m "docs: clarify daemon lifecycle"
git push origin main
git push origin --delete $FEAT  # if a remote branch exists
git worktree remove ../worktrees/$FEAT/<repo>
git -C <main-clone> branch -D $FEAT  # if local branch lingers
```

The branch existed only as a delivery vehicle; nothing references it after the push. If the squash merge conflicts, stop and resolve the merge in the main clone; do not delete the worktree until `main` has been pushed successfully.

## Do Not

- Do not pretend multiple repos share one Git worktree.
- Do not mix unrelated feature branches in the same feature lane.
- Do not default back to repo-first worktree placement for coordinated QoL feature work unless there is a clear reason.
- Do not branch from a main clone to "save time". The hook will block you, and the recovery cost is higher than the worktree-add you avoided.
- Do not run skill / hook / doc edits through the issue + PR flow. The ceremony is for product code; the direct-push route exists for everything else.
