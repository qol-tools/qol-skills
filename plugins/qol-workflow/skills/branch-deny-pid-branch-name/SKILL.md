---
name: branch-deny-pid-branch-name
description: Use when a branch-creation command is blocked with a "looks PID-prefixed" message, or when naming a new qol branch. Blocks PID-prefixed branch names (`^[a-z]+-\d+(-|$)` like `tray-32-foo`) in any qol-* repo; use ` # intentional` to bypass for genuine one-off PID branches.
---

# branch-deny-pid-branch-name

## The rule

qol worktree branches use **topic-led names** (e.g. `wasm`, `theming`, `sync-v2`), never PID-prefixed names.

`qol dev <worktree>` selects the dev build by branch name, and a topic outlives any single issue or PR.
PID-prefixed names (`tray-32-integration`) tie the branch to one issue and go stale the moment the issue closes.

See `qol-workflow:git-trees`, section "Branch naming", for the full convention.

## What this hook blocks

When the effective cwd has a `qol-*` path component (the monorepo, its worktrees, qol-skills), these commands fail when `<NAME>` matches `^[a-z][a-z0-9]*-\d+(-|$)`:

- `git checkout -b <NAME>` / `git checkout -B <NAME>`
- `git switch -c <NAME>` / `git switch -C <NAME>`
- `git worktree add ... -b <NAME>`
- `git branch <NAME>` (positional creation form only)

The hook reads the Bash payload, identifies the branch name the command would create, checks it against the PID regex, and emits `permissionDecision: "deny"` on stdout with `exit 0` so the user sees a clear reason in the CLI without the `Bash hook error:` block.

## What stays allowed

- Topic names: `git checkout -b wasm`, `git switch -c theming`, `git worktree add ../worktrees/wasm/qol-monorepo -b wasm`
- All non-creation git ops: `git checkout main`, `git status`, `git push`, `git branch -d <stale>`, `git branch -m <old> <new>`
- Commands outside any `qol-*` repo
- Genuinely one-off PID branches: append ` # intentional` to the command, e.g.

```bash
git checkout -b tray-99-only-here  # intentional: throwaway bisect branch
```

## Layered with other qol-workflow hooks

- `branch-deny-checkout-in-main-clone` -- still blocks branching off `main` from the main clone.
- `branch-deny-agent-checkout` -- still asks the user for approval on every checkout / switch.
- `branch-deny-pid-branch-name` (this hook) -- adds a deterministic NAME-shape gate on top of the above.
