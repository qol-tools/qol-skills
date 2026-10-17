---
name: qol-plugin-cli-sessions
description: Use when working on the qol-tray CLI Sessions plugin. Covers live terminal session discovery, the per-tool interpretation strategy registry, the session status state machine, screen and title signals, the always-on-top gpui overview panel, snapshots, and daemon reconciliation. Triggers on "plugin-cli-sessions", "cli sessions", session overview, needs-you or your-turn status, Kitty remote control, terminal attention tracking, the switchboard, or session knocks.
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
| `src/cli.rs` | Headless command surface and doctor registration; `sessions` and `mcp` pass straight through to `libs/sessions-engine`. |
| `src/host/` | Terminal-host boundary (`TerminalHost`); the implemented host drives Kitty remote control. |
| `src/session/` | Session identity, registry, tool classification and completion policy, status, git context, and the target-selected service probe. |
| `src/attention/` | The pure attention reducer: `Evidence` in, `Phase` and next `Attention` out. |
| `src/signal/` | Screen and title evidence used to detect prompts and input requests. |
| `src/daemon/` | Reconcile loop that builds `Evidence` per pane and calls the reducer, action dispatch, and the knock courier (`knocks.rs`). |
| `src/storage/` | Session-state persistence, paths, and snapshots. |
| `src/config/` | Typed config loading. |
| `src/park/`, `src/parking.rs` | The `park` and `parking` commands that set a conversation aside and resume it. |
| `src/diagnostics/` | Anomaly detection and snapshot capture. |
| `src/ui/` | gpui overview panel: placement, rendering, navigation, selection, notification. |
| `src/doctor/` | Read-only checks with target-selected probes. |

## Interpretation strategy

Interpretation is split across two layers, and neither is a chain of conditionals. Per-tool reading lives in the shared terminal-sessions library: each harness implements `CliSessionStrategy` (`libs/terminal-sessions/src/cli/builtins/<tool>/`), registered by priority with a generic fallback, and its `describe` returns a `CliSessionDescriptor` carrying the display name and `CliSessionEvidence` (transcript runtime plus file activity). This plugin owns the attention policy: `daemon/reconcile.rs` combines that descriptor with screen evidence, screen movement, prompt state and the service probe into one `Evidence`, and `attention::reduce_with_policy` maps the previous `Attention` plus that evidence to the next status and a `Phase` (`Busy`, `Service`, `Blocked`, `Done`, `Idle`, `Hold`). The completion policy comes from `session/tool.rs`: harnesses with an explicit transcript terminal signal (claude, codex, pi) use `CompletionPolicy::Explicit`, everything else `Quiescent`. A session settles into "your turn" only after it stops moving for `GRACE_SECS` following a working episode, so a streaming session stays working and a first sighting never arms "your turn" from historical evidence; a `Historical` viewport holds the previous status instead of re-reading it. The generic strategy is busy-by-default because the absence of a foreground process is the idle signal. Adding support for a new CLI tool means adding a strategy in the library, registering it, and covering its evidence with cases - never branching on the tool inside shared code or the reducer.

The session's own transcript outranks the screen and the tab title. Each harness writes a JSONL transcript, and the type of its last complete entry is the deterministic runtime signal (the strategy's `tail_runtime`): a terminal entry reads Ready, a mid-turn entry reads Working, and a session whose transcript never resolves stays Unknown so the screen verdict still holds. Strong transcript Working beats a scrolled or historical screen. File freshness (`file_fresh`, `file_quiet_secs`) is supporting evidence only: it gates settling and suppresses a screen input request while the transcript is still being written, but freshness or growth alone never reads Busy. A turn in flight writes nothing for minutes at a time, with measured zero-write stretches of 260s inside a single live turn against a 120s freshness window, including one 4m36s pure-think gap, so a growth predicate reads a thinking session as idle. Screen movement stays a fallback for the generic strategy and for any harness with no transcript, never the primary reading for one that has it.

The terminal-entry sets live in each builtin's `metadata.rs` and are verified against real transcripts on disk rather than derived from documentation. codex ends a turn on `task_complete` or `turn_aborted`, read from `payload.type` when the entry's top-level `type` is `event_msg`; it flips to working within a second of submit because `task_started` is written at submit, so it has no fresh-session blind window. claude settles on a `system` entry with subtype `turn_duration`, a `user` interrupt note, or an `assistant` entry whose `message.stop_reason` is `end_turn`, `stop_sequence` or `max_tokens`; any other assistant, `user` or `attachment` entry reads Working. pi closes on a `message` entry whose `message.role` is `assistant` and whose `message.stopReason` is `stop`, `end_turn`, `length`, `error` or `aborted`; `toolUse` is the mid-turn stop reason and vastly outnumbers the real ones, so treating any `stopReason` as terminal reads every tool call as a finished turn. kimi has no transcript runtime yet: it reports `Unknown` and relies on file activity and the screen.

Ready and Done are the same live state on every harness, confirmed independently three times. A completed turn at rest is byte-identical to an idle one; the difference lives in history, not in the current reading. So anything that needs to fire once per completed turn triggers on the working-to-ready transition, never on the level.

An unsubmitted draft is never on disk. No harness persists one, confirmed by waiting on live sessions with typed input for 180s, 93s and 3.5 minutes. The only draft evidence is the live composer on screen (`composer_holds_draft` and `composer_draft` in the terminal-sessions library) plus a strategy's `draft_stash` key; never infer a draft from transcripts or file activity.

Keep the reducer pure and total over previous attention and evidence - it is the part worth testing exhaustively, and it is where sticky states are honored: an acknowledged session stays acknowledged at the prompt, and a `NeedsYou` session with a live pending dialog holds instead of re-alerting on every poll.

## Switchboard and knocks

The sessions engine (`libs/sessions-engine`) owns the switchboard, the mailbox, the board and the knock records; this plugin serves it as `sessions` and `mcp`, shows the switchboard as the master row, and delivers knocks. The daemon's courier types a pending knock only into a recipient that is one live session, settled (your turn, acknowledged or unknown, never parked) and showing an empty prompt, so it never interrupts a turn or a draft. It claims the knock under the per-recipient lock before typing and puts it back if typing fails, so a knock is neither lost nor typed twice. A knock whose recipient is gone stays on disk until that key is live again.

## Naming and per-tool backends (the law)

Every harness-specific behavior - naming, title grammars, metadata extraction, transcript location, screen classification, launch and resume arguments - is a method on the harness's `CliSessionStrategy` in `libs/terminal-sessions/src/cli/builtins/<tool>/`, never a `match` on the tool in shared code. Each strategy's `describe` resolves the display name in the same order: harness metadata name, then the harness's cleaned title, then `fallback_name` (spawn identity, then project directory). Presentation consumes the tool model (labels, accents, ids) instead of re-deriving strings, and the daemon, signal, and UI layers never branch on the tool; the one tool-keyed table in this plugin is the completion policy in `session/tool.rs`. Adding a harness means adding a strategy and registering it; the fallback chain stays untouched. The generic strategy has no title grammar, so an unrecognized harness degrades to the spawn key or project name instead of disappearing or misbranding. For the backend-split rule itself see `qol-arch-code`; this law's enforcement hook is `qol-workflow:deny-tool-matches`.

## Common changes

**Support a new CLI tool:** add a `CliSessionStrategy` in the terminal-sessions library, register it, and choose its completion policy in `session/tool.rs`. Enrich display and runtime reading in the strategy; do not add tool branches to the registry, daemon, reducer, or UI.

**Add a terminal host:** implement the host boundary and its session binding. Discovery, screen reading, and focus belong to the shared terminal-sessions library - extend the library when the capability is host-neutral, and keep only host-specific wiring local.

**Change attention policy:** edit `attention::reduce_with_policy` and cover the change with `Evidence` cases rather than a live terminal.

**Change the panel:** keep the overview keyboard-first. It is an interactive gpui surface, so it must use `SurfaceKind::OverlayPanel` (normal, focusable, with the shared overlay state applied inside the reveal gate); non-focusable window kinds silently leak keystrokes to whatever is underneath, and a plain `SurfaceKind::Panel` drops the always-on-top behavior.

## Invariants

- Terminal identity, discovery, screen reading, and focus come from the shared library; this plugin does not re-implement them or poll independently when the library exposes a subscription.
- An unrecognized tool degrades to the generic strategy instead of disappearing from the overview.
- The attention reducer is pure and total over previous attention and evidence.
- Acknowledgement is sticky until the session genuinely changes phase.
- The panel is always-on-top, keyboard-navigable, and focusable.
- Doctor is read-only: it inspects host and storage metadata and queries inventory, and never creates state or launches a terminal.
- Voice owns recognition, routing, and conversation policy; neither plugin becomes the other's runtime broker.

## Verification

Run format, build, Clippy with warnings denied, and tests, plus `cargo run -q -p qol -- check`. Compile every manifest-declared target. Reducer and strategy logic must be covered without a live terminal. Panel behavior claims - placement, always-on-top, keyboard routing - need evidence from a real desktop session, which per the workspace rule means a guest environment rather than the host.
