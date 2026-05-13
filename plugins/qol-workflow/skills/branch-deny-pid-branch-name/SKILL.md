---
name: branch-deny-pid-branch-name
description: Blocks creation of PID-prefixed git branch names (`^[a-z]+-\d+(-|$)` like `tray-32-foo`, `alttab-2-bar`) inside any qol-tools repo. Coordinated work across qol-tray + plugin repos must share a single topic name so qol-tray's Active Worktree Branch picker can switch all dev-linked plugins together. Use ` # intentional` suffix to bypass for genuine single-repo PID branches. Pairs with the `qol-workflow:git-trees` "Cross-repo dev recompile loop" section.
---

# branch-deny-pid-branch-name

## The rule

Coordinated work across qol-tray and any plugin repo must use a **single topic-led branch name** (e.g. `wasm`, `theming`, `sync-v2`).

qol-tray's dev mode exposes an "Active Worktree Branch" picker (Settings, dev panel; persisted at `~/.config/qol-tray/dev/active-worktree.txt`). The selected branch name is applied to every dev-linked plugin repo: each plugin resolves to its worktree on that branch if one exists, else falls back to `main`. PID-prefixed names cannot serve this role because the PID is qol-tray-specific and no plugin repo will ever carry a matching branch.

See `qol-workflow:git-trees` -> "Cross-repo dev recompile loop" for the full convention.

## What this hook blocks

Inside `/media/kmrh47/WD_SN850X/Git/qol-tools/**`, these commands fail when `<NAME>` matches `^[a-z][a-z0-9]*-\d+(-|$)`:

- `git checkout -b <NAME>` / `git checkout -B <NAME>`
- `git switch -c <NAME>` / `git switch -C <NAME>`
- `git worktree add ... -b <NAME>`
- `git branch <NAME>` (positional creation form only)

The hook reads the Bash payload, identifies the branch name the command would create, checks it against the PID regex, and emits `permissionDecision: "deny"` on stdout with `exit 0` so the user sees a clear reason in the CLI without the `Bash hook error:` block.

## What stays allowed

- Topic names: `git checkout -b wasm`, `git switch -c theming`, `git worktree add ../worktrees/qol-tray/wasm -b wasm`
- All non-creation git ops: `git checkout main`, `git status`, `git push`, `git branch -d <stale>`, `git branch -m <old> <new>`
- Commands outside the qol-tools workspace (the hook only fires when the effective cwd is under `/media/kmrh47/WD_SN850X/Git/qol-tools/`)
- Genuinely single-repo work: append ` # intentional` to the command, e.g.

```bash
git checkout -b tray-99-only-here  # intentional: single-repo refactor, no plugin coordination
```

## Layered with other qol-workflow hooks

- `branch-deny-checkout-in-main-clone` -- still blocks branching off `main` from the main clone.
- `branch-deny-agent-checkout` -- still asks the user for approval on every checkout / switch.
- `branch-deny-pid-branch-name` (this hook) -- adds a deterministic NAME-shape gate on top of the above.
