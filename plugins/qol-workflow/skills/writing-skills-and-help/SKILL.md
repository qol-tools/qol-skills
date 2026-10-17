---
name: writing-skills-and-help
description: Use when a change adds, renames or changes a command, flag, MCP tool, setting, exit code or visible behavior in a qol-tools CLI or plugin, and when writing or editing a SKILL.md, CLI help text (`help`, `--help`, `<command> help`) or an MCP tool description. Sets which surface owns which fact, the help sections, the skill rules, and the definition of done - the change is not finished until its help and its owning skill describe what it now does.
---

# Writing skills and CLI help

Agents learn a tool only from what they can read at the moment they need it. A feature has three reading surfaces, and each fact lives in exactly one of them:

| Surface | Reader | Owns |
| --- | --- | --- |
| CLI help | anyone running the binary | commands, flags, defaults, output, exit codes |
| MCP tool description and schema | an agent about to call the tool | what one call does, its reach, refusals and limits |
| Skill | an agent deciding what to do | when to use the feature, the workflow, the traps |

A skill names a command or tool and points at its help for the details. It never copies a flag list or a limit, because the copy goes stale on the next change.

## Definition of done

A change that adds or changes a command, flag, MCP tool, setting, exit code or visible behavior updates, in the same delivery:

1. the help of every command it touches, including the parent command's usage and details lines;
2. the MCP tool description and schema when a tool changed;
3. the owning skill: the plugin's `qol-plugin-<name>` skill, or the workflow skill agents use it from (`qol-sessions:qol-sessions` for the session tools).

Help and tool descriptions ship with the code in the monorepo pull request. Skills ship from qol-skills `main`: write the skill change with the pull request, and push it once the release carrying the code is out, so no skill names a tool the installed binary lacks.

Before calling it done, run the built binary's `help`, `help <command>` and `<command> help` and read them as a newcomer: every new command and flag appears, and nothing describes the old behavior.

## CLI help

Help comes from the `qol-headless` `Command` builder (`about`, `usage`, `detail`, `output`, `exit_behavior`), rendered as a title, one about line, then Usage, Details, Output and Exit. Hand-written help (`qol sessions`) keeps the same sections.

- `help`, `--help`, `help <command>` and `<command> help` print the same text and ignore other arguments ([clig.dev: Help](https://clig.dev/#help)).
- The about line says what the command does for the reader in one sentence: "Focus the next terminal session that needs attention."
- Usage lists the most common form first and every flag the parser accepts. A flag missing from usage does not exist for an agent.
- Details gives one paragraph per command or flag group: defaults and where they come from (the setting name, then the built-in value), what is refused, and what the command never does.
- Output names the stdout shape (one line, or the JSON keys) and whether `--json` is supported.
- Exit lists every non-zero code a caller branches on and what it means: "exits 3 when a switchboard is already live, so a wrapper starts its usual chat".
- Mark human-only diagnostics as such, so agents do not script them.
- Write for a reader with nothing else open: no internal type names, no history ("new", "now", "since 0.9"), no counts that drift.

## MCP tool descriptions

- Open with what one call does, then its reach, refusals and limits with their numbers: an agent learns why a call was refused only here and from the error text.
- Say what the tool never does and what to use instead: "anything else is refused, so use session_board instead".
- Every refusal message names the way forward, not only the fault.

## Skills

Follow Anthropic's [skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices). The rules that matter most here:

- `name`: lowercase letters, digits and hyphens, at most 64 characters. `description`: at most 1024 characters, third person or imperative "Use when", saying what the skill covers and when to load it, in the words a user or agent would type. It is the only part loaded before the skill triggers.
- The body holds only what an agent cannot get from the code or `--help`: when to reach for the feature, the workflow, and the traps found the hard way.
- One term per concept, spelled exactly as the CLI and tool names spell it.
- No dates, versions or counts that drift; link the owning file or command instead.
- Split by area into files one level below SKILL.md once the body passes about 150 lines.
- Placement, single home and cross-links: `qol-workflow:standards-evolution`. Hook-backed skills: `hook-design`. Plugin layout: `plugin-architecture`.

## Fresh-eyes check

For a new feature, give a fresh Sonnet lane (through qol-sessions) only the help, the skill and one real task that uses the change. Every question it asks and every wrong call it makes is a gap in the help or the skill: fix the docs, not the lane's brief, and run it again.
