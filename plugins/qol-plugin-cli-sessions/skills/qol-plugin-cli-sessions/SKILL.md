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

Interpretation is a registry, not a chain of conditionals. The strategy trait carries a working default so an unrecognized tool still produces a usable reading; tool-specific implementations supply evidence hooks (`working`, `awaiting`, `turn_taken`) and never re-derive the phase order. The trait's default `read` composes the hooks through the pure `phase_for` skeleton (Busy > Blocked > Done > Idle) and applies the moving-screen invariant in exactly one place: a changing screen is a working session, so every waiting phase (Blocked, Done) requires a settled screen, and a moving screen with no evidence still reads Busy. Dropping that condition turns every busy session into a false "your turn" alert. The generic shell strategy overrides `read` because it is busy-by-default (absence of a foreground process is the idle signal), which does not fit the evidence skeleton. Adding support for a new CLI tool means adding a strategy, registering it for that tool, and covering its evidence with cases - never branching on the tool inside shared code and never writing a phase if-else ladder inside a strategy.

Readings are two-stage on purpose. A strategy returns a phase plus an optional label; a separate pure transition maps the previous status and the new phase to the next status. Keep the transition pure - it is the part worth testing exhaustively, and it is where sticky states are honored so an acknowledged session does not re-alert on every poll.

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
