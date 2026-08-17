---
name: qol-plugin-cli-sessions
description: Use when working on the qol-tray CLI Sessions plugin. Covers live terminal session discovery, the per-tool interpretation strategy registry, the session status state machine, screen and title signals, the always-on-top gpui overview panel, snapshots, and daemon reconciliation. Triggers on "plugin-cli-sessions", "cli sessions", session overview, needs-you or your-turn status, Kitty remote control, or terminal attention tracking.
---

# qol-plugin-cli-sessions

CLI Sessions owns an always-on-top overview of live CLI sessions and the attention policy that decides which one needs the user. Terminal identity, discovery, screen reading, and focus are consumed from the shared terminal-sessions library; this plugin owns interpretation and presentation.

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
| `src/session/` | Session identity, registry, tool classification, status, and git context. |
| `src/strategy/` | Per-tool interpretation: the trait, its generic default, and tool-specific enrichers. |
| `src/signal/` | Screen and title evidence used to detect prompts and input requests. |
| `src/daemon/` | Reconcile loop and action dispatch. |
| `src/storage/` | Session-state persistence, paths, and snapshots. |
| `src/diagnostics/` | Anomaly detection and snapshot capture. |
| `src/ui/` | gpui overview panel: placement, rendering, navigation, selection, notification. |
| `src/doctor/` | Read-only checks with target-selected probes. |

## Interpretation strategy

Interpretation is a registry, not a chain of conditionals. The strategy trait carries a working default so an unrecognized tool still produces a usable reading; tool-specific implementations supply evidence hooks (`working`, `awaiting`, `turn_taken`) and never re-derive the phase order. The trait's default `read` composes the hooks through the pure `phase_for` skeleton (Busy > Blocked > Done > Idle) and applies the moving-screen invariant in exactly one place, keyed on the previous status. Movement reads `Busy` whenever the session was `Working` or has not been observed before, so a streaming session stays working (debounce) and a first sighting never arms "your turn" from historical evidence. Once a session has settled into a waiting status, a redraw stops overriding the evidence hooks, so a rename or banner refresh in an acknowledged session keeps its waiting phase instead of re-arming. A redraw with no waiting evidence still reads `Busy`, because movement is all a hidden spinner leaves behind. Dropping the debounce turns every busy session into a false "your turn"; keying the invariant on a bare previous-working flag instead of the full status turns every first sighting of a moving session into one. The generic shell strategy overrides `read` because it is busy-by-default (absence of a foreground process is the idle signal), which does not fit the evidence skeleton. Adding support for a new CLI tool means adding a strategy, registering it for that tool, and covering its evidence with cases - never branching on the tool inside shared code and never writing a phase if-else ladder inside a strategy.

The session's own transcript outranks the screen and the tab title. Each harness writes a JSONL transcript, and the type of its last complete entry is the deterministic runtime signal: a terminal type reads Ready, anything else reads Working, and a session whose transcript never resolves stays Unknown so the screen verdict still holds. A harness backend therefore carries exactly two things, how to locate the transcript for a live pid and its terminal-type set, and everything else is shared. Never reintroduce file freshness or transcript growth as a busy signal: a turn in flight writes nothing for minutes at a time, with measured zero-write stretches of 260s inside a single live turn against a 120s freshness window, including one 4m36s pure-think gap. Writes are bursty by nature, so no sampling interval rescues a growth predicate, and a thinking session reads as idle. Screen movement stays a fallback for the generic strategy and for any harness with no transcript, never the primary reading for one that has it.

The terminal-type sets, each verified against real transcripts on disk rather than derived from documentation. codex ends a turn on `task_complete` or `turn_aborted`, read from `payload.type` when the entry's top-level `type` is `event_msg`, and it is the only harness with an explicit terminal event and a per-turn ULID `turn_id` to attribute it by; it also flips to working within a second of submit because `task_started` is written at submit, so it has no fresh-session blind window. claude settles on an entry whose `type` is `system`, `last-prompt`, `mode` or `permission-mode`, and one session in three appends a late `last-prompt` minutes after the turn ended. pi closes on a `message` entry whose `message.role` is `assistant` and whose `message.stopReason` is anything other than `toolUse`; `toolUse` is the mid-turn stop reason and vastly outnumbers the real ones, so treating any `stopReason` as terminal reads every tool call as a finished turn. kimi has no verified set yet and stays on the old reading.

Ready and Done are the same live state on every harness, confirmed independently three times. A completed turn at rest is byte-identical to an idle one; the difference lives in history, not in the current reading. So anything that needs to fire once per completed turn triggers on the working-to-ready transition, never on the level.

An unsubmitted draft is not detectable. No harness persists one anywhere on disk, confirmed by waiting on live sessions with typed input for 180s, 93s and 3.5 minutes. Any feature that needs to know the user is mid-draft requires harness cooperation, so do not build one on a screen predicate.

Readings are two-stage on purpose. A strategy returns a phase plus an optional label; a separate pure transition maps the previous status and the new phase to the next status. Keep the transition pure - it is the part worth testing exhaustively, and it is where sticky states are honored so an acknowledged session does not re-alert on every poll.

## Naming and per-tool backends (the law)

Every harness-specific behavior - naming, title grammars, metadata extraction, screen stabilization - is a backend behind a capability facade, never a `match` on the tool in shared code. The naming capability is `HarnessNaming` plus one uniform `resolve_display_name` chain (harness metadata name, then harness title grammar, then spawn identity, then project); each harness owns its grammar backend in `builtins/<tool>/name.rs`. Presentation consumes the tool model (labels, accents, ids) instead of re-deriving strings, and the daemon, signal, and UI layers never branch on the tool. Adding a harness means adding a backend and registering it; the fallback chain and the facade stay untouched. The generic backend has no title grammar, so an unrecognized harness degrades to the spawn key or project name instead of disappearing or misbranding. For the backend-split rule itself see `qol-arch-code`; this law's enforcement hook is `qol-workflow:deny-tool-matches`.

## Common changes

**Support a new CLI tool:** add a strategy, register it for the tool, and add classification so sessions resolve to it. Enrich display and phase reading; do not add tool branches to the registry, daemon, or UI.

**Add a terminal host:** implement the host boundary and its session binding. Discovery, screen reading, and focus belong to the shared terminal-sessions library - extend the library when the capability is host-neutral, and keep only host-specific wiring local.

**Change attention policy:** edit the phase reading and the status transition together, and cover the transition with cases rather than a live terminal.

**Change the panel:** keep the overview keyboard-first. It is an interactive gpui surface, so it must use a normal, focusable window kind and the shared overlay configuration; non-focusable window kinds silently leak keystrokes to whatever is underneath.

## Invariants

- Terminal identity, discovery, screen reading, and focus come from the shared library; this plugin does not re-implement them or poll independently when the library exposes a subscription.
- An unrecognized tool degrades to the generic strategy instead of disappearing from the overview.
- The status transition is pure and total over previous status and phase.
- Acknowledgement is sticky until the session genuinely changes phase.
- The panel is always-on-top, keyboard-navigable, and focusable.
- Doctor is read-only: it inspects host and storage metadata and queries inventory, and never creates state or launches a terminal.
- Voice owns recognition, routing, and conversation policy; neither plugin becomes the other's runtime broker.

## Verification

Run format, build, Clippy with warnings denied, and tests, plus `cargo run -q -p qol -- check`. Compile every manifest-declared target. Status and strategy logic must be covered without a live terminal. Panel behavior claims - placement, always-on-top, keyboard routing - need evidence from a real desktop session, which per the workspace rule means a guest environment rather than the host.
