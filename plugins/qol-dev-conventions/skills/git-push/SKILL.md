---
name: git-push
description: Use when the user asks to push a repo or branch. Verifies local branch state, syncs with the remote using git pull --rebase before pushing, and handles divergence safely for the qol workspace repos.
---

# git-push

Use this skill when the user asks to push a branch or update a remote.

## Never push without an explicit ask

Never run `git push` (or any remote-affecting git command) on the user's behalf unless they explicitly asked for a push in the current turn. After `git commit`, stop and report. Do not chain a push into the same step.

The user wants a chance to review the commit and amend before code leaves their machine. Pushing prematurely removes that safety window — even an immediate amend turns into a force-push later. "Commit" is not a license to push.

This applies to every repo in the qol-tools workspace: qol-tray, qol-cicd, qol-skills, qol-host, plugin repos, etc.

## Mandatory Rule

The `qol-cicd` repo continuously automates all `qol-*` repos and related workspace repos.

Because of that, always run `git pull --rebase` before `git push`.

Do not assume `origin/<branch>` is unchanged, even if the local repo looked current a moment ago.

## Workflow

1. Check the current branch and worktree state.
2. Confirm which repo and branch should be pushed.
3. **Run the repo-native verification workflow first.** If the repo defines `make build`, `make test`, or an equivalent project script, run that exact workflow before raw tool commands.
4. **Run the FULL CI-equivalent lint+test suite locally.** For Rust repos, this means:
   ```bash
   cargo fmt -- --check
   cargo clippy --all-targets --all-features --keep-going -- -D warnings
   cargo test --all-features
   ```
   `cargo check` or `cargo test` alone is NOT sufficient — clippy is what CI enforces.
   `--keep-going` is mandatory so all errors are reported in one pass.
   If a project-local skill defines a stricter stack, use that stack instead of the generic Rust trio above.
5. If ANY verification command fails, STOP. Fix ALL errors, re-run, and only proceed when everything passes clean.
6. Run `git pull --rebase` for that branch before pushing.
7. If rebase conflicts occur, stop and report them clearly.
8. Push only after repo-native verification, lint, clippy, tests, and rebase all pass cleanly.

**NEVER push based on partial verification. NEVER fix-commit-push iteratively. Get it right locally first.**

## Guardrails

- Never force-push unless the user explicitly asks for it.
- Never discard local changes to make a push succeed.
- If the checkout has unrelated dirty changes, call that out before pulling or pushing.
- If the target is `main`, be especially strict about rebasing first.
