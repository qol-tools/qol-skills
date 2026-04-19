---
name: pointz-client
description: Use when working on the PointZ Flutter mobile client for discovery, gesture handling, and UDP command transport.
---

## Current State

PointZ v0.4.0 - Flutter mobile client for remote PC control. Connects to PointZerver (Rust server) running on desktop.

**Platforms:** Android, iOS

### Recent Changes (Jan 2026)
- Fix: Client-side throttling (16ms sample rate) to reduce UDP packet flooding
- Architecture: Multi-interface discovery for hotspot support
- Fix: Synced local repo with remote
- Fix: Restored ADB pairing scripts (adb-autoconnect.sh, adb-pair-wireless.sh)

### What Works
- UDP-based server discovery (broadcast on port 45454)
- UDP command sending (mouse, keyboard on port 45455)
- Touch gesture recognition and conversion to mouse commands
- Multi-finger gestures (2-finger right-click, 3-finger middle-click)
- Tap-and-hold drag mode
- Hardware keyboard capture and forwarding
- Settings: sensitivity, acceleration, scroll speed
- Wireless ADB pairing and auto-connect

### Architecture

```
lib/
├── main.dart                     # App entry point
├── domain/models/                # Data models
│   ├── gesture_event.dart
│   └── touch_action.dart
├── features/
│   ├── gesture/                  # Touch gesture recognition
│   │   ├── gesture_detector.dart # Flutter event → TouchAction
│   │   ├── gesture_handler.dart  # TouchAction → Commands
│   │   ├── handlers/
│   │   │   ├── move_handler.dart # Mouse movement with acceleration
│   │   │   ├── down_handler.dart
│   │   │   ├── up_handler.dart
│   │   │   └── pointer_handler.dart
│   │   ├── config/
│   │   │   └── gesture_config.dart
│   │   └── state/
│   │       └── gesture_state.dart
│   ├── keyboard/                 # Hardware keyboard capture
│   │   ├── keyboard_handler.dart
│   │   └── implementations/
│   │       └── command_service_keyboard_executor.dart
│   └── mouse_control/            # Mouse command execution
│       └── implementations/
│           └── command_service_executor.dart
├── screens/                      # UI Screens
│   ├── discovery_screen.dart    # Server discovery UI
│   ├── control_screen.dart      # Main control interface
│   └── settings_screen.dart     # App settings
└── services/                     # Core services
    ├── discovery_service.dart   # UDP server discovery
    ├── command_service.dart     # UDP command sending (16ms throttle)
    └── settings_service.dart    # App preferences
```

### Protocol

**Discovery (UDP port 45454):**
```
Client → Broadcast: "DISCOVER"
Server → Response: {"hostname": "my-computer"}
```

**Commands (UDP port 45455):**
```json
{"type": "MouseMove", "x": 10.5, "y": 20.5}
{"type": "MouseClick", "button": 1}
{"type": "KeyPress", "key": "a", "modifiers": {"ctrl": true}}
```

### Settings

**Client Settings:**
- `mouseSensitivity` - Default 2.5
- `minAcceleration` - Default 1.0
- `maxAcceleration` - Default 1.8
- `accelerationThreshold` - Default 25.0
- `scrollSpeed` - Default 0.2

### Development Workflow

**Running on Device:**
```bash
make pair              # Pair phone via wireless ADB
make run               # Run on connected device
```

**Building APK:**
```bash
flutter build apk --release
```

**Testing:**
```bash
flutter test
```

### Key Components

**discovery_service.dart:**
- Listens for UDP broadcasts on port 45454
- Parses server responses (JSON with hostname)
- Supports multi-interface discovery for hotspot connections

**command_service.dart:**
- Sends mouse/keyboard commands via UDP to port 45455
- 16ms throttling to prevent packet flooding
- Handles connection state and error recovery

**gesture_detector.dart:**
- Converts Flutter touch events to TouchAction domain model
- Handles single/multi-finger gestures
- Manages tap-and-hold drag mode

**move_handler.dart:**
- Applies mouse sensitivity and acceleration
- Converts touch deltas to cursor movement
- Configurable acceleration curve

### Known Issues / TODO

1. **Gradle build errors** - `flutter run` sometimes fails with truncated error message
   - Workaround: Use `flutter build apk` then `adb install -r app-release.apk`

### File Locations

**APK Output:**
- `build/app/outputs/flutter-apk/app-release.apk`

**Source:**
- `lib/` - Main source code
- `test/` - Flutter tests

**Scripts:**
- `scripts/adb-pair-wireless.sh` - Auto-detect and pair phone
- `scripts/adb-autoconnect.sh` - Auto-connect to paired phone
