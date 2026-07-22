---
name: git-push
description: Use when the user asks to push a repo or branch. Verifies local branch state, syncs with the remote using git pull --rebase before pushing, and handles divergence safely for the qol workspace repos.
---

# git-push

Use this skill when the user asks to push a branch or update a remote.

## Never push without an explicit ask

Never run `git push` or another remote-affecting git command unless the user explicitly asked for a push in the current turn. A request to commit is not a request to push.

An explicit combined request such as "commit and push" authorizes both operations in the same turn. Keep them as separate commands and verify the commit before pushing; do not require another user round trip between them.

This applies to every repo in the qol-tools workspace: qol-tray, qol-cicd, qol-skills, qol-host, plugin repos, etc.

## Mandatory Rule

The `qol-cicd` repo continuously automates all `qol-*` repos and related workspace repos.

Because of that, always run `git pull --rebase` before `git push`.

Do not assume `origin/<branch>` is unchanged, even if the local repo looked current a moment ago.

In `qol-monorepo`, apply the mandatory `Cargo.lock` merge-driver contract from
`qol-workflow:git-trees` before the pull/rebase. Never replace the configured
driver with a manual lockfile conflict resolution.

## Match the checkout to the branch

- Direct-to-`main` work belongs in the main clone and may be pushed from there when requested.
- Feature branches belong in worktrees. Follow `git-trees` for creation and delivery.
- Never push a worktree branch directly to `main`. Deliver it through the documented squash route in the main clone.
- If a main clone is unexpectedly on a feature branch, follow the `git-trees` recovery flow instead of normalizing the mistake.

## Workflow

1. Check the repository root, branch, upstream, worktree location, and dirty state. Confirm that `main` is in the main clone or that a feature branch is in its worktree.
2. Confirm the requested repository and branch. Call out unrelated dirty changes before any pull, rebase, or push.
3. **Run the repo-native verification workflow first.** If the repo defines `make build`, `make test`, or an equivalent project script, run that exact workflow before raw tool commands.
4. **Run the CI-equivalent lint and test suite for the affected scope.** Prefer the repository's affected-target planner or documented verification command. For a standalone Rust repo without a more specific workflow, use:
   ```bash
   cargo fmt -- --check
   cargo clippy --all-targets --all-features --keep-going -- -D warnings
   cargo test --all-features
   ```
   `cargo check` or `cargo test` alone is NOT sufficient — clippy is what CI enforces.
   `--keep-going` is mandatory so all errors are reported in one pass.
   If a project-local skill defines a stricter stack, use that stack instead of the generic Rust trio above.
5. If ANY verification command fails, STOP. Fix ALL errors, re-run, and only proceed when everything passes clean.
6. Ensure the checkout is clean, then run `git pull --rebase` for that branch before pushing. If the explicit request included uncommitted work, commit it first as a separate operation.
7. If rebase conflicts occur, stop and report them clearly.
8. Push only after repo-native verification, lint, clippy, tests, and rebase all pass cleanly.
9. Fetch immediately after the push and compare `HEAD` with `origin/<branch>`. Release automation may create a version-only descendant commit as soon as the push lands.
10. If the remote is strictly ahead by expected automation commits, run `git pull --ff-only` and verify the checkout is clean and synchronized. If histories diverged or the remote commit is unexpected, stop and report instead of guessing.

**NEVER push based on partial verification. NEVER fix-commit-push iteratively. Get it right locally first.**

## Guardrails

- Never force-push unless the user explicitly asks for it.
- Never discard local changes to make a push succeed.
- If the checkout has unrelated dirty changes, call that out before pulling or pushing.
- If the target is `main`, be especially strict about rebasing first.
- Do not report "pushed and synchronized" until a post-push fetch confirms it.

## Troubleshooting auth failures

If `git push` fails with `Permission to qol-tools/<repo>.git denied to <other-account>` and HTTP 403, the remote is HTTPS and the macOS credential helper is serving a credential bound to the wrong account (typically a work GitHub login).

Every qol-tools repo on this workstation is expected to use the SSH alias:

```
git@github-priv:qol-tools/<repo>.git
```

Fix by switching the remote, then retry the push:

```
git remote set-url origin git@github-priv:qol-tools/<repo>.git
git push
```

Before doing this, peek at a sibling qol-tools repo (`qol-tray`, `qol-cicd`, etc.) to confirm the SSH alias is the canonical pattern — do not invent a host alias.
