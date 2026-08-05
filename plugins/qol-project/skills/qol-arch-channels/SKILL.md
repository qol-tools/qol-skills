---
name: qol-arch-channels
description: Use when adding any new piece of host-to-plugin or plugin-to-host communication in qol-tools (a new event, request, capability bit), deciding whether a tray-owned helper-process socket is a new channel, or exposing qol capability tools to terminal agents (pi, Claude Code, codex, kimi). Picks the right channel and stops re-deriving existing runtime infrastructure.
---

# qol-arch-channels

Four channels, pick one. Don't invent a fifth.

| Channel | Direction | Use for | Wire |
|---|---|---|---|
| Pull | plugin -> host | Plugin asks now | `RuntimeRequest::GetState` |
| Subscribe | plugin -> host (stream) | Plugin reacts to host changes | `RuntimeRequest::Subscribe { events }` + new `RuntimeEvent` variant |
| Action | host -> plugin | Host tells plugin to do something | `DaemonRequest { action }` |
| Capability | static | Per-OS feature gate | `qol_platform::PlatformCapabilities` |

## Rules

- Event variants are past-tense VerbNoun: `FocusChanged`, `MonitorsChanged`, `LauncherAppsSynced`.
- Payloads are additive only. Breaking shape = new variant, never rename.
- Use `#[serde(default)]` on new fields so old subscribers still parse.
- A tray-owned helper process is not automatically a fifth host/plugin
  channel. The native settings singleton socket only activates qol-tray's own
  GPUI host; panel persistence and `SettingsRuntime::tray` keep plugin config,
  queries, and actions on the existing HTTP and action paths. See
  `qol-project:qol-plugin-gpui-surfaces` before adding settings IPC.

## Agent-facing tool surfaces

Exposing a qol capability's tools to terminal agents (pi, Claude Code, codex,
kimi) is a boundary, not a fifth host/plugin channel. The same tools can reach
every agent; the surface is the contract, not a per-agent fork.

- Own the tool contract once, in the capability's headless layer. Example:
  `tools/qol-cli/src/commands/sessions/contract.rs` holds name, label,
  description, and input schema for every tool; nothing else authors them.
- Render per-client surfaces from the contract behind a facade:
  `qol sessions export <client>` dispatches to one adapter module per client
  (`export/pi.rs` for pi; codex/kimi adapters slot in as sibling modules).
  Adding a tool to the contract without an adapter for every client fails the
  build or the parity test, not the docs.
- Generated artifacts are committed and drift-checked: the qol-skills manifest
  sync script runs `qol sessions export pi` and compares against
  `plugins/qol-sessions/extensions/hooks.ts`, reporting drift in `--check`.
- MCP stdio is the universal adapter for MCP-capable clients (Claude Code,
  codex, kimi register `qol sessions mcp` as a stdio server). pi has no MCP
  client, so its adapter is a generated extension instead.

## Anti-patterns

- Manifest `subscribes` field. Two sources of truth, breaks forward-compat.
- `event:<topic>` on `DaemonRequest`. Conflates broadcast with request/response.
- Dynamic capability negotiation. `PlatformCapabilities` already covers it.
