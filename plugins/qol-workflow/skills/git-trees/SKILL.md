---
name: git-trees
description: Use whenever modifying files, creating commits, or creating, switching, or branching in the qol-monorepo or qol-skills repo. Defines completion-as-commit, the mandatory Cargo.lock merge driver, the worktree-and-PR route every change takes, the explicit-ask exception for direct-to-main, and final squash delivery.
---

# git-trees

Use this skill whenever work modifies a qol repo, and any time a change is made on a branch other than `main`.
The qol-tools workflow is **worktrees-only**: the main clone MUST stay on `main` forever.
Feature branches live in dedicated worktree directories.

## The hard rule (read this first, every time)

**Every change gets a worktree and a PR.** Tests, configs, rules, hooks, skill edits, doc fixes, lockfile bumps, normal fixes, refactors, and features all start on a branch in a new worktree and land on `main` through a pull request with auto-merge armed.

**Never commit to `main` directly** unless the user explicitly asks for a direct-to-main change, or you asked and they approved it for this change. Approval covers that one change, not the next.
A commit on local `main` is the mistake this rule exists to prevent; create the worktree before the first edit.

**NEVER `git checkout -b`, `git checkout <other-branch>`, `git switch -c`, or `git switch <other-branch>` inside a qol main clone.**

The branch-switch ban is enforced by the `branch-deny-checkout-in-main-clone` PreToolUse hook.
It exists to keep the main clone on `main` so `qol sync` and `qol dev` see fresh code.
Work happens in worktrees, so the main clone never needs to switch branches.

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

## Worktree and PR by default. Direct-to-main only on an explicit ask.

The user set this on 2026-10-08: "always create worktrees and PRs - never directly to main unless specifically asked to do so or with approval".
CI and the merge queue gate every change before it reaches `main`, and the PR is where the qol-code-review bot reviews it.

- **Default route:** worktree branch, commit, push the branch, `gh pr create`, `gh pr merge --auto <number>`, then watch it with `bin/pr-watch.cjs` until it merges.
- **Direct route:** only when the user explicitly asks for a direct-to-main change in the current request, or approves your question for this change. A request to "commit" or "push" alone is not that ask.
- Do not ask for direct-to-main approval to save time; the PR route is the default, not the fallback.

### Bundled commits are fine in one PR

Tests + a small refactor that makes them testable, in the same atomic commit, is fine.
Atomic-commit rule still holds (one logical change per commit, repo always green).

## Final delivery invariant

**A worktree branch is a staging area, not the contribution unit.** It may contain many WIP, review, or fixup commits while the user and agents iterate. Before it reaches `main`, bring the branch diff into the local main clone as **one polished conventional commit** unless the user explicitly asks for multiple delivered commits.

This applies to both routes:

- **PR route (default):** open the pull request from the worktree branch and run `gh pr merge --auto <number>` right after `gh pr create` (after `gh pr ready` for a draft); the merge queue squashes it once its checks pass. Then watch it until it merges with `bin/pr-watch.cjs` as one background command and fix what fails (qol-workflow:qol-monorepo-rules, "Every pull request is watched until it merges"). Do not merge-commit or rebase-merge the branch stack into `main`.
- **Direct route (explicit ask only):** from the main clone, `git merge --squash <feature-branch>`, commit, then push `main`. Never push `HEAD:main` directly from the worktree.

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

Delivery through a pull request (the default):

```bash
git push -u origin $FEAT
gh pr create --title "<type>(scope): summary" --body "<why>"
gh pr merge --auto <number>
node <qol-workflow>/bin/pr-watch.cjs <pr-url> --pretty   # one background command
```

After it merges, `git worktree remove ../worktrees/$FEAT/qol-monorepo` from the main clone and `git branch -D $FEAT` if the local branch lingers.

Direct delivery, only when the user explicitly asked for a direct-to-main change:

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
- Do not skip the PR for skill, hook, or doc edits. They take the same worktree and PR route as product code; issues stay opt-in.
