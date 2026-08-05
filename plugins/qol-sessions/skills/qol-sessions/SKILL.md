---
name: qol-sessions
description: Use when relaying text into a live terminal session or another agent's CLI on this host, or when choosing which terminal session should receive input. Covers the pi tools sessions_list, session_read_screen, session_send_text, and session_focus, which wrap the qol sessions command group and its MCP server.
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

1. Call `sessions_list` and pick the target session from the tool classification, activity hint, and cwd. Prefer sessions whose tool matches the task and whose screen shows a ready prompt.
2. Call `session_send_text` with `submit: true` for a command or `submit: false` to complete a partially typed line.
3. Call `session_read_screen` to observe the CLI's response.
4. Repeat until the target CLI's screen shows the expected outcome. `sessions_list` activity hints can tell you when the session went busy and came back.

This loop is exactly how one agent relays work to another agent's CLI: text in, screen out, no shared context between the two agents.

## Constraints

- Delivery is fire-and-forget typing. There is no acknowledgement from the target CLI; the screen is the only evidence.
- Only sessions with the input capability accept text, and only the same user's sessions are discoverable.
- Concurrent delivery from multiple agents into one session is not coordinated yet; do not race another writer (including qol-voice) into the same session.
- The same tools are exposed to MCP clients (Claude Code, others) by `qol sessions mcp` over stdio.
