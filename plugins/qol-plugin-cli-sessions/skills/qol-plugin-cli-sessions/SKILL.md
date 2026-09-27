---
name: qol-plugin-cli-sessions
description: Use when working on the qol-tray CLI Sessions plugin. Covers live terminal session discovery, the per-tool interpretation strategy registry, the session status state machine, screen and title signals, the always-on-top gpui overview panel, snapshots, and daemon reconciliation. Triggers on "plugin-cli-sessions", "cli sessions", session overview, needs-you or your-turn status, Kitty remote control, or terminal attention tracking.
---

# qol-plugin-cli-sessions

CLI Sessions owns an always-on-top overview of live CLI sessions and the attention policy that decides which one needs the user. Terminal identity, discovery, screen reading, focus, and interpretation come from `qol-terminal-sessions`; this plugin owns attention-state mapping and presentation. See [shared terminal ownership](../../../qol-project/skills/qol-shared-libs/SKILL.md#dependency-rules).

## Contract sources

- `plugin.toml` owns actions, exported launcher shortcuts, daemon metadata, declared capabilities, platform availability, and release artifacts.
- `qol-config.toml` owns settings sections, fields, and defaults.
- `qol-runtime.toml` owns the runnable action contract.
- `Cargo.toml` owns target-scoped dependencies.

## Source ownership

| Path | Responsibility |
|---|---|
| `src/cli.rs` | Headless command surface and doctor registration. |
| `src/host/` | Terminal-host boundary; the implemented host drives Kitty remote control. |
| `src/session/` | Local registry, attention status, git context, and adapters over shared terminal identities/tool descriptors. |
| Shared `qol-terminal-sessions::cli` facade | Interpretation, tool descriptors, and registered harness strategies; source in monorepo `libs/terminal-sessions/src/cli/`. |
| `src/attention/`, `src/daemon/screen_analysis.rs` | Plugin attention policy and mapping from shared interpretation. |
| `src/signal/` | Screen and title evidence used to detect prompts and input requests. |
| `src/daemon/` | Reconcile loop and action dispatch. |
| `src/storage/` | Session-state persistence, paths, and snapshots. |
| `src/diagnostics/` | Anomaly detection and snapshot capture. |
| `src/ui/` | gpui overview panel: placement, rendering, navigation, selection, notification. |
| `src/doctor/` | Read-only checks with target-selected probes. |

## Interpretation strategy

`qol-terminal-sessions` owns the interpretation registry, generic fallback, and tool-specific enrichers. Read its public facade and `libs/terminal-sessions/src/cli/mod.rs` and `cli/interpreter.rs` in the monorepo for exact strategy methods and phase semantics. Extend that owner for new harness evidence; do not create another interpreter in the plugin.

Keep the plugin's pure attention transition separate from the shared reading. Preserve moving-session handling and sticky acknowledgement at their owning boundaries so a redraw does not re-alert an acknowledged session.

The session's own transcript outranks the screen and the tab title. Each harness writes a JSONL transcript, and the type of its last complete entry is the deterministic runtime signal: a terminal type reads Ready, anything else reads Working, and a session whose transcript never resolves stays Unknown so the screen verdict still holds. A harness backend therefore carries exactly two things, how to locate the transcript for a live pid and its terminal-type set, and everything else is shared. Never reintroduce file freshness or transcript growth as a busy signal: a turn in flight writes nothing for minutes at a time, with measured zero-write stretches of 260s inside a single live turn against a 120s freshness window, including one 4m36s pure-think gap. Writes are bursty by nature, so no sampling interval rescues a growth predicate, and a thinking session reads as idle. Screen movement stays a fallback for the generic strategy and for any harness with no transcript, never the primary reading for one that has it.

The terminal-type sets, each verified against real transcripts on disk rather than derived from documentation. codex ends a turn on `task_complete` or `turn_aborted`, read from `payload.type` when the entry's top-level `type` is `event_msg`, and it is the only harness with an explicit terminal event and a per-turn ULID `turn_id` to attribute it by; it also flips to working within a second of submit because `task_started` is written at submit, so it has no fresh-session blind window. claude settles on an entry whose `type` is `system`, `last-prompt`, `mode` or `permission-mode`, and one session in three appends a late `last-prompt` minutes after the turn ended. pi closes on a `message` entry whose `message.role` is `assistant` and whose `message.stopReason` is anything other than `toolUse`; `toolUse` is the mid-turn stop reason and vastly outnumbers the real ones, so treating any `stopReason` as terminal reads every tool call as a finished turn. kimi has no verified set yet and stays on the old reading.

Ready and Done are the same live state on every harness, confirmed independently three times. A completed turn at rest is byte-identical to an idle one; the difference lives in history, not in the current reading. So anything that needs to fire once per completed turn triggers on the working-to-ready transition, never on the level.

An unsubmitted draft is not detectable. No harness persists one anywhere on disk, confirmed by waiting on live sessions with typed input for 180s, 93s and 3.5 minutes. Any feature that needs to know the user is mid-draft requires harness cooperation, so do not build one on a screen predicate.

Readings are two-stage on purpose. A strategy returns a phase plus an optional label; a separate pure transition maps the previous status and the new phase to the next status. Keep the transition pure - it is the part worth testing exhaustively, and it is where sticky states are honored so an acknowledged session does not re-alert on every poll.

## Naming and per-tool backends (the law)

Every harness-specific behavior - naming, title grammars, metadata extraction, screen stabilization - is a backend behind a capability facade, never a `match` on the tool in shared code. The naming capability is `HarnessNaming` plus one uniform `resolve_display_name` chain (harness metadata name, then harness title grammar, then spawn identity, then project); each harness owns its grammar backend in `builtins/<tool>/name.rs`. Presentation consumes the tool model (labels, accents, ids) instead of re-deriving strings, and the daemon, signal, and UI layers never branch on the tool. Adding a harness means adding a backend and registering it; the fallback chain and the facade stay untouched. The generic backend has no title grammar, so an unrecognized harness degrades to the spawn key or project name instead of disappearing or misbranding. For the backend-split rule itself see `qol-arch-code`; this law's enforcement hook is `qol-workflow:deny-tool-matches`.

## Common changes

**Support a new CLI tool:** extend and register its interpretation in `qol-terminal-sessions`, then consume its shared reading here. Keep plugin attention and presentation mapping local; do not add tool branches to the daemon or UI.

**Add a terminal host:** implement the host boundary and its session binding. Discovery, screen reading, and focus belong to the shared terminal-sessions library - extend the library when the capability is host-neutral, and keep only host-specific wiring local.

**Change attention policy:** edit the plugin's status transition over shared readings and cover it with cases rather than a live terminal. Change evidence interpretation only in its shared owner.

**Change the panel:** keep the overview keyboard-first. It is an interactive gpui surface, so it must use `SurfaceKind::OverlayPanel` (normal, focusable, with the shared overlay state applied inside the reveal gate); non-focusable window kinds silently leak keystrokes to whatever is underneath, and a plain `SurfaceKind::Panel` drops the always-on-top behavior.

## Invariants

- Terminal identity, discovery, screen reading, focus, and interpretation come from the shared library; this plugin does not re-implement them or poll independently when the library exposes a subscription.
- An unrecognized tool degrades to the generic strategy instead of disappearing from the overview.
- The status transition is pure and total over previous status and phase.
- Acknowledgement is sticky until the session genuinely changes phase.
- The panel is always-on-top, keyboard-navigable, and focusable.
- Doctor is read-only: it inspects host and storage metadata and queries inventory, and never creates state or launches a terminal.
- Voice owns recognition, routing, and conversation policy; neither plugin becomes the other's runtime broker.

## Verification

Run format, build, Clippy with warnings denied, and tests, plus `cargo run -q -p qol -- check`. Compile every manifest-declared target. Status and strategy logic must be covered without a live terminal. Panel behavior claims - placement, always-on-top, keyboard routing - need evidence from a real desktop session, which per the workspace rule means a guest environment rather than the host.
