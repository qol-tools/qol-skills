---
name: terminal-telepathy
description: Use when relaying text or work between two agents' terminals on this host (pi, Claude Code, codex, kimi), handing off a task to another agent's CLI, waiting for another agent to finish its turn before sending, or telling another agent to do something. Covers the automatic relay loop over sessions_list, session_wait_output, session_send_text, session_read_screen, and session_focus.
---

# terminal-telepathy

Two agents in separate terminals share no context. The qol terminal stack gives each agent the other's eyes and hands: list the live sessions, wait for the right moment, type text in, read the screen back. The receiving agent never knows it is being relayed to, so every signal below is an outside-in approximation of its state: the CLI rendered a fresh prompt after your input is the only true "your turn" edge.

## The surface

| Tool | Purpose |
|---|---|
| `sessions_list` | Live sessions: tool, display name, activity hint, cwd, pending input, stable token |
| `session_wait_output(session, timeout, expect?)` | Block until settle (screen changed then stable) or until an expected substring appears; returns `settled` |
| `session_send_text(session, text, submit?)` | Type into the session's CLI; submit appends Enter |
| `session_read_screen(session)` | Current screen text |
| `session_focus(session)` | Raise the session's window |

## The relay loop

1. Discover: `sessions_list`, filter by tool and cwd, prefer sessions whose screen shows a ready prompt.
2. Wait for the turn: `session_wait_output(session, expect=<ready marker>)`. Never type into a busy CLI; a busy agent consumes your text mid-tool-call.
3. Deliver: `session_send_text`. For multi-line payloads prefer two steps: insert the text (`submit: false`), wait for the prompt echo to settle, then submit.
4. Confirm landed: `session_wait_output` again and/or `session_read_screen` until the echo of your text is visible. Queued is not delivered; `pending_input` in `sessions_list` tells you text is waiting to be consumed.
5. Wait for the outcome: `session_wait_output(session, expect=<expected outcome>)`, or settle mode when you cannot predict the output.
6. Report what the target's screen shows, not what you intended.

## Turn-taking signals per tool

- **codex**: the terminal title carries run state. `Working` or `Thinking` means busy, `Ready` means idle and waiting, `Action Required` means blocked on an approval prompt (do not type; the prompt swallows input).
- **pi**: title is `pi - <session name> - <cwd>` (or `pi - <cwd>` unnamed). A settled screen plus a visible prompt marker is the idle signal.
- **kimi**: session name comes from `state.json`; no title signal, so rely on settle + prompt visibility.
- **claude**: the `-n` session name shows in the terminal title and prompt bar; no reliable screen busy signal, so settle mode is the safe default.

## When to wait vs send

- Only send when the target is idle: ready marker on screen, or `settled: true` from a wait, or an activity hint of idle.
- When in doubt, wait for settle first, then read the screen and confirm a prompt is visible before typing.
- After you submit, treat the turn as one-shot. Do not reply to the target's output again unless the user asked for a second round; auto-reply loops ping-pong forever between two agents.

## Setup once

1. kitty: sessions must be launched with `-o allow_remote_control=yes` (qol dev environments and the kitty backend do this for you).
2. MCP clients (Claude Code, codex, others): register `qol sessions mcp` as a stdio server; approve the session tools once.
3. pi: the same tools ship via the qol-skills pi package; no MCP client needed.

## Failure grammar

- `settled: false` from a wait means the timeout elapsed, not an error: the target may still be busy, or the screen never changed. Re-list, check activity, then decide.
- `pending_input` above zero after a send means the target has not consumed your text yet; wait before retrying.
- A dead session (agent exited, window closed) fails delivery; re-list and re-resolve the token rather than trusting a cached one.
- Never spam retries into a session that shows `Action Required` or a permission prompt; those prompts are for the human, not for you.

## Constraints

- Delivery is fire-and-forget typing; the screen is the only evidence of delivery.
- Only the same user's sessions are discoverable, and only sessions with the input capability accept text.
- Concurrent writers are not coordinated: do not race another agent or qol-voice into the same session.
