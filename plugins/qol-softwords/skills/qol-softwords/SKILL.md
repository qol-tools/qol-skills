---
name: qol-softwords
description: Use when changing which words qol-softwords replaces, when a curse word survived a prompt, or when scrubbing past agent history. Covers the word map, the per-CLI live-rewrite limits, and the retroactive pass.
---

# qol-softwords

Replaces the user's curse words with soft equivalents.

## Word map

`bin/words.json` ships the defaults. A file at `~/.config/qol-softwords/words.json`
replaces it wholesale, and `QOL_SOFTWORDS_FILE` overrides both. Keys are matched
case-insensitively on word boundaries, longest key first, and the replacement
copies the source casing (`WTF` becomes `WHAT THE HECK`).

## What each CLI can do live

pi rewrites the prompt before the model sees it: the generated extension turns
`hookSpecificOutput.updatedPrompt` into a `{ action: "transform", text }` input
result.

Claude Code cannot. Its `UserPromptSubmit` hook may only add context or block, so
`updatedPrompt` is ignored there and the model still sees the original wording.
The `Stop` hook scrubs the session transcript afterwards, so the stored history
is clean even though the live turn was not.

## Retroactive pass

`node bin/soften-history.cjs` reports what would change across `~/.claude/projects`,
`~/.codex/sessions`, `~/.pi/agent/sessions` and the qol-memory store. `--apply`
writes; `--only <label>` restricts to one of `claude`, `codex`, `pi`, `qol-memory`.

Only user-authored text is touched: a record's `content` under `role: "user"`,
a qol-memory unit with `kind: "user"`, and a launcher retrieval's `query`. Tool
results, assistant turns and file content are left alone.

Rewriting `units.jsonl` invalidates the qol-memory seal, so the pass deletes
`units.seal.gz` and `units.seal.json` and asks for `qol-memory reindex`. The
store falls back to the raw units file when the seal is absent.
