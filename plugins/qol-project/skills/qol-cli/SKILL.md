---
name: qol-cli
description: Use when answering questions about `qol` CLI commands or changing `tools/qol-cli` behavior. Stable ownership model only; command facts come from `qol --help`, never from memory.
---

# qol CLI

Use this when you need the `qol` CLI ownership model, source-of-truth paths, or rules for answering command questions.

## Source Of Truth

- `qol --help`
- `tools/qol-cli/src/main.rs`
- `tools/qol-cli/src/cli.rs`
- `tools/qol-cli/src/commands`

Do not treat this skill as a command database. A `qol-project` SessionStart hook injects current `qol --help` output into context. If that context conflicts with this skill, the hook output and source files win.

## Rules

- For exact command names, flags, or subcommands, use the current `qol --help` output.
- Before changing command behavior, inspect `tools/qol-cli/src/main.rs`, `tools/qol-cli/src/cli.rs`, and the relevant file under `tools/qol-cli/src/commands`.
- After changing `tools/qol-cli`, run `qol setup` before trusting the installed `qol` binary.

## Ownership Model

- `qol` is the terminal CLI and owns the command parser.
- `qol dev` is a CLI workflow/dashboard that starts `qol-tray --write-mode=dev` as a child process.
- `qol dev` dashboard rows are CLI-owned status/action panes, not tray launcher commands.
- `qol-tray` exported launcher commands live separately in `apps/qol-tray/src/commands/mod.rs`.

## Dev console activity reporting

Every long-running job `qol dev` starts (reload prebuild, doctor check/fix, and
any future one) reports progress through one shared surface: the centered
`Activity` sign box at the bottom of the console, above the branch sign.

- Build an `activity::Activity` (`title`, `phase`, `detail`, `elapsed`) from the
  job's own progress state; `Dash::activity` picks which one renders.
- Never add a second live progress surface for the same job. The page body keeps
  showing the last result, and a dashboard row carries at most the one-word state
  (`fixing`), leaving step and elapsed to the sign.
- Full rule set: `tools/qol-cli/CLAUDE.md`, "Dev console design rules".

## Behavioral notes

- Unknown command shape returns a usage error and appended help text.
- `qol emu` prints its own subcommand help on missing or `help` argument.
