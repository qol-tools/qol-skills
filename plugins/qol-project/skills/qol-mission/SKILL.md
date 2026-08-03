---
name: qol-mission
description: Use when weighing trade-offs that touch the mission of qol-tools — what the product is, who it's for, and the non-negotiable user-facing promises that any feature, bug fix, or architecture decision must respect. Covers the user experience, portability, host-OS interaction, hotkeys, settings, sync, and "what qol-tools should do for the user".
---

# qol-tools Mission

## What it is

qol-tools is a **portable quality-of-life layer for any computer you sit down at**. The user installs once, configures once, and that flavor — their plugins, their keybindings, their settings — follows them everywhere. They plug in a USB stick (or sync a profile), boot qol-tray, and the machine *becomes theirs*.

## Who it's for

People who use multiple machines (work laptop, home desktop, friend's PC, fresh install, throwaway VM) and want a consistent personal computing layer that doesn't depend on the host OS, distro, or desktop environment.

## Vision (where we're going, not where we are)

Isolated slices, independently revisable. **P0** = founding (changes what qol-tools IS). **P1** = active expansion. **P2** = seeded direction. Every architectural choice should be checked against the active slices: does it make these futures easier or harder? If harder, redesign.

### V1: Multi-OS, multi-injection portability

**Priority:** P0

The full dream: walk up to **any** computer - Windows, macOS, any Linux distro - and inject qol-tray however is convenient. USB stick. Phone over USB or AirDrop-style wireless. Network share. SSH push. Fresh install. The host OS does not matter, the injection method does not matter. Within seconds the machine carries your bespoke flavor: your plugins, your keybindings, your sync, your colors, your habits. Pull the medium, walk away, the host is exactly as you found it.

### V2: Browsers are another portability axis

**Priority:** P1

A large fraction of the user's shortcuts ultimately drive a browser: open a URL, focus an existing tab, navigate within a single-page app. The browser is a host in its own right, and qol-tray should treat it the way it treats the operating system. One mission-level concept, per-browser adapters underneath.

**Asymmetry worth naming.** OS adapters in qol-tray live inside the same Rust process. Browser adapters live inside the browser sandbox, on the browser's update cadence, behind store review. The contract is one trait surface in qol-tray, plus a WebExtension shipped per browser. Structurally the same strategy-adapter pattern as `platform/macos`, `platform/linux`, `platform/windows`, but the wire crosses a process boundary.

**Two-tier delivery.** The contract surface (open-or-focus URL, focus tab by URL pattern, list tabs, current selection) ships in two tiers:

1. **Zero-install tier** - OS-level scripting where available: AppleScript on macOS, DBus on Linux, UIA on Windows. Covers the common "reuse tab if open, otherwise new" case with no extension to install. Brittle to browser updates; that is the trade.
2. **Extension tier** - one WebExtension codebase (WXT framework) built per browser (Firefox, Chrome, Brave, Safari) talking to qol-tray over a loopback WebSocket with a token handshake. Not native messaging: Safari restricts native messaging to a container app, MV3 service workers die mid-conversation, and per-OS host-manifest install is the #1 source of "extension installed but nothing works" tickets. WebSocket reconnects survive service-worker death and the same wire works across browsers.

**Shortcuts are authored against the concept, not the browser.** When the user switches from Firefox to Brave, their shortcuts keep working; qol-tray routes to whichever adapter is reachable, zero-install tier first, extension tier as the power upgrade.

Every non-negotiable below applies to browser adapters: no manual host configuration, qol-tray owns the contract, teardown restores prior state, dependencies are bundled, and failures are visible.

## Non-negotiables

These are invariants. If a proposed change violates one, the change is wrong, not the mission.

> This skill is the only home for the mission. The full context (vision, who it's for, why each invariant matters) stays here.

### 1. The user never configures the host OS

qol-tray handles everything. The user does not edit Cinnamon keybindings, GNOME shortcuts, plist files, registry keys, or systemd units to make qol-tools work. If qol-tray needs the OS to behave differently, qol-tray makes it happen — silently, reversibly, and without the user knowing.

### 2. qol-tray owns its surface area

For anything qol-tray claims (hotkeys, tray icon, system menu entries, autostart, etc.) qol-tray is the source of truth. If a desktop environment has already grabbed the same hotkey, qol-tray takes it back. If a plugin wants Super+Space, that hotkey belongs to the plugin while qol-tray is running — period.

### 3. The host machine is left exactly as found

When qol-tray exits — whether cleanly, by crash, or by USB removal — the host's pre-existing state is restored. Hotkeys that qol-tray took back are returned. Files written outside the qol-tray profile dir are deleted or were never written. The machine should not be able to tell, after the fact, that qol-tray was ever there.

### 4. Plug-in to working in seconds, not minutes

The full path from "plug in USB" to "my keybindings work, my plugins are loaded, my profile is synced" is measured in single-digit seconds. Anything slower is a bug.

### 5. Self-contained: no host-side dependencies the user has to install

If qol-tray needs a runtime, library, or daemon, it ships with qol-tray. It does not assume the host has Python, Rust, GTK, MQTT, anything. Plugins that need extra services bundle them.

### 6. Failures are visible and self-explanatory

If qol-tray can't do something the user expects (a plugin failed to start, a hotkey couldn't be claimed, a sync conflict happened), the user sees it immediately and clearly — in the tray, in a notification, in the UI. Silent failures are bugs.

## Extraction decision rules

Structural splits require concrete signal rather than a status timeline.

- **`qol-sdk` package** — extract dev-experience features from qol-tray only after multiple dev-only surfaces establish shared auth/path conventions, need an independent release cadence, and must run without the full daemon. Before that trigger, keep them behind the host's dev feature boundary. Cost of waiting is low; premature extraction creates a repository and release pipeline without a proven shared contract.

## How to use this in design discussions

When evaluating a proposal:

- Does it require the user to touch host-OS settings? → **Reject or redesign.**
- Does it leave residue on the host after exit? → **Add cleanup, or redesign.**
- Does it assume software is pre-installed on the host? → **Bundle it, or redesign.**
- Does it fail silently? → **Surface the failure.**
- Does it slow down first-run? → **Justify or shrink.**

## Related skills

- `qol-tools` (org-level layout, dependency model)
- `qol-arch-code` / `qol-arch-cross-platform` / `qol-arch-cicd` (how this mission shapes Rust strategy patterns, symbol hygiene, and CI workflow contracts)
- `qol-tray-core` (host application implementation)
