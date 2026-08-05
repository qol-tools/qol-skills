---
name: qol-sessions
description: Use when relaying text into a live terminal session or another agent's CLI on this host, or when choosing which terminal session should receive input. Covers the sessions_list, session_read_screen, session_send_text, and session_focus tools over the qol sessions command group and its MCP server.
---

# qol-sessions

The host's terminal stack already delivers text into any chosen CLI session (the same machinery qol-voice routes turns through). These tools expose that capability to the agent: list live sessions, pick one at inference, send text, read the screen back, focus the window.

## Tools

| Tool | Purpose |
|---|---|
| `sessions_list` | Live sessions with tool classification, activity hint, capabilities, and a stable token |
| `session_send_text(session, text, submit?)` | Deliver text into the session's CLI; submit appends Enter |
| `session_read_screen(session)` | Current screen text of the session |
| `session_focus(session)` | Raise the session's window |

Sessions are discovered from the shared terminal-sessions backends (kitty remote control), the same sources qol-voice and CLI Sessions use. A token looks like `v1:kitty:1:42` and stays stable for the lifetime of the session.

## The relay loop

The full turn-taking procedure (wait for the turn, verify identity, deliver, confirm landed, report) lives in the `terminal-telepathy` skill. This skill stays the tool reference: use it to understand the tools and pick a session, then follow telepathy's loop for the actual relay.

## Constraints

- Delivery is fire-and-forget typing. There is no acknowledgement from the target CLI; the screen is the only evidence.
- Only sessions with the input capability accept text, and only the same user's sessions are discoverable.
- Concurrent delivery from multiple agents into one session is not coordinated yet; do not race another writer (including qol-voice) into the same session.
## Reaching the surface

- MCP clients (Claude Code, codex, kimi): `qol sessions mcp` over stdio exposes `sessions_list`, `session_read_screen`, `session_send_text`, and `session_focus` (plus `session_wait_output` in the sessions-relay build); `qol sessions mcp --help` lists the current tools.
- Any shell: the `qol sessions` CLI (`qol sessions help` lists your build's subcommands). pi also gets native `sessions_*` tools from the qol-skills pi package extension.
