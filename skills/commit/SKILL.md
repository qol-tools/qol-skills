---
name: commit
description: Use when the user asks for a commit message or asks to create commits. Produces concise one-line conventional commit messages and safe commit workflow guidance.
---

# Commit Skill

## When To Use

Use this skill when the user asks to:
- suggest a commit message
- commit current changes
- split changes into multiple commits
- improve or rewrite a commit message

## Rules

- Prefer one-line conventional commit messages.
- Keep messages short and specific.
- Do not use multi-line commit bodies unless explicitly requested.
- Do not add co-author lines.
- Do not amend existing commits unless explicitly requested.
- Do not commit unrelated files.
- Never use `style:` as a commit type. Formatting fixes are `fix:`, not `style:`.
- **NEVER push after committing.** Commit is commit-only. Pushing requires a separate explicit request from the user.

## Message Format

`<type>: <short summary>`

Common types:
- `feat`: new functionality
- `fix`: bug fix (including formatting/lint fixes)
- `refactor`: internal restructuring without behavior change
- `test`: tests added/updated
- `docs`: documentation updates
- `chore`: tooling/config/maintenance

## Selection Heuristics

- User-visible behavior change: `feat` or `fix`
- Structural cleanup with same behavior: `refactor`
- Test-only change: `test`
- Docs-only change: `docs`
- IDE/config/build metadata change: `chore`

## Output Style

When asked for a commit message, return only one recommended message first.
If useful, provide up to 3 alternatives after the primary suggestion.
