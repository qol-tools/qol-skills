---
name: fork
description: Cut one problem loose into a detached architect terminal. Use when the user invokes /fork <problem> [--harness H] [--model M] [--effort E] [--surface S] [--park]; writes the brief, picks the launch facts, makes one session_fork call, reports one line, and continues.
argument-hint: "<problem> [--harness H] [--model M] [--effort E] [--surface S] [--park]"
disable-model-invocation: true
---

# fork

## Role

The session turns one problem into one detached fork and keeps its own thread.
The fork reads the brief file the launch points it at, plus a copy of this chat, which `session_fork` writes beside the brief by default.
The brief is authoritative; pass `copy_chat: false` when the chat would mislead or is irrelevant.
This skill writes that brief, chooses the launch facts, makes exactly one `session_fork` call, reports one line, and returns this session to its own work.
A fork is not a lane: it never reports back, nothing collects it with `session_bridge`, and it owns its problem end to end.

## Procedure

1. Write the brief from `$ARGUMENTS` plus the relevant conversation context.
   Include the repo and exact paths, what is wrong or wanted, findings already made, constraints and repo rules that apply, the acceptance check, and what done looks like.
   Spell out every identifier the fork needs (paths, commands, config keys, names), because the chat copy drops tool output and the fork should not have to dig for them.
2. Choose the launch facts.
   - `cwd`: the repo the problem lives in.
   - `key`: a short, stable, unused key naming the tree, for example `chase-lockfile`.
   - `title`: a short human-readable tab name, or omit it to default to the key.
   - `tool`, `model`, `effort`, `surface`: only the values the user gave as trailing `--harness`, `--model`, `--effort` or `--surface` flags in `$ARGUMENTS`, verbatim (`--harness` fills `tool`); leave the flags out of the brief.
   - `park`: `true` only when the user passed `--park`, or when the fork will mostly wait on long commands nobody watches; it lets the fork's terminal close while it is parked and reopen in a new tab when the wait ends, and closes the fork's tab once its turn ends, with its final message shown in a notification. Left out, the fork's tab stays open and a parked fork waits in it.
   Everything the user left out stays unset: the server resolves `[aliases]` and fills the rest from `fork_model`, `fork_effort` and `fork_surface` in `sessions.toml`.
3. When this session is also editing that repo, tell the fork in the brief to create and use its own git worktree and leave this session's checkout alone.
   Add no push, pull request or merge conditions the user did not state: a fork pushes its branch and opens a draft pull request on its own, and never merges it.
4. Make exactly one `session_fork` call per problem, then continue this session's own work without waiting.
   Never bridge the fork and never call `session_spawn` for it: a fork is detached and nothing collects its result.
5. Report in one line what was forked: the key, the harness and model, and the problem it owns.
