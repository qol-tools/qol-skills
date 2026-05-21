---
name: qol-arch-channels
description: Use when adding any new piece of host <-> plugin communication in qol-tools (a new event, new request, new capability bit). Picks the right channel and stops re-deriving infra that already lives in qol-runtime.
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

## Anti-patterns

- Manifest `subscribes` field. Two sources of truth, breaks forward-compat.
- `event:<topic>` on `DaemonRequest`. Conflates broadcast with request/response.
- Dynamic capability negotiation. `PlatformCapabilities` already covers it.
