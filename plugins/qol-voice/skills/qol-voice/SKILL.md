---
name: qol-voice
description: Use when working on the qol-voice plugin. Covers audio capture and utterance segmentation, the engine-neutral transcription provider registry, local and remote speech-to-text backends, the pure turn coordinator and its policy, routing completed turns to live terminal sessions, voice session lifecycle, and doctor checks. Triggers on "qol-voice", voice, speech-to-text, transcription, whisper, utterance, turn taking, or dictating into a terminal session.
---

# qol-voice

QoL Voice transcribes speech and routes completed turns to live terminal sessions. It owns recognition, turn taking, and conversation policy; live terminal identity and delivery come from the shared terminal-sessions library.

## Contract sources

- `plugin.toml` owns actions, daemon metadata, declared capabilities, config scoping, platform availability, and release artifacts.
- `qol-config.toml` owns settings sections, fields, and defaults.
- `qol-runtime.toml` owns the runnable action contract.
- `Cargo.toml` owns target-scoped native and model dependencies.

Config scoping is part of the manifest contract: settings that describe this machine's hardware or its routing target are device-scoped rather than synced, so a synced profile cannot point one machine at another machine's microphone or terminal. Read the declared scopes before adding a field.

## Source ownership

| Path | Responsibility |
|---|---|
| `src/cli/` | Headless command surface and doctor registration. |
| `src/audio/` | Audio format, encoding, and frame types. |
| `src/listen/` | Capture, device probing, utterance segmentation, and drop accounting. |
| `src/transcribe/` | Engine-neutral provider registry, descriptors, capabilities, and the session trait. |
| `src/transcribe/platform/` | Target-selected providers, including the local model backend. |
| `src/transcribe/websocket/` | Remote provider transport and its protocol. |
| `src/turn/` | Turn coordinator, turn policy, and the control model. |
| `src/voice_session/` | Session lifecycle, typed errors, evidence, and control handles. |
| `src/app/` | Routing decisions, delivery sinks, target watching, and worker orchestration. |
| `src/ui/` | gpui surface. |

## Turn coordination

The turn coordinator is a pure state machine parameterized by a policy. Observations arrive in an envelope carrying a session id and a sequence number, are validated against current state, and produce a batch of effects. It performs no I/O, so it can be tested exhaustively over event orderings.

Keep it that way. Recognition, playback, and delivery belong on the far side of an effect - the coordinator decides *what should happen*, and the worker performs it. Reaching into audio or terminals from inside the coordinator destroys the one component that can be reasoned about deterministically.

Sequence validation is a real invariant, not defensive coding: out-of-order or replayed observations must be rejected rather than folded into state, and the control schema is versioned so a mismatched peer fails loudly.

## Transcription providers

Providers are registered and described, not hardcoded. A descriptor carries the provider's capabilities and whether it runs locally or remotely, and selection happens against a request. Adding an engine means adding a provider and its descriptor; consumers select through the registry and never name an engine directly.

Local and remote providers are not interchangeable in privacy terms. A remote provider sends audio off the machine, so it is only used when explicitly configured, and doctor probes a configured remote service without sending audio to it.

## Common changes

**Add a transcription engine:** implement the provider and its session, publish an honest descriptor, and register it for the targets where it actually runs. Do not widen a descriptor's capabilities to make selection succeed.

**Change turn behavior:** change the policy, not the coordinator. Add cases over observation sequences; a behavior that can only be demonstrated with live audio is under-specified.

**Change routing:** routing decides which live terminal target receives a completed turn. Consume terminal identity and delivery from the shared library, and keep target selection and conversation policy local.

**Change capture or segmentation:** keep the reason an utterance ended typed and surfaced. Dropped audio is accounted for by stage rather than silently discarded, because "it transcribed nothing" and "it never captured anything" need different fixes.

## Invariants

- The turn coordinator is pure: observations in, effects out, no I/O.
- Observations are validated against session and sequence before they touch state.
- Providers are selected through the registry by capability, never named directly by consumers.
- Audio leaves the machine only through an explicitly configured remote provider.
- Device- and routing-scoped settings stay device-scoped so a synced profile cannot retarget another machine.
- Failures are typed and actionable - a missing microphone, an unavailable model, and an unreachable service are distinguishable.
- Doctor is read-only: it reports capability and probes only what is configured, and never captures or transmits audio.
- CLI Sessions owns terminal dashboard and attention policy; neither plugin becomes the other's runtime broker.

## Verification

Run format, build, Clippy with warnings denied, and tests, plus `cargo run -q -p qol -- check`. Turn, routing, and provider-selection logic must be covered without a microphone or a network. Claims about capture, transcription accuracy, or delivery into a live session need evidence from a real run on a declared target, which per the workspace rule means a guest environment rather than the host.
