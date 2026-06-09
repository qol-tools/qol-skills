---
name: qol-cli
description: Stable mental model for the local `qol` CLI; command facts come from `qol --help`.
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

## Behavioral notes

- Unknown command shape returns a usage error and appended help text.
- `qol emu` prints its own subcommand help on missing or `help` argument.
