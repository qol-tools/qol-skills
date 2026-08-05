---
name: qol-sessions
description: Use when relaying text into a live terminal session or another agent's CLI on this host, or when choosing which terminal session should receive input. Covers the sessions_list, session_read_screen, session_send_text, session_wait_output, and session_focus tools over the qol sessions command group and its MCP server.
---

# qol-sessions

The host's terminal stack already delivers text into any chosen CLI session (the same machinery qol-voice routes turns through). These tools expose that capability to the agent: list live sessions, pick one at inference, send text, read the screen back, wait for output to settle, focus the window.

## Tools

| Tool | Purpose |
|---|---|
| `sessions_list` | Live sessions with tool classification, activity hint, capabilities, and a stable token |
| `session_read_screen(session)` | Current screen text of the session |
| `session_send_text(session, text, submit?)` | Deliver text into the session's CLI; submit appends Enter |
| `session_wait_output(session, timeout_ms?, expect?)` | Block until the screen settles or shows the expected output; returns settled, screen, polls, elapsed_ms |
| `session_focus(session)` | Raise the session's window |

Sessions are discovered from the shared terminal-sessions backends (kitty remote control), the same sources qol-voice and CLI Sessions use. A token looks like `v1:kitty:1:42` and stays stable for the lifetime of the session.

## The relay loop

The full turn-taking procedure (wait for the turn, verify identity, deliver, confirm landed, report) lives in the `qol-terminal-telepathy` skill. This skill stays the tool reference: use it to understand the tools and pick a session, then follow telepathy's loop for the actual relay.

## Wait semantics

- `expect` matches the substring on the screen **outside the echo of the text you last sent** into that session: the shell's or TUI's echo of your own payload does not count as output. After a match the wait also confirms the screen settles (one read unchanged) before returning `settled: true`, so a mid-stream hit keeps polling until the target stops.
- Without `expect`, the wait returns once the screen changed from the first read and then stayed stable.
- The activity hint in `sessions_list` is recency-based: a session shows `busy` only while its log file keeps being written (about a 2-minute window) and `idle` after it stops. It is approximate and never authorizes typing by itself; screen evidence is the only truth.

## Constraints

- Delivery is fire-and-forget typing. There is no acknowledgement from the target CLI; the screen is the only evidence.
- Only sessions with the input capability accept text, and only the same user's sessions are discoverable.
- Concurrent delivery from multiple agents into one session is not coordinated yet; do not race another writer (including qol-voice) into the same session.
## Reaching the surface

- pi: native `sessions_*` tools from the qol-skills pi package extension (`plugins/qol-sessions/extensions/hooks.ts`), generated from the shared tool contract by `qol sessions export pi`; the manifest sync script regenerates and drift-checks it.
- MCP clients (Claude Code, codex, kimi): `qol sessions mcp` over stdio exposes the same five tools; register it as a stdio MCP server. Claude Code loads it automatically from the plugin's `.mcp.json` (`qol sessions mcp`); codex and kimi need manual registration.
- Any shell: the `qol sessions` CLI (`qol sessions help` lists your build's subcommands).
