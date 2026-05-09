---
name: git-trees
description: Use this when creating, switching, or branching in any qol-* repo. Defines the mandatory worktree-only workflow — branching from a main clone is blocked by a hook.
---

# git-trees

Use this skill any time a change is made on a branch other than `main` in a qol-* repo. The qol-tools workflow is **worktrees-only**: the main clone of every repo MUST stay on `main` forever. Feature branches live in dedicated worktree directories.

## The hard rule (read this first, every time)

**Trivial changes do NOT get a PR.** This is the rule that gets forgotten. Tests, configs, rules, hooks, skill edits, doc fixes, lockfile bumps - commit them STRAIGHT TO MAIN on the main clone. No PID. No worktree. No draft PR. No mark-ready. No squash-merge dance. See "Trivial changes skip the worktree+PR ceremony" below for the full list.

**Substantive source changes use worktrees.** A worktree+PR is for behaviour changes that need a diff-review and CI gate, not for unit tests, not for refactors that ship alongside trivial work, and not for "while I was here" adjacent commits.

**If unsure, ASK first.** Don't default to ceremony. Don't mint a PID without checking. Asking takes 30 seconds; an unwanted PR wastes 5+ minutes on both sides and creates noise.

**NEVER `git checkout -b`, `git checkout <other-branch>`, `git switch -c`, or `git switch <other-branch>` inside a qol-* main clone for substantive work.**

The branch-switch ban is enforced by the `branch-deny-checkout-in-main-clone` PreToolUse hook. It exists to keep the main clone on `main` so `qol-sync` and `make dev` see fresh code. The trivial-change carve-out below is how you commit on `main` from the main clone WITHOUT switching branches.

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

**Open a PR ONLY when the user explicitly asks for one** with phrases like "open a PR", "draft a PR", "make a PR for this", "I want to review this as a diff", "I want to test this on a branch first", or names a PID and asks to "kickoff" it. **Never offer "or open a PR" as a fallback option** in a "Want me to fix or X?" prompt - drop the X. The choice is fix-now-direct-or-not-now.

The branch-deny-checkout-in-main-clone hook still applies: branching off `main` inside the main clone is blocked. Editing `main` itself in the main clone is fine and is the normal flow. If the user explicitly asks for a PR, see "Worktree creation" below.

### What still gets PR'd when explicitly requested

- Multi-week initiatives the user wants to retrospect on (rare).
- Anything the user calls out as "diff-review please" or "let me see this on a branch".
- Cross-repo coordinated work where the user wants to review repos together.

### Tests, refactors, fixes, features

All commit direct to `main` by default. Including substantive `src/` / `ui/` changes. The user is the reviewer; they review by reading the commit on `main`, not by clicking through PR UI. If they want to inspect first, they will say so explicitly.

### Bundled commits are fine on main

Tests + a small refactor that makes them testable, in the same atomic commit, is fine when committing direct. Atomic-commit rule still holds (one logical change per commit, repo always green). No need to artificially split tests from the refactor that enabled them.

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
- All repos participating in the same initiative should use the same branch name when practical.
- Group by feature first, repo second.
- Keep the repo directory name equal to the repo identity.
- Use this layout for coordinated testing where `qol-tray` orchestrates multiple plugins or supporting repos.

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
# … edit, commit, push, open PR from here …
```

After the PR merges:

```bash
git -C /Users/kaho/repos/private/qol-tools/qol-tray worktree remove \
  /Users/kaho/repos/private/qol-tools/worktrees/$FEAT/qol-tray
git -C /Users/kaho/repos/private/qol-tools/qol-tray branch -D $FEAT  # if local branch lingers
```

The main clone never changed branches — `qol-sync` will pick up the merge cleanly on its next run.

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

Worktrees are mandatory; ceremony around them is not. After the work is done, two routes exist.

| Route | When | Flow |
|---|---|---|
| **Push direct to main** | Skill edits, hook fixes/tweaks, README/doc updates, test additions, schema-stable refactors — anything where a wrong push can be reverted in under a minute and doesn't affect anyone else. | `git commit` → `git push origin <branch>:main` → delete branch → `git worktree remove`. No issue, no PR. |
| **Issue + PR (arch-pathways)** | New plugin, new hook, schema change, anything cross-cutting in real product code (qol-tray src, plugin daemons, cargo/build infra). | See `arch-pathways` skill — mint an issue with `bin/pid-new`, open a draft PR, mark ready, squash-merge. |

Decision rule, asked literally: **"If this push is wrong, can it be reverted in under a minute without affecting anyone else?"** Yes → direct push. No → issue + PR.

The `qol-skills` marketplace and similar low-blast-radius repos are the canonical home of the direct-push route — `qol-skills/README.md`'s Contributing section has the worked example. The arch-pathways skill explicitly excludes skill, hook, and doc edits.

### Direct push, concretely

```bash
FEAT=docs-clarify-daemon-lifecycle
git -C <main-clone> worktree add ../worktrees/$FEAT/<repo> -b $FEAT
cd ../worktrees/$FEAT/<repo>
# … edit, commit …
git push origin $FEAT:main
git push origin --delete $FEAT
cd - && git -C <main-clone> worktree remove ../worktrees/$FEAT/<repo>
```

The branch existed only as a delivery vehicle; nothing references it after the merge.

The `arch-pathways:check-pr` hook does not enforce branch names — pick whatever name fits. The PID format (`<PREFIX>-<N> Title Case Slug`) is enforced **only** at `gh pr create/edit --title` time, which is the moment a PID actually matters. Direct-push branches never trigger that gate.

## Do Not

- Do not pretend multiple repos share one Git worktree.
- Do not mix unrelated feature branches in the same feature lane.
- Do not default back to repo-first worktree placement for coordinated QoL feature work unless there is a clear reason.
- Do not branch from a main clone to "save time". The hook will block you, and the recovery cost is higher than the worktree-add you avoided.
- Do not run skill / hook / doc edits through the arch-pathways issue + PR flow. The ceremony is for product code; the direct-push route exists for everything else.
