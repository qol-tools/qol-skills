---
name: git-trees
description: Use when creating or organizing coordinated multi-repo git worktrees for QoL features, experiments, or A/B testing across qol-tray, plugins, and shared repos.
---

# git-trees

Use this skill when a change spans multiple QoL repos and should be developed as one coordinated feature lane.

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

## Do Not

- Do not pretend multiple repos share one Git worktree.
- Do not mix unrelated feature branches in the same feature lane.
- Do not default back to repo-first worktree placement for coordinated QoL feature work unless there is a clear reason.
