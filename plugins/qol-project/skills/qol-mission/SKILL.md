---
name: qol-mission
description: Use when weighing trade-offs that touch the mission of qol-tools — what the product is, who it's for, the Portable and Resident host-ownership contracts, and the non-negotiable user-facing promises that any feature, bug fix, or architecture decision must respect. Covers the user experience, portability, persistent host policy, host-OS interaction, hotkeys, settings, sync, and "what qol-tools should do for the user".
---

# qol-tools Mission

## What it is

qol-tools is a **portable quality-of-life layer for any computer you sit down at**. The user configures their flavor once — their plugins, keybindings, settings, colors, and habits — and carries it everywhere. On a borrowed or temporary computer, that flavor leaves with them. On a trusted personal computer, it can remain active between qol-tray runs until they deliberately release it.

## Who it's for

People who use multiple machines (work laptop, home desktop, friend's PC, fresh install, throwaway VM) and want one consistent personal computing layer without pretending every host has the same ownership relationship. The same profile must work on both a borrowed machine that must be left untouched and a personal machine that should retain explicitly adopted policy.

## Vision (where we're going, not where we are)

Isolated slices, independently revisable. **P0** = founding (changes what qol-tools IS). **P1** = active expansion. **P2** = seeded direction. Every architectural choice should be checked against the active slices: does it make these futures easier or harder? If harder, redesign.

### V1: Multi-OS, multi-injection portability

**Priority:** P0

The full dream: walk up to **any** computer - Windows, macOS, any Linux distro - and inject qol-tray however is convenient. USB stick. Phone over USB or AirDrop-style wireless. Network share. SSH push. Fresh install. The host OS does not matter, the injection method does not matter. Within seconds the machine carries your bespoke flavor. Portable hosts return exactly to their prior state when qol leaves. Resident hosts retain only the policies explicitly adopted for that host, and return exactly to their prior state when residency is disabled or qol is uninstalled.

### V2: Browsers are another portability axis

**Priority:** P1

A large fraction of the user's shortcuts ultimately drive a browser: open a URL, focus an existing tab, navigate within a single-page app. The browser is a host in its own right, and qol-tray should treat it the way it treats the operating system. One mission-level concept, per-browser adapters underneath.

**Asymmetry worth naming.** OS adapters in qol-tray live inside the same Rust process. Browser adapters live inside the browser sandbox, on the browser's update cadence, behind store review. The contract is one trait surface in qol-tray, plus a WebExtension shipped per browser. Structurally the same strategy-adapter pattern as `platform/macos`, `platform/linux`, `platform/windows`, but the wire crosses a process boundary.

**Two-tier delivery.** The contract surface (open-or-focus URL, focus tab by URL pattern, list tabs, current selection) ships in two tiers:

1. **Zero-install tier** - OS-level scripting where available: AppleScript on macOS, DBus on Linux, UIA on Windows. Covers the common "reuse tab if open, otherwise new" case with no extension to install. Brittle to browser updates; that is the trade.
2. **Extension tier** - one WebExtension codebase (WXT framework) built per browser (Firefox, Chrome, Brave, Safari) talking to qol-tray over a loopback WebSocket with a token handshake. Not native messaging: Safari restricts native messaging to a container app, MV3 service workers die mid-conversation, and per-OS host-manifest install is the #1 source of "extension installed but nothing works" tickets. WebSocket reconnects survive service-worker death and the same wire works across browsers.

**Shortcuts are authored against the concept, not the browser.** When the user switches from Firefox to Brave, their shortcuts keep working; qol-tray routes to whichever adapter is reachable, zero-install tier first, extension tier as the power upgrade.

Every non-negotiable below applies to browser adapters: no manual host configuration, qol-tray owns the contract, teardown restores prior state, dependencies are bundled, and failures are visible.

## One profile, two host-ownership contracts

Portable and Resident are not two products or two profiles. They are host-local ownership contracts for the same portable flavor.

**One install, your rules** and **walk away without a trace** are not competing promises. Resident owns the first on a trusted host. Portable owns the second everywhere else. The profile and user experience stay recognizably qol across both.

### Portable

Portable is the default and the founding promise. qol may borrow host resources only through session-scoped mutations that restore the exact prior state. Clean exit restores immediately. Abnormal exit, crash, or removal must have a deterministic recovery path. If a mutation cannot be made self-reverting or reliably recovered, Portable mode must not apply it.

### Resident

Resident is explicit opt-in for a trusted personal host. It permits durable host policy that remains useful while qol-tray is not running. Every Resident mutation must snapshot prior state before applying, claim only the state qol introduced, remain visible and reversible, and restore the snapshot when residency is disabled or qol is uninstalled.

Resident is selected separately on each host. The choice and its mutation journal are host-local and never sync with the profile. A synced profile may describe desired capabilities, but it must not silently convert another machine from Portable to Resident.

### Architecture contract

Every host mutation must declare its lifetime as `PortableSession` or `ResidentPolicy` at the owning platform boundary. The orchestration layer must not infer lifetime from the current OS, install path, launch medium, or whether the change happens to persist.

- `PortableSession` requires snapshot-before-mutation and deterministic restoration after normal and abnormal termination.
- `ResidentPolicy` requires explicit host-local consent, durable ownership state, idempotent reconciliation, and exact restoration on disable or uninstall.
- Neither lifetime may adopt, overwrite, or later clear pre-existing host state it did not create.
- If the platform cannot satisfy the selected lifetime, surface the limitation and leave the host unchanged.

## Non-negotiables

These are invariants. If a proposed change violates the selected ownership contract, the change is wrong, not the mission.

> This skill is the only home for the mission. The full context (vision, who it's for, why each invariant matters) stays here.

### 1. The user never configures the host OS

qol-tray handles everything. The user does not edit Cinnamon keybindings, GNOME shortcuts, plist files, registry keys, or systemd units to make qol-tools work. If qol-tray needs the OS to behave differently, qol-tray makes it happen — silently, reversibly, and without the user knowing.

### 2. qol-tray owns its surface area

For anything qol-tray claims (hotkeys, tray icon, system menu entries, autostart, package guards, etc.) qol-tray is the source of truth for the declared lifetime. If a desktop environment has already grabbed the same hotkey, qol-tray takes it back for the Portable session. If a Resident policy persists between runs, qol owns and reconciles only the state it introduced until the user releases that host.

### 3. The host machine is restored at the ownership boundary

Portable restores the host's pre-existing state when the session ends, whether by clean exit, crash, or removal. Resident intentionally outlives a process, but restores the host's pre-existing state when residency is disabled or qol is uninstalled. In both modes, qol must distinguish its mutations from pre-existing state and must never restore by erasing changes it did not own.

### 4. Plug-in to working in seconds, not minutes

The full path from "plug in USB" to "my keybindings work, my plugins are loaded, my profile is synced" is measured in single-digit seconds. Anything slower is a bug.

### 5. Self-contained: no host-side dependencies the user has to install

If qol-tray needs a runtime, library, or daemon, it ships with qol-tray. It does not assume the host has Python, Rust, GTK, MQTT, anything. Plugins that need extra services bundle them.

### 6. Failures are visible and self-explanatory

If qol-tray can't do something the user expects (a plugin failed to start, a hotkey couldn't be claimed, a sync conflict happened, a host cannot honor the selected mutation lifetime), the user sees it immediately and clearly — in the tray, in a notification, in the UI. Resident policy and its owned mutations must remain inspectable. Silent failures and invisible persistence are bugs.

## Extraction decision rules

Structural splits require concrete signal rather than a status timeline.

- **`qol-sdk` package** — extract dev-experience features from qol-tray only after multiple dev-only surfaces establish shared auth/path conventions, need an independent release cadence, and must run without the full daemon. Before that trigger, keep them behind the host's dev feature boundary. Cost of waiting is low; premature extraction creates a repository and release pipeline without a proven shared contract.

## How to use this in design discussions

When evaluating a proposal:

- Does it require the user to touch host-OS settings? → **Reject or redesign.**
- What is each host mutation's declared lifetime? → **Require `PortableSession` or `ResidentPolicy`; reject implicit persistence.**
- Can Portable restore after clean and abnormal termination? → **Add deterministic recovery, or leave the host unchanged.**
- Does Resident snapshot, own, expose, reconcile, and reverse only its own state? → **Add the missing lifecycle, or reject the mutation.**
- Is Resident opt-in host-local and excluded from profile sync? → **Fix the boundary before implementation.**
- Does it assume software is pre-installed on the host? → **Bundle it, or redesign.**
- Does it fail silently? → **Surface the failure.**
- Does it slow down first-run? → **Justify or shrink.**

## Related skills

- `qol-tools` (org-level layout, dependency model)
- `qol-arch-code` / `qol-arch-cross-platform` / `qol-arch-cicd` (how this mission shapes Rust strategy patterns, symbol hygiene, and CI workflow contracts)
- `qol-tray-core` (host application implementation)
