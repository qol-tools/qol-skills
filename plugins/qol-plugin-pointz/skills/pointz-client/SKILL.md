---
name: pointz-client
description: Use when working on the PointZ Flutter mobile client for discovery, gesture handling, settings, and UDP command transport. Pair with qol-plugin-pointz for desktop protocol changes.
---

# PointZ mobile client

The Flutter client discovers a PointZ desktop server and translates touch or keyboard input into the shared wire protocol. The active client checkout placed in task scope is authoritative; do not choose between similarly named historical checkouts from prose.

## Source of truth

- `pubspec.yaml` owns package identity, SDK constraints, dependencies, and app version.
- Flutter target directories plus build configuration own supported client platforms.
- `lib/services/discovery_service.dart` owns discovery transport and response parsing.
- `lib/services/command_service.dart` owns command transport, pacing, and connection state.
- `lib/features/gesture/` owns touch recognition and command intent.
- `lib/features/keyboard/` owns hardware-key translation when that module exists.
- `lib/services/settings_service.dart` and the settings screen own persisted client preferences.
- `test/` owns executable behavior claims.

Inspect those paths before stating a capability, setting default, throttle interval, port, or platform. If a path has moved, follow imports from `lib/main.dart` rather than reconstructing an old tree.

## Desktop protocol boundary

Discovery ports and messages must match the desktop plugin's `src/config/mod.rs` and `src/discovery/model.rs`. Command JSON must match `src/command/model.rs`.

Change client and server protocol definitions together. Preserve tolerant decoding when adding optional fields; require an intentional compatibility decision for renamed commands, changed enum spelling, or port changes.

Do not duplicate protocol examples in this skill. Generate fixtures from the model or keep paired tests on both sides so the executable sources reveal drift.

## Gesture ownership

Flutter pointer events become gesture-domain events before they become network commands. Keep recognition, gesture state, sensitivity/acceleration math, and transport separate so each can be tested without a device or socket.

When adding a gesture:

1. Define the gesture-domain transition and cancellation behavior.
2. Map it to an existing command or extend the paired protocol model.
3. Test competing pointer sequences, interruption, and reset behavior.
4. Verify on a physical device before claiming interaction quality.

## Settings ownership

Defaults and persistence keys live in the settings source, not this skill. A UI control, stored value, and consumer must change together. Clamp or validate user-controlled sensitivity, acceleration, scroll, and timing values before using them in gesture math.

## Development workflow

Use the commands exposed by the active client's `Makefile` or Flutter tooling. Run `flutter test` for deterministic logic and a device build for platform integration. ADB helper availability comes from the checkout's scripts directory; do not assume a named helper exists.

## Invariants

- Discovery is independent from command delivery and can recover from interface changes.
- High-frequency movement is paced or coalesced before UDP send.
- Gesture state resets after cancellation, disconnect, and lifecycle interruption.
- The client never invents command variants absent from the desktop model.
- Settings are persisted through one service and consumed as typed values.
- Build or runtime limitations belong in tracked issues or executable checks, not a skill status section.
