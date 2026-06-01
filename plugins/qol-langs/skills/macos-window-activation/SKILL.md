---
name: macos-window-activation
description: Use when a qol plugin (alt-tab, launcher, window-actions) must bring ANOTHER app's window to the front on macOS, or make its own popup key. Covers why NSRunningApplication.activate is inert on macOS 14+, why SkyLight `_SLPSSetFrontProcessWithOptions` is necessary but silently ignored against actively-front apps, the `kAXFrontmost` app attribute that actually foregrounds a fighting app, the generation-guarded re-assert loop that beats the picker-teardown race, AXRaise/unminimize ordering, reading the true frontmost window via CGWindowList, dlopen-ing a private framework, and the click-gesture / modifier-drop focus pitfalls. Built from a reproduced alt-tab focus bug, not generic docs. For our own popup's focus use gpui-conventions ("Eagerly stealing OS window focus"); this skill is about foregrounding a foreign app.
---

# macOS Window Activation & Focus

Foregrounding another process's window on macOS is not `NSRunningApplication.activate`. That call is **non-authoritative** on modern macOS and loses to apps that re-assert frontmost. The reliable path talks to the WindowServer directly via private SkyLight symbols, the way AltTab.app does.

## The core gotcha: `activate(.ignoringOtherApps)` is inert on macOS 14+

`NSRunningApplication.activate(options: .activateIgnoringOtherApps)` (objc2: `activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps)`) is **deprecated and has no effect from macOS 14**. The Swift toolchain says so itself:

```
'activateIgnoringOtherApps' was deprecated in macOS 14.0: ignoringOtherApps is
deprecated in macOS 14 and will have no effect.
```

It still **returns `true`** — so a `let ok = app.activate(...)` check is worthless; it reports success while doing nothing forceful. Measured on macOS 26: a plugin relying on it foregrounded the target ~87% of the time but **failed ~13% cross-app**, and failed reliably against an app that re-asserts frontmost (Microsoft Teams while screen-sharing kept stealing front). Two failure shapes:

- **Mode A** — target app never comes forward (the user's "selected app didn't focus").
- **Mode B** — right app, wrong window (a floating window like Teams' "Sharing Indicator" wins).

## The fix: authoritative activation via SkyLight

Bring the process **and** a specific window to the front through the WindowServer. `_SLPSSetFrontProcessWithOptions` is authoritative; two synthetic event records then make the chosen window key.

```rust
#[repr(C)]
#[derive(Clone, Copy)]
struct ProcessSerialNumber { high: u32, low: u32 }

#[link(name = "ApplicationServices", kind = "framework")]
extern "C" {
    fn GetProcessForPID(pid: i32, psn: *mut ProcessSerialNumber) -> i32; // deprecated, still works
}

// dlopen/dlsym live in libSystem (always linked) — NO #[link], NO build.rs,
// NO framework search path needed. This is how you reach a PRIVATE framework
// (SkyLight is in /System/Library/PrivateFrameworks, which the linker won't
// search) without a link-time dependency.
extern "C" {
    fn dlopen(path: *const std::ffi::c_char, mode: i32) -> *mut std::ffi::c_void;
    fn dlsym(handle: *mut std::ffi::c_void, sym: *const std::ffi::c_char) -> *mut std::ffi::c_void;
}

type SetFrontFn = unsafe extern "C" fn(*const ProcessSerialNumber, u32, u32) -> i32;
type PostEventFn = unsafe extern "C" fn(*const ProcessSerialNumber, *const u8) -> i32;

// Resolve once. path: "/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight"
// symbols: "_SLPSSetFrontProcessWithOptions", "SLPSPostEventRecordTo"

unsafe fn force_front(set_front: SetFrontFn, post: PostEventFn, pid: i32, wid: u32) -> bool {
    let mut psn = ProcessSerialNumber { high: 0, low: 0 };
    if GetProcessForPID(pid, &mut psn) != 0 { return false; }
    const K_CPS_USER_GENERATED: u32 = 0x200;
    set_front(&psn, wid, K_CPS_USER_GENERATED);
    // two synthetic event records make `wid` key (AltTab's makeKeyWindow layout)
    let mut b1 = [0u8; 0xf8];
    b1[0x04] = 0xf8; b1[0x08] = 0x01; b1[0x3a] = 0x10;
    b1[0x3c..0x40].copy_from_slice(&wid.to_ne_bytes());
    for x in b1[0x20..0x30].iter_mut() { *x = 0xff; }
    let mut b2 = b1; b2[0x08] = 0x02;
    post(&psn, b1.as_ptr()); post(&psn, b2.as_ptr());
    true
}
```

`set_front` foregrounds the **process** and is necessary, but it is **not sufficient on its own**. Measured on macOS 26: `_SLPSSetFrontProcessWithOptions` returns `0` (accepted) yet is **silently ignored** when an actively-front Regular app holds front (Firefox, PowerPoint, Teams) - the front never moves, not even 5ms after the call, no matter how many times you re-issue it. The authoritative foregrounder against a fighting app is the target **application's `kAXFrontmost` attribute** (next section). The synthetic events are best-effort (a malformed record is ignored, so they layer safely on top). Keep `NSRunningApplication.activate` only as a fallback when SkyLight fails to `dlopen`.

## `kAXFrontmost` on the app is the authoritative foregrounder

`AXUIElementPerformAction(win, kAXRaiseAction)` reorders a window **within its own app's z-stack**; it does **not** make the app frontmost, so AXRaise alone produces Mode A. And **AXRaise does not restore a minimized window** - clear `AXMinimized` (set false) *before* AXRaise or the raise is a no-op.

To foreground a **fighting** app where `set_front` is ignored, set the target application element's `kAXFrontmost` attribute. This goes through the accessibility activation path, honored even when `set_front` is not:

```rust
unsafe fn ax_app_frontmost(pid: i32) {
    let app = AXUIElementCreateApplication(pid); // null-check
    let attr = cfstr(b"AXFrontmost");
    let _ = AXUIElementSetAttributeValue(app, attr, kCFBooleanTrue);
    CFRelease(attr); CFRelease(app);
}
```

It can transiently return `kAXErrorCannotComplete` (-25204) if the app is momentarily busy; the re-assert loop (below) covers that.

Full order: unminimize → AXRaise (window) → `set_front` + synthetic key events (process + window) → `ax_app_frontmost` (app).

## Re-assert until it sticks (the teardown race)

A one-shot activation still loses ~5-10%, even with `set_front` + `AXFrontmost`. Root cause: the picker is a key-holding window owned by an Accessory daemon; on commit the daemon deactivates and the WindowServer **restores the previously-active app** (the source), clobbering the activation. Re-assert on a short, generation-guarded background loop until the target is actually frontmost:

- Poll the CG-frontmost pid at ~16/40/80/140/240/390ms; while it isn't the target, re-issue `set_front` + `ax_app_frontmost`.
- Guard with an `AtomicU64` generation bumped on every `activate_window`; a stale loop bails the instant a newer commit supersedes it, so it never fights the user's next pick.
- Verified: drops the cross-app failure rate to 0 across heterogeneous sources/targets including PowerPoint, Teams, and Firefox.

## Reading the TRUE frontmost window (telemetry / verification)

To check whether activation actually worked, read the user-perceived frontmost window from CoreGraphics — not `NSWorkspace.frontmostApplication` alone (that's app-level and async-settling):

- Enumerate `CGWindowListCopyWindowInfo(onScreenOnly | excludeDesktopElements, ...)`. The list is front-to-back.
- The **first window with `kCGWindowLayer == 0`** is the frontmost *normal* window. Popups/ghosts sit at `NSPopUpMenuWindowLevel` (layer != 0) and are correctly skipped.
- `kCGWindowOwnerPID`, `kCGWindowNumber`, `kCGWindowOwnerName`, `kCGWindowLayer` need **no** Screen Recording grant. Only `kCGWindowName` (the title) does.

This is callable from any thread (no `MainThreadMarker`), so it works from a background-thread deferred check.

## Accessory-app + key-ghost pitfall

An `Accessory` (`LSUIElement`) app that shows a key popup it never `orderOut`s / `resignKey`s does **not cleanly yield activation** — it stays the active app holding key. The authoritative SkyLight call sidesteps this. But if you are stuck on the public API, `orderOut` / resign your popup *before* activating the target so the WindowServer can hand off. (Historically a regression: dropping the `orderOut` on dismiss in favour of an alpha=0 keep-alive ghost is what left the app holding key.)

## Click-gesture pitfall (focus-related)

Native gestures fire **before** your app reacts — e.g. Option+Click on the Dock = "hide others". A click-to-dismiss popup **cannot** intercept them. To prevent a stray modifier-click from triggering an OS gesture while your picker is up, lay a **full-monitor backdrop overlay that swallows mouse-down** (`stop_propagation`); clicks that miss your panel dismiss the picker instead of reaching the OS.

## Modifier-event pitfall (hold-to-switch)

`on_modifiers_changed` can be **silently dropped while your window is not yet `keyWindow`** (notably right after window reuse). For reliable alt/modifier-**release** detection, poll `CGEventSourceFlagsState(.combinedSessionState)` on a short timer as a ground-truth fallback — don't trust the event alone.

## Cross-platform contrast

Linux has no equivalent reliability problem: send an EWMH `_NET_ACTIVE_WINDOW` client message to the root window and the **window manager** performs the activation atomically. There is no userspace "activate" race because the WM owns focus policy. macOS has no public equivalent — hence SkyLight.

## Reproduce / verify a focus bug (method)

A focus bug is "sometimes" by nature. Make it deterministic:

1. Instrument the activation to log the CG-frontmost window (pid + window id) at three checkpoints: **BEFORE**, **AFTER-SYNC** (same tick), **AFTER-250ms** (background thread). Write to a **file sink**, not stderr, so logging survives whoever owns the process (the daemon is supervised by qol-tray).
2. Drive real switches, then **isolate clean reads**: discard any commit whose 250ms read overlaps the next commit (timestamp filter) — fast spamming pollutes deferred reads.
3. Classify each clean commit: `app_match=false` → Mode A; `app_match=true, win_match=false` → Mode B; capture `ax_found` and the activate return to refute alternative theories (e.g. an AX-timeout hypothesis dies the moment `ax_found=true` on every failure).
4. Verify the fix by the same probe: cross-app failure rate should drop to ~0, including against a known focus-fighter (screen-sharing Teams).

## See also

- `gpui-conventions` → "Eagerly stealing OS window focus" (focusing your *own* popup: `window.focus` + `window.activate_window`), "Blur fires immediately on PopUp windows".
- `plugin-alt-tab/CLAUDE.md` → ghost-popup placement, AX stall/cache/parallel, daemon-backed picker.
