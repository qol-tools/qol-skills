---
name: qol-tray-dev-logging
description: Use when adding diagnostic logs to qol-tray frontend (ui/) code. Enforces the createDebug namespace convention and message-style rules instead of raw console.log. Triggers when working on camera, nav, wedge, world, spatial, or app-level state in qol-tray.
---

# qol-tray Frontend Logging Convention

## The Rule

**Never use `console.log`, `console.error`, or `console.warn` for diagnostic logs in qol-tray's frontend.** Use the `createDebug(namespace)` utility from `ui/lib/debug.js`. The debug system already exists, has a uniform on/off toggle, and assigns a consistent color per namespace for visual scanning in the console.

Raw `console.*` calls:
- Can't be toggled off, spamming the console in production
- Don't get the colored namespace prefix, making them hard to find
- Break the scannable log-grepping the existing namespaces support
- Will be caught in review

## The Debug Utility

Lives at `ui/lib/debug.js`. Exports:

- `createDebug(namespace)` — returns a `log` function for that namespace. Callable as `log(...args)`.
- `setDebugEnabled(on)` — global toggle, persists to `localStorage['qol-debug']`.
- `isDebugEnabled()` — read the current state.
- `elLabel(el)` — formats a DOM element as `tag.class1.class2` for logging.
- `rectLabel(r)` — formats a rect as `(x,y wxh)`. Accepts both `DOMRect` (`left`/`top`) and registry-style `{x, y, width, height}` shapes. Returns `none` for null.
- `pointLabel(p)` — formats `{x, y}` as `(x,y)` with rounding. Returns `(?)` for null, so pass nullable targets directly instead of branching inline.

Additional helpers for specific cases:
- `surfaceLabel(el)` from `ui/lib/spatial-nav.js` — formats a focusable surface with more context.

Enabling logs at runtime:
- From the Developer tab → toggle "Debug logging"
- From the browser DevTools console: `localStorage.setItem('qol-debug', '1')` then reload
- Disable: `localStorage.removeItem('qol-debug')`

## Namespace Convention

Format: `qol:<area>` — short lowercase word describing the subsystem. One file = one namespace typically. Never invent ad-hoc namespaces; prefer extending an existing one.

Existing namespaces in qol-tray:

| Namespace | File | Scope |
|---|---|---|
| `qol:app` | `ui/components/App.js` | App-level dive/ascend, view transitions, pluginDive useEffect |
| `qol:camera` | `ui/lib/world-camera.js` | Camera pan/zoom/smooth animations |
| `qol:nav` | `ui/app/useAppKeyboardRouting.js` | Keyboard routing, arrow/Tab/Enter/Escape dispatch |
| `qol:spatial` | `ui/lib/spatial-nav.js`, `ui/lib/viewport-spatial.js` | Spatial navigation candidate scoring, slotAtCenter resolution |
| `qol:wedge` | `ui/lib/components/SelectionCursorOverlay.js` | Selection wedge visibility state transitions and focus tracking |
| `qol:world` | `ui/components/shell/WorldViewport.js`, `ui/components/shell/RegionLabels.js` | Camera follow on focusin, ctrl-snap, viewport bounds, region label rendering |

**Before adding a new namespace**, check if your log belongs in an existing one. Camera-related → `qol:camera`. Keyboard → `qol:nav`. Layout math → `qol:spatial` or `qol:world`. Only create a new namespace if the area is genuinely orthogonal.

**Sub-namespaces**: Use `log.extend('sub')` to derive a child namespace like `qol:app:dive`. Rarely needed; prefer flat.

## Message Style

Logs must be **single-line, scannable, low-noise**. Format is terse "key: value" or "event → target" style. Match the voice of existing logs so output is grep-friendly.

### Template

```js
log('event:', actor, '→', target, 'key1=value1', 'key2=value2', extras);
```

### Rules

- **Lowercase verbs**: `dive:`, `ascend:`, `arrow up`, `viewChange:`, `cam follow`, `focusin →`, `mutation → HIDE`, not `Diving...` or `DIVE!!!`.
- **Use `→` for transitions**: from-state `→` to-state. E.g., `mode: keyboard → mouse`, `dive: plugins-config → layer -1`.
- **`key=value` for inline state** (no spaces around `=`): `pri=227 cross=0 dist=680`, `z=1.00`, `stack=1`, `cam=(240,150)`. Multiple pairs separated by spaces.
- **Template literals over string concatenation**: write `` `cam=${pointLabel(target)}` `` not `'cam=(' + Math.round(target.x) + ',' + ... + ')'`. Inline `+` for key=value is a readability killer — one template literal per arg is the rule.
- **Helpers over inline formatting**: use `rectLabel`, `pointLabel`, `elLabel` when they fit. If you find yourself writing conditional rounding inline (`target ? Math.round(target.x) : '?'`), the helper handles that — pass the nullable value directly.
- **Extract complex branches to a local** before the log call. A conditional expression bigger than a ternary belongs in a `const` above the log. Keep the log call a flat list of pre-formatted args.
- **Parenthesized coordinates**: `(x,y)` with no space after comma. Wrap rects as `(x,y wxh)` via `rectLabel`, points as `(x,y)` via `pointLabel`.
- **Use `elLabel(el)` for DOM nodes**: `log('focusin →', elLabel(target))` not `log('focusin →', target.tagName, target.className)`.
- **Use `Math.round` for coordinates** unless sub-pixel precision matters. Prefer the helpers, which round for you.
- **Use `.toFixed(2)` for zoom/ratios**: `` `z=${zoom.toFixed(2)}` ``.
- **No emojis**, no multi-line dumps, no `JSON.stringify` of large objects. If you need to inspect a big object, grab it via a console breakpoint instead.
- **Reason, not symptom**: `dive: skipped (animating)` beats `dive called but returned early`. Say what the code decided and why.

### Anti-examples

```js
// raw console
console.log('diving to', targetId);

// ad-hoc namespace
const log = (msg) => console.log('[App/dive]', msg);

// verbose/multi-line
log(`
  Dive state:
    targetId: ${targetId}
    x: ${camTarget.x}
    y: ${camTarget.y}
`);

// noisy without structure
log('it worked!', 'now the camera is at', camTarget.x, 'comma', camTarget.y);

// passes raw objects that clutter the console
log('entry:', entry, 'viewport:', vp, 'stack:', diveStack);

// inline string concatenation — unreadable, conditional-inside-a-ternary-inside-a-concat
log('dive:', targetId, 'entry=(', entry.x, ',', entry.y, entry.width + 'x' + entry.height, ')',
    'vp=(' + w + 'x' + h + ')',
    'cam=(' + (camTarget ? Math.round(camTarget.x) : '?') + ',' + (camTarget ? Math.round(camTarget.y) : '?') + ')',
    'stack=' + diveStack.size);
// Fix: use helpers + template literals (see good example below)
```

### Good examples

```js
// Camera dive — helpers handle rounding + null, template literals handle key=value
log('dive:', targetId,
    `entry=${rectLabel(entry)}`,
    `vp=(${w}x${h})`,
    `z=${camera.zoom.toFixed(2)}`,
    '→ layer', entry.layer,
    `cam=${pointLabel(camTarget)}`,
    `stack=${diveStack.size}`);

// Complex conditional branch → extract to a local above the log
const panSource = resolved ? `via ${resolved.source}` : 'no pan';
log('forceAscend:',
    `wasAnimating=${wasAnimating}`,
    `prev=${prev ? 'yes' : 'none'}`,
    '→ layer 0',
    `parent=${parentTarget || 'null'}`,
    `cam=${pointLabel(resolved)}`,
    panSource);

// Transition: from → to
log('pluginDive: open', activePluginId, '→ dive plugins-config');

// Decision with reason
log('dive:', targetId, '→ skipped (animating)');

// Selection wedge state change
log('focusin → TARGET CHANGED:', previousLabel, '→', elLabel(target), '| rect:', rectLabel(target.getBoundingClientRect()));

// Spatial nav candidate (tight state)
log('  candidate', surfaceLabel(el),
    `pos=${pointLabel({ x: r.left, y: r.top })}`,
    `dx=${dx}`, `dy=${dy}`, `pri=${primary}`, `cross=${cross}`, `dist=${distance}`,
    isBest ? '<- best' : '');
```

## Setup Pattern in a New File

```js
import { createDebug, elLabel, rectLabel } from '../lib/debug.js';

const log = createDebug('qol:area');

function myFunction() {
    log('action:', param, '→', outcome);
}
```

Put the `const log` line at the top of the file just below the imports so it's easy to find and grep for.

## When to Add a Log

Add logs when the diagnostic value outweighs the noise:

- **State transitions** across module boundaries (camera layer change, dive/ascend, view change, focus change)
- **Early returns that could surprise** the caller ("skipped because X")
- **Decisions involving multiple inputs** where the chosen branch matters (candidate scoring, route selection)
- **Animation/timing boundaries** where a stuck state would otherwise be invisible (`layerAnimatingRef` toggles, promise resolution)

Don't log:
- **Successful tight loops** (every mouse move, every frame tick)
- **Obvious one-liners** — `log('ran the function')` is noise
- **Sensitive state** — user input contents, file paths unnecessary for debugging

## Adding Logs to Existing Code

When modifying a file that already has logs:
1. Keep the existing namespace — don't rename
2. Match the existing style verbatim (same punctuation, same `→` spacing, same key=value format)
3. Add logs at the same abstraction level as existing ones

When asked "add some camera logs": the user means **extend the existing logging path**, not create parallel logging via `console.log`. Find the existing `createDebug` call in the file and add `log(...)` calls next to existing ones. If there isn't one, add one with the appropriate namespace from the table above.

## Toggling at Runtime

User's typical flow:
1. Reproduce the bug with logs ENABLED: open DevTools console, run `localStorage.setItem('qol-debug', '1')`, reload the webview
2. Reproduce the action, copy the relevant `qol:*` lines from console
3. Disable after debugging: `localStorage.removeItem('qol-debug')` or toggle from the Developer tab

When pasting logs for debugging, the user will include the `qol:*` namespace prefix. That tells you which file the log came from (see the namespace table above) — grep for the exact string in that file to find the log call.

## Do Not

- Do not use `console.log`, `console.error`, `console.warn`, `console.debug`, or `console.info` for diagnostic output. If you need a one-time DevTools console breakpoint, set one manually; don't commit it.
- Do not invent new namespaces without checking the table. New namespace = document it here as well.
- Do not gate logs behind `if (DEBUG)` or custom flags. `createDebug` already handles the on/off logic.
- Do not leave `debugger;` statements, `TODO` logs, or commented-out console calls in committed code.
- Do not cram unrelated facts into one log line. One event per line.
- Do not log on every animation frame or every keystroke unless you're specifically debugging a perf issue.
