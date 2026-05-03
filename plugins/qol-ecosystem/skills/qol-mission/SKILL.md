---
name: qol-mission
description: The overarching mission of qol-tools — what the product is, who it's for, and the non-negotiable user-facing promises that any feature, bug fix, or architecture decision must respect. Load this whenever you're about to weigh trade-offs that touch the user experience, portability, host-OS interaction, hotkeys, settings, sync, or "what qol-tools should do for the user".
---

# qol-tools Mission

## What it is

qol-tools is a **portable quality-of-life layer for any computer you sit down at**. The user installs once, configures once, and that flavor — their plugins, their keybindings, their settings — follows them everywhere. They plug in a USB stick (or sync a profile), boot qol-tray, and the machine *becomes theirs*.

## Who it's for

People who use multiple machines (work laptop, home desktop, friend's PC, fresh install, throwaway VM) and want a consistent personal computing layer that doesn't depend on the host OS, distro, or desktop environment.

## Non-negotiables

These are invariants. If a proposed change violates one, the change is wrong — not the mission.

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

## How to use this in design discussions

When evaluating a proposal:

- Does it require the user to touch host-OS settings? → **Reject or redesign.**
- Does it leave residue on the host after exit? → **Add cleanup, or redesign.**
- Does it assume software is pre-installed on the host? → **Bundle it, or redesign.**
- Does it fail silently? → **Surface the failure.**
- Does it slow down first-run? → **Justify or shrink.**

## Related skills

- `qol-tools` (org-level layout, dependency model)
- `qol-architecture` (how this mission shapes Rust strategy patterns)
- `qol-tray` (host application implementation)
