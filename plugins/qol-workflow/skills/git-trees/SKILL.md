---
name: git-trees
description: Use whenever modifying files, creating commits, or creating, switching, or branching in the qol-monorepo or qol-skills repo. Defines completion-as-commit, the mandatory Cargo.lock merge driver, the branch-based worktree workflow, the direct-vs-PR route, and final squash delivery.
---

# git-trees

Use this skill whenever work modifies a qol repo, and any time a change is made on a branch other than `main`.
The qol-tools workflow is **worktrees-only**: the main clone MUST stay on `main` forever.
Feature branches live in dedicated worktree directories.

## The hard rule (read this first, every time)

**Default changes do NOT get a PR.** Tests, configs, rules, hooks, skill edits, doc fixes, lockfile bumps, normal fixes, refactors, and features commit straight to `main` unless the user asks for branch isolation or a PR. No draft PR. No mark-ready. No squash-merge dance.

**There are only two normal modes:** direct work on `main`, or feature-branch work in a worktree.
If the user asks for a branch, PR, or isolated review, create a worktree.
If the change is direct-to-main, stay on `main` in the main clone.

**If unsure, ASK first.** Don't default to ceremony. Asking takes 30 seconds; an unwanted PR wastes 5+ minutes on both sides and creates noise.

**NEVER `git checkout -b`, `git checkout <other-branch>`, `git switch -c`, or `git switch <other-branch>` inside a qol main clone.**

The branch-switch ban is enforced by the `branch-deny-checkout-in-main-clone` PreToolUse hook.
It exists to keep the main clone on `main` so `qol sync` and `qol dev` see fresh code.
Direct-to-main work happens on `main` without switching branches.

## Cargo.lock uses a mandatory merge driver

In `qol-monorepo`, never resolve a root `Cargo.lock` conflict by hand, choose
ours/theirs, or discard one side. The lockfile is derived from the workspace
manifests and has a repository-owned auto-resolution contract:

- `.gitattributes` assigns `/Cargo.lock` to `merge=cargo-lock`.
- `qol setup` registers `merge.cargo-lock.driver` as
  `.githooks/cargo-lock-merge %O %A %B %P` in the clone's Git config.
- The driver keeps a candidate lockfile and asks Cargo to reconcile it against
  the already-merged workspace manifests.

Before a pull, rebase, merge, or cherry-pick that can touch `Cargo.lock`, verify
the contract rather than assuming another agent or clone configured it:

```bash
git check-attr merge -- Cargo.lock
git config --get merge.cargo-lock.driver
```

The first command must report `Cargo.lock: merge: cargo-lock`; the second must
report `.githooks/cargo-lock-merge %O %A %B %P`. If the config is absent or
different, run `qol setup` from the monorepo checkout before starting the Git
operation. After the driver runs, use the repository verification workflow to
prove the regenerated lockfile matches the merged manifests.

## Completion means committed

A task that modifies repository files is not complete until the changes owned by that task are committed locally. Create the scoped commit without waiting for a separate user prompt unless the user explicitly asks to leave the work uncommitted or inspect the diff first. A safe commit requires the build, test, format, and lint gate in `qol-workflow:qol-monorepo-rules` to pass with real output before committing.

- Stage only the task's files or hunks; preserve unrelated dirty work.
- When hunk-staging a shared generated file or lockfile, validate the exact index tree independently; a passing dirty worktree does not prove the commit is self-consistent.
- Create one coherent commit in each affected repository.
- If a safe commit is blocked, report the blocker instead of claiming completion.
- A commit never implies a push. Push only when explicitly requested.

Follow `qol-workflow:commit` for message and hook rules before invoking `git commit`.

### Why

- The main clone is what `qol sync` and `qol dev` operate on. If it sits on a stale feature branch, sync silently tracks the feature branch while `main` quietly drifts behind, and the next `qol dev` runs against out-of-date code.
- After a PR merges with `--delete-branch`, the local feature branch in the main clone becomes orphaned - its remote tracking branch is gone, but the working tree is still checked out on it.
- Worktrees are cheap and isolate this entirely. The main clone stays pristine.

### What the hook allows

- `git checkout main` / `git checkout master` / `git switch main` (returning to main is always fine)
- `git checkout -- <files>` (path checkout, not branch switch)
- `git checkout HEAD~1` / `git checkout <SHA>` (revision checkout)
- Anything inside a `worktrees/<feature>/` directory (you're already in a worktree - branch ops are expected)
- Any command suffixed with ` # intentional` (rare recovery path; document why in the same turn)

## PRs are opt-in. Default is commit-direct-to-main.

**The qol-tools workspace is solo.** There is no async team to coordinate with via PR. PRs add review-cycle ceremony that is pure friction when the only reviewer is the same person who wrote the code. Default behaviour: edit on `main`, `git add && git commit`, push when asked.

**Open a PR ONLY when the user explicitly asks for one** with phrases like "open a PR", "draft a PR", or "make a PR for this". A request to review/test on a branch means "use a worktree branch"; it does not imply PR. **Never offer "or open a PR" as a fallback option** in a "Want me to fix or X?" prompt - drop the X. The choice is fix-now-direct-or-not-now.

### Tests, refactors, fixes, features

All commit direct to `main` by default, including substantive `src/` / `ui/` changes.
The user is the reviewer; they review by reading the commit on `main`, not by clicking through PR UI.
If they want to inspect first, they will say so explicitly.

### Bundled commits are fine on main

Tests + a small refactor that makes them testable, in the same atomic commit, is fine when committing direct.
Atomic-commit rule still holds (one logical change per commit, repo always green).

## Final delivery invariant

**A worktree branch is a staging area, not the contribution unit.** It may contain many WIP, review, or fixup commits while the user and agents iterate. Before it reaches `main`, bring the branch diff into the local main clone as **one polished conventional commit** unless the user explicitly asks for multiple delivered commits.

This applies to both routes:

- **Direct route:** from the main clone, `git merge --squash <feature-branch>`, commit, then push `main`. Never push `HEAD:main` directly from the worktree.
- **PR route:** open/review from the worktree branch, then use GitHub squash merge. Do not merge-commit or rebase-merge the branch stack into `main`.

If an agent thinks a worktree should land as multiple commits, it must ask first and name the independently revertible deliveries.

After the squashed feature lands on `main`, clean up: delete the remote feature branch if it exists, delete the local feature branch if it lingers, and remove the worktree directory.

The direct route always pushes from the main clone, not from the worktree.
This keeps local `main` and `origin/main` moving together and prevents a worktree push from stranding unpublished commits.

## Layout

Worktrees live in a `worktrees/` directory next to the main clone, one feature directory each:

```text
<parent>/qol-monorepo/                          # main clone, always on main
<parent>/worktrees/<feature>/qol-monorepo/      # worktree on branch <feature>
```

`<feature>` matches the branch name.

## Branch naming

- Pick names that are **short, stable, and topic-led** (`wasm`, `theming`, `sync-v2`).
- **Do NOT use PID-prefixed branch names** (`tray-32-integration`). The `branch-deny-pid-branch-name` hook blocks them. `qol dev <worktree>` selects the dev build by branch name, and a topic outlives any single issue or PR.

## Creation flow, concretely

```bash
FEAT=sync-v2
ROOT=$(git rev-parse --show-toplevel)
git worktree add $ROOT/../worktrees/$FEAT/qol-monorepo -b $FEAT
cd $ROOT/../worktrees/$FEAT/qol-monorepo
# ... edit and commit freely while iterating ...
```

Delivery and cleanup:

```bash
git status --short          # worktree must be clean; commit/stash first if not
cd $ROOT                    # back to the main clone
git status --short          # main clone must be clean too
git pull --ff-only origin main
git merge --squash $FEAT
git commit -m "feat: one polished summary"
git push origin main        # only when the user asked for a push
git push origin --delete $FEAT   # if a remote branch exists
git worktree remove ../worktrees/$FEAT/qol-monorepo
git branch -D $FEAT         # if the local branch lingers
```

The branch existed only as a delivery vehicle; nothing references it after the push.
If the squash merge conflicts, stop and resolve the merge in the main clone; do not delete the worktree until `main` has been pushed successfully.

## Recovery: the main clone is already on a feature branch

If you discover the main clone is on a non-main branch (typically because the hook didn't exist yet):

```bash
git stash --include-untracked   # only if dirty
git checkout main               # always allowed by the hook
git pull --ff-only
git stash pop                   # if you stashed
git branch -D <orphan-branch>   # if the merged branch lingers
```

If the work on the feature branch was unmerged and worth saving, push it first to a remote, then create a worktree at the same branch and continue work there.

## Do Not

- Do not mix unrelated feature branches in the same feature directory.
- Do not branch from the main clone to "save time". The hook will block you, and the recovery cost is higher than the worktree-add you avoided.
- Do not run skill / hook / doc edits through the issue + PR flow. The ceremony is for product code; the direct-push route exists for everything else.
