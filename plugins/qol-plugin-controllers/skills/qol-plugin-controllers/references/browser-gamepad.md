# Browser gamepad and haptics

Source-checked 2026-07-13 against the [W3C Gamepad Working Draft dated 2025-07-10](https://www.w3.org/TR/2025/WD-gamepad-20250710/). Inspect current implementation before assuming paths or browser behavior remain unchanged.

## Browser model

The Gamepad API exposes normalized buttons, axes, a browser-selected mapping, a non-unique identification string, timestamps, connection state, and optional haptics. `getGamepads()` may return no devices until the page has observed a gamepad gesture. The browser owns normalization and may alter exposed device details for fingerprinting mitigation.

In qol-tray:

- `gamepad-model.js` snapshots and normalizes browser data, merges native input, and derives connection presentation.
- `gamepad-profiles.js` selects hardware geometry, legends, and controller-side controls.
- `useGamepadMonitor.js` owns browser polling, native query polling, selection, visibility, and connection events.
- `gamepad-haptics.js` detects actuators and plans bounded effects.
- `gamepad-illustration.js` and `gamepad-geometry.js` own the reusable visual and clearance rules.

## Mapping profiles

The W3C `standard` mapping identifies the canonical Standard Gamepad layout. It does not guarantee that every extra physical control is exposed, that vendor controls generate browser events, or that every browser/driver combination maps a particular device correctly.

Apply corrections narrowly:

1. Match a stable family identity, preferably vendor/product evidence plus a recognizable model string.
2. Require the observed button/axis shape that demonstrates the quirk.
3. Remap only the affected browser/device shape.
4. Preserve already-canonical shapes from other browsers.
5. Surface unclaimed buttons dynamically so new firmware or drivers remain inspectable.

The GuliKit Firefox correction is the model case: its extended raw layout needs remapping, while a canonical 17-button layout must remain untouched. Native evdev supplementation supplies stick-click state without replacing browser axes, triggers, or face buttons.

## Native/browser merge

Treat browser and native input as complementary sources:

- Browser: axes, analog values, canonical mapping, connection events, and haptic actuators.
- Native plugin: physical device identity, exact transport/adapter evidence, and inputs missing from the browser mapping.

Match one native item to one browser snapshot. Include inventory, connection metadata, buttons, axes, profile, and haptic mode in the monitor signature so meaningful changes rerender without forcing every polling tick to render.

## Haptics

The W3C `dual-rumble` effect defines `strongMagnitude` as low-frequency intensity and `weakMagnitude` as high-frequency intensity, both normalized to `[0, 1]`. Duration and start delay use milliseconds. The specification recommends that user agents cap effects at five seconds.

Use this fallback order:

1. Standards-style `vibrationActuator.effects` plus `playEffect()`.
2. Legacy `vibrationActuator.type === "dual-rumble"` plus `playEffect()`.
3. A single `hapticActuators[0].pulse()` actuator.
4. Unsupported with an honest UI state.

Keep effect planning pure. Clamp magnitudes, keep individual effects short, and make a sweep wait for each requested duration even if a browser resolves `playEffect()` immediately. Stop or reset effects when playback is cancelled, the selected gamepad changes, the pad disconnects, the document hides, or the component unmounts. The W3C specification also requires hidden documents to stop active haptics.

## Domain-specific verification

Follow the browser-hardware recipe in `qol-tray:qol-apps-testing`. For Controllers, include these assertions:

- A fake `navigator.getGamepads()` can expose standard, raw, extra-button, disconnected, and multi-controller shapes.
- A fake actuator records effect type, magnitude, duration, ordering, and reset calls.
- A native query response carries typed signal and adapter metadata and merges only into the matching controller.
- Sweep timing does not collapse when the fake actuator resolves immediately.
- Visibility, disconnect, selection change, and unmount cancel active rumble.
- Profile geometry keeps every control inside the body and clear of neighboring controls.

Use a real controller WebUI smoke test after deterministic tests when hardware is available. Browser fakes prove contracts; they do not prove the OS/browser/device stack emits the expected events.
