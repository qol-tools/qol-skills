---
name: pointz-client
description: Use when working on the PointZ Flutter mobile client (the phone app; the desktop side is PointZerver) for discovery, SPAKE2 pairing, sealed command transport, gesture handling and settings. Pair with qol-plugin-pointz for desktop protocol changes.
---

# PointZ mobile client

The Flutter client discovers a PointZ desktop server and translates touch or keyboard input into the shared wire protocol. The active client checkout placed in task scope is authoritative; do not choose between similarly named historical checkouts from prose.

## Source of truth

- `pubspec.yaml` owns package identity, SDK constraints, dependencies, and app version.
- Flutter target directories plus build configuration own supported client platforms.
- `lib/services/discovery_service.dart` owns discovery transport and response parsing.
- `lib/services/command_service.dart` owns command transport, pacing, and the ping timer, and `lib/services/connection_status.dart` owns the connection states and reply decoding; every command leaves inside the sealed envelope from `lib/services/pairing/command_envelope.dart`.
- `lib/services/pairing/` owns pairing: `pairing_service.dart` runs the exchange over the discovery port, `spake2_client.dart` and `edwards25519.dart` hold the password-authenticated key exchange, `pair_messages.dart` the wire messages and error texts, `pairing_store.dart` the device id and per-desktop device keys in the platform keystore, `byte_codec.dart` the encodings. `lib/screens/pairing_screen.dart` owns the code entry screen.
- `lib/features/gesture/` owns touch recognition and command intent.
- `lib/features/keyboard/` owns hardware-key translation when that module exists.
- `lib/services/settings_service.dart` and the settings screen own persisted client preferences.
- `test/` owns executable behavior claims.

Inspect those paths before stating a capability, setting default, throttle interval, port, or platform. If a path has moved, follow imports from `lib/main.dart` rather than reconstructing an old tree.

## Desktop protocol boundary

Discovery ports and messages must match qol-tray's PointZ peer transport in `libs/peers/src/service/pointz/` (DISCOVERY_PORT/COMMAND_PORT); the plugin advertises those ports from `src/config/mod.rs` through its `connection_info` query. Command JSON must match the plugin's `src/command/model.rs`.

The discovery reply carries `server_id`, `authentication` and `command` scheme tags and `pairing_open`; `DiscoveredServer.compatibility` compares the tags with the ones this build speaks (`requiredAuthentication`, `requiredCommand` in `discovery_service.dart`). A desktop with older tags shows "PointZerver on the desktop is older, update it" and a desktop with unknown newer tags shows "This app is older than PointZerver, update it"; neither can be paired or driven. Bump the required tags together with the desktop transport constants and the test vector.

Pairing is SPAKE2 (RFC 9382 on edwards25519) over the discovery port while the desktop shows its 6-digit code: PairHello carries the phone's share, PairOffer the desktop's share and salt, PairConfirm and PairResult the confirmations, and the device key arrives sealed with the key derived from the exchange. The desktop crate's `vector.rs` and the phone's `test/spake2_vector_test.dart` hold the same vector; a derivation change must update both. Commands travel in envelope version 3: ChaCha20-Poly1305 over the command JSON, bound to the version byte, the big-endian send time and the device id. The phone never stores the code and never sends it.

Connection state comes from the desktop, never from the phone's own socket. `command_service.dart` sends a sealed `Ping` on a timer and `connection_status.dart` reads the answer: a sealed `Pong` naming the ping's nonce means connected, a clear `Rejected` naming it carries the reason (`unknown_device` for a phone removed in PointZerver, `clock` for clocks too far apart), and silence past the reply timeout means the desktop is not responding. `Rejected` is not authenticated, so it only changes what the screen shows and offers Pair again; never delete a stored key on it. The phone pings only a desktop whose discovery reply carries the `status` tag in `DiscoveredServer.supportedStatus`; without it the screen says the state cannot be confirmed.

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
- A desktop is driven only with a device key the phone obtained through pairing with that desktop's `server_id`; keys live in the keystore, never in preferences or logs.
- Settings are persisted through one service and consumed as typed values.
- Build or runtime limitations belong in tracked issues or executable checks, not a skill status section.
