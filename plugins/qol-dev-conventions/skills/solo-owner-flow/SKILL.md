---
name: solo-owner-flow
description: Use in any qol-tools repo (qol-tray, qol-skills, plugins, etc.) where the user is the sole owner. Forbids PR/branch-review framing, optimizes for direct commit-and-push to feature branches.
---

# solo-owner-flow

The user owns every qol-tools repo solo. There is no review queue, no merge bot, no PR template, no reviewer to convince. Treat work as direct commits to the working branch, not as proposals to a team.

## Forbidden framing

Do **not** use PR-shaped language when planning, summarizing, or offering follow-ups:

- "open a draft PR for the cleanup"
- "ship as one PR"
- "land in the next PR"
- "ready for review"
- "draft a PR description"
- "split into multiple PRs"

The user is the author and the only reviewer. There is no PR.

## Use instead

- "commit" / "one cleanup commit" / "two atomic commits"
- "land on `<branch>`"
- "push to `<branch>`"
- "stash and revisit"

When suggesting follow-up work, name the action, not the workflow artifact:
- ❌ "Want me to open a follow-up PR removing the floor?"
- ✅ "Want me to commit the floor removal next?"

## When PR language is allowed

PR framing is only appropriate when working in a non-qol repo where the user is part of a team and reviews are real (e.g. `team-webbill/brunata-angular`, customer repos). The qol-tools workspace is never one of those.

If unsure whether a repo qualifies, look at `git log` — if every recent commit is authored by the user alone, it is solo-owner territory. Use direct-commit framing.

## Why

The user has called this out: framing solo-owner work as "a PR" inflates the ceremony, slows the loop, and signals that I'm matching a generic team workflow instead of how this workspace actually operates. Match the real workflow.
