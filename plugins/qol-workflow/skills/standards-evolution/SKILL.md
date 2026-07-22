---
name: standards-evolution
description: Use when you discover a practice, library, pattern, tool, or workflow that improves an existing workspace standard, BEFORE applying it. Encodes the rule that improvements must be written into the appropriate skill or CLAUDE.md FIRST so that the next session starts from the new baseline. Triggers on phrases like "I noticed", "this is better than", "we should be using X", "modern best practice", "10x engineers do", or any time you would otherwise apply a one-off improvement that should become a standard.
---

# standards-evolution

The hard rule: **encode improvements before applying them.** Standards drift if every session reinvents them. A practice you apply ad-hoc this session is a practice the next session does not know about - which means cosmetic regression, debate replay, and inconsistency that compounds over time.

## When this fires

Any time you find yourself thinking, suggesting, or about to apply something that improves the existing workspace standard. Examples:

- "I should use `insta` snapshots here instead of inline JSON asserts" - encode in `qol-tray:qol-apps-testing` first.
- "This is a cleaner Rust idiom than what's in the repo" - encode in `qol-langs:rust-conventions` first.
- "We should be running `cargo-mutants` periodically" - encode in `qol-tray:qol-apps-testing` first.
- "Modern PR flows skip ceremony for trivial changes" - encode in `qol-workflow:git-trees` first.

## The procedure

1. **Source-check** the claim. Use primary library docs/source for dependency behavior and primary references for practice claims. Anchor mutable versions to the owning manifest/lockfile and state the revalidation trigger. Use a date only when it identifies a stable specification or incident that the reader must retrieve. Don't encode hearsay.
2. **Pick the owning skill or doc.** Each area has exactly one home:

   | Area | Home |
   | --- | --- |
   | Testing patterns, frameworks, fixtures | `qol-tray:qol-apps-testing` |
   | Rust idioms, error handling, FS, process mgmt | `qol-langs:rust-conventions` |
   | Preact + htm patterns | `qol-langs:preact-conventions` |
   | gpui patterns | `qol-langs:gpui-conventions` |
   | Branch / worktree / PR ceremony | `qol-workflow:git-trees` |
   | Commit format | `qol-workflow:commit` |
   | Push / pull / rebase rules | `qol-workflow:git-push` |
   | Universal coding + brevity | `qol-workflow:coding-general` |
   | Cross-cutting principles, code style invariants | top-level workspace `CLAUDE.md` |

   If two skills could plausibly own it, the more specific one wins. If none does, ask the user where it should live - do not invent a new skill silently.

3. **Write the rule into ONE place only.** No duplicating across skills. If a rule is relevant to multiple areas, put the canonical text in one home and CROSS-LINK from the other (single sentence + link, never the full restatement).

4. **Keep the rule short.** Add the minimum prose that conveys the rule and the why. If you find yourself writing more than ~150 lines into a single skill, split it - but split by area, not by "old vs new".

5. **Apply the improvement** to the current task only after step 4 is committed.

## Anti-patterns to refuse

- **Apply now, encode later.** "Later" never happens; the lesson dies with the session.
- **Encode in multiple skills.** If the rule shows up in two skills, one of them is wrong. Pick the owning skill, link from the other.
- **Create a new skill instead of updating an existing one.** New skills cost trigger-space. Update the existing owner unless the user asks for a new skill explicitly.
- **Encode unverified claims.** "I saw this somewhere" is not a source. context7 the library or web-search the practice; cite version + date.
- **Inflate skills.** Every line in a skill costs tokens at load. Trim before adding.

## Determinism + token discipline

Skills load on description-match. The cost: every loaded skill burns tokens whether or not it ends up being relevant. The discipline:

- **One trigger area per skill.** If a skill's description tries to cover two areas, split it.
- **Use specific trigger phrases in the description**, not vague terms. "Use when writing tests" beats "Use for code quality".
- **CLAUDE.md is for always-on rules**. Anything you want loaded *every* session goes there - but kept SHORT (under 200 lines per CLAUDE.md, per docs.claude.com).
- **Skills are for on-demand expansion**. A skill is the right home when the rule is detailed enough that always-loading it would waste tokens for sessions that don't touch the area.
- **No content duplication between CLAUDE.md and a skill.** CLAUDE.md states the rule briefly and points to the skill for the workflow. Skill states the workflow without restating the rule.

## What this skill is NOT

- It is not a license to write a skill for every minor preference. Use it for genuine practice upgrades, not bikeshed.
- It is not a replacement for asking the user. If unsure whether something is an improvement, ask first.
