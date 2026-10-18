---
name: commit
description: >
  Commit message conventions for qol-tools repos. Use this skill EVERY TIME before invoking `git commit`.
  The hard rule is: NEVER add Co-Authored-By, "Generated with Claude", or any Anthropic attribution.
  Loaded automatically by the pre-commit hook in qol-workflow.
---

# qol-tools commit conventions

## The hard rule

**NEVER add any of the following to a commit message:**

- `Co-Authored-By: Claude ...`
- `Co-Authored-By: <any AI>`
- `Generated with [Claude Code]`
- `🤖 Generated with ...`
- `noreply@anthropic.com`
- Anything resembling AI attribution, in any form, fuzzy or exact

The author has stated this multiple times. It is non-negotiable. If you forget,
the `commit-deny-coauthor` PreToolUse hook will block the commit and you will
have to re-attempt with a clean message. The same hook checks the body of
`gh pr create`, `gh pr edit` and `gh pr comment`, inline or through
`--body-file`, so pull requests carry no attribution either.

## Format

```
type(scope?): short imperative summary

optional body explaining WHY when non-obvious
```

- `type`: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`, `wip`, `style`
- `scope` is optional; use it when a single area is touched (`fix(alt-tab): ...`)
- Subject in imperative mood ("Add", not "Added" / "Adds")
- Subject at most 72 characters, type and scope included; count it before you
  run `git commit` or `gh pr create`
- In qol-monorepo the scope's first token is a workspace member or umbrella
  (`cli-sessions`, `sessions-engine`, `tray`, `plugins`), never a short form
  such as `sessions`; `. .githooks/commit-msg-lib.sh && qol_derive_scopes .`
  in the checkout prints the list
- No trailing period in the subject
- Wrap body at ~72 chars
- A direct-to-main commit (explicit ask only) is one coherent logical delivery
- Worktree feature branches may contain WIP/fixup commits while iterating, but
  the branch must be squash-merged into the local main clone as one polished
  conventional commit per repo before it lands on `main` unless the user
  explicitly asks for multiple delivered commits

## Pull request titles

A pull request title is a commit subject. The merge queue squashes the pull
request into one commit titled by the pull request, and versioning reads that
subject: `feat` bumps minor, `fix` and `perf` bump patch, `!` or
`BREAKING CHANGE` bumps major, and any other title releases nothing. Title every
pull request `<type>(scope): summary` under the same rules as a commit, and use
the highest-impact type of the commits it carries (one `feat` makes it `feat`).
Always pass `--title`; `--fill` is refused.

Incident: PR #40 was titled "Launcher and settings marks from one drawn set",
so its two `feat` commits never counted. qol-tray and the launcher went out as
patches, and eight plugins whose only change was their icon field were never
released.

Enforced by `bin/pr-deny-unconventional-title.cjs`, which runs the repository's
own `.githooks/commit-msg` on the `gh pr create` / `gh pr edit` title and
refuses `gh pr create` without `--title`. When a leading `cd` names a worktree
of the session's own repository it runs that worktree's gate, so a new plugin's
scope passes; any other directory's gate never runs, since the hook executes
before permission approval. It ignores
`gh pr create` written inside a heredoc body or a quoted string. Its deny names
the actual length against the 72 cap, or the nearest and all allowed scopes.
Incident: 26 PR-title denials in 10 days (over 72 characters 11, unknown scope
7, no `--title` 7), each a retry. Residual: a title built by shell
expansion or set in the web UI is not seen; the merge queue's "Squash subject is
conventional" step refuses it there, and versioning also reads the `* type:`
lines GitHub lists in a squash body.

## Atomic commits

- One logical change per commit.
- Every commit compiles and represents a working state on its own. If checking
  out a commit alone leaves the tree broken, the split is wrong.
- A body explaining WHY is allowed and encouraged when the reason is not
  derivable from the diff. Subject-only is fine when it is.

## Amend, don't stack a fix on a fix

A flaw in a previous **unpushed** commit is fixed by amending that commit, not by
adding a "fix the fix" commit on top. Before `--amend`, check `git log -1`:
concurrent sessions commit to `main` mid-conversation, and amending someone
else's HEAD rewrites their work. Commit with explicit paths
(`git commit -m ... -- <paths>`) so foreign staged changes are never swept in.

## What to write

- Why the change is needed (when not obvious from the diff)
- What user-visible behavior changes
- Any non-obvious tradeoff or constraint

## What NOT to write

- What the diff already shows ("change X to Y in file Z")
- File paths or line numbers - those are in the diff
- Marketing/AI attribution (see hard rule above)
- Internal task IDs unless the repo convention requires them (qol-tools repos
  do not - the Brunata AGI repo does, see that plugin's commit skill)

## HEREDOC template (safe)

```
git commit -m "$(cat <<'EOF'
fix(alt-tab): clamp the picker to the active monitor bounds

On a monitor left of the primary, the picker opened partly off-screen,
hiding the first column of previews.
EOF
)"
```

Note the absence of any `Co-Authored-By` line. That is intentional and
permanent.
