---
name: qol-memory
description: Use when a session needs a settled fact from earlier work in this workspace, when the user references a past decision, fix, or path the agent does not remember, or when a settled outcome should be captured for later sessions.
---

# qol-memory

Long-context memory for agent sessions, served by the qol-tray daemon over its local HTTP API. Claude Code receives the tools through the plugin manifest; other harnesses reach the same tools with `qol mcp configure <harness>`, which carries the per-host token. The plugin ships no static token.

## Ask before re-deriving

Call `qol-memory__ask` before re-deriving a fact about paths, decisions, commits, or prior fixes in this workspace. The tool returns a verdict with provenance, so treat an answered fact as settled and say plainly when the verdict is candidates or no-memory instead of guessing.

## Capture settled outcomes

Call `qol-memory__capture` when a session settles something a later session needs. The tool expects one self-contained sentence that carries the identifiers a later reader needs (paths, commit subjects, decision names), plus the absolute project directory as `cwd`.

## Store health and the continue block

`qol-memory__status` reports store health. The session-start continue block lists the memory units that landed since the last session in this directory, so a fresh session starts with the newest settled facts without asking.
