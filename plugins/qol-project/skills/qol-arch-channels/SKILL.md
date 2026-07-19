---
name: qol-arch-channels
description: Use when adding any new piece of host-to-plugin or plugin-to-host communication in qol-tools (a new event, request, capability bit), or deciding whether a tray-owned helper-process socket is a new channel. Picks the right channel and stops re-deriving existing runtime infrastructure.
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

## Anti-patterns

- Manifest `subscribes` field. Two sources of truth, breaks forward-compat.
- `event:<topic>` on `DaemonRequest`. Conflates broadcast with request/response.
- Dynamic capability negotiation. `PlatformCapabilities` already covers it.
