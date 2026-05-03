---
name: commit
description: >
  Commit message conventions for qol-tools repos. Use this skill EVERY TIME before invoking `git commit`.
  The hard rule is: NEVER add Co-Authored-By, "Generated with Claude", or any Anthropic attribution.
  Loaded automatically by the pre-commit hook in qol-host.
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
have to re-attempt with a clean message.

## Format

```
type(scope?): short imperative summary

optional body explaining WHY when non-obvious
```

- `type`: `feat`, `fix`, `refactor`, `chore`, `docs`, `test`, `perf`, `wip`, `style`
- `scope` is optional; use it when a single area is touched (`fix(minimap): ...`)
- Subject in imperative mood ("Add", not "Added" / "Adds")
- No trailing period in the subject
- Wrap body at ~72 chars
- One logical change per commit when not WIP; squash-friendly WIP is allowed on
  feature branches

## What to write

- Why the change is needed (when not obvious from the diff)
- What user-visible behavior changes
- Any non-obvious tradeoff or constraint

## What NOT to write

- What the diff already shows ("change X to Y in file Z")
- File paths or line numbers — those are in the diff
- Marketing/AI attribution (see hard rule above)
- Internal task IDs unless the repo convention requires them (qol-tools repos
  do not — the Brunata AGI repo does, see that plugin's commit skill)

## HEREDOC template (safe)

```
git commit -m "$(cat <<'EOF'
fix(minimap): clamp viewport rect to canvas bounds

Off-screen pages were drawing the rect outside the visible area, making
the active-page indicator drift when the camera was at the far edge.
EOF
)"
```

Note the absence of any `Co-Authored-By` line. That is intentional and
permanent.
