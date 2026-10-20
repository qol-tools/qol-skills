---
name: qol-memory
description: Use when a session needs a settled fact from earlier work in this workspace, when the user references a past decision, fix, or path the agent does not remember, when a settled outcome should be captured for later sessions, or when a stored fact is out of date and should be superseded or forgotten.
---

# qol-memory

Long-context memory for agent sessions, served by the qol-tray daemon over its local HTTP API. Claude Code receives the tools through the stdio bridge in `bin/qol-memory-mcp.cjs` that the plugin manifest declares: the bridge owns the MCP handshake, serves a built-in tool list while qol-tray is not answering, and retries tool calls until the daemon picks up, so a session that starts before qol-tray is up still has the memory tools. Other harnesses reach the same tools with `qol mcp configure <harness>`, which carries the per-host token. The plugin ships no static token.

## Ask before re-deriving

Call `qol-memory__ask` before re-deriving a fact about paths, decisions, commits, or prior fixes in this workspace. The tool returns a verdict with provenance, so treat an answered fact as settled and say plainly when the verdict is candidates or no-memory instead of guessing.

## Capture settled outcomes

Call `qol-memory__capture` when a session settles something a later session needs. The tool expects one self-contained sentence that carries the identifiers a later reader needs (paths, commit subjects, decision names), plus the absolute project directory as `cwd`.

## Correct stale facts

qol-memory never guesses which fact is stale, so the latest statement wins only when an agent names the old fact.
When an answer from `qol-memory__ask`, or a related fact in the `qol-memory__capture` reply, is no longer true, call `qol-memory__supersede` with its key and the corrected fact instead of capturing a second fact beside it.
Call `qol-memory__forget` with a reason for a fact that is wrong and has nothing to replace it.
Supersede only a fact you know changed: a fact that answers a different question is not stale.
An answer with reason code `superseded_answer` is a replaced fact that still matched where its replacement did not, so report it as what used to be true and check `superseded_by` for the current fact.

## Refill commands

The continue block's unanswered launcher questions can be inspected and dismissed without launching an answering lane. `qolmem list` prints the waiting questions and the muted ones with their ages, and `qolmem mute <n>` and `qolmem unmute <n>` move the numbered entries between those lists, so a muted question stays out of the queue even when it is asked again. `qolmem gen` launches one background answering lane for the waiting questions. Bare `qolmem` or `qolmem help` prints the command list.

## Store health and the continue block

`qol-memory__status` reports store health. The session-start continue block lists the memory units that landed since the last session in this directory, so a fresh session starts with the newest settled facts without asking.
