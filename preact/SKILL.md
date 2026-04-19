---
name: preact
description: Use when writing Preact UI code in qol-tray. Covers htm tagged templates, hooks patterns, icon components, toast system, dissolve animations, keyboard focus trapping, and common gotchas.
---

# Preact Patterns (qol-tray)

Preact + htm (tagged template literals), no JSX, no build step.

## HARD RULE: Keyboard-First

Every interactive component MUST be fully operable via keyboard BEFORE adding mouse/click handlers. This is non-negotiable.

- Every list/grid: arrow key navigation with visible selected state
- Every tab bar: Left/Right arrows to switch tabs
- Every action: Enter/Space to activate
- Every dialog/panel: Escape to dismiss, Tab to cycle focusables
- Every view: receives focus when navigated to
- ARIA roles on all interactive elements (`role="tablist"`, `role="tab"`, `role="list"`, `role="listitem"`)
- `tabIndex="0"` on containers that handle keyboard events
- `data-selected` attribute on selected items for scroll-into-view

If a PR adds a new view or component without keyboard navigation, it is incomplete.

## Imports

```js
import { html } from '../lib/html.js';
import { useState, useEffect, useCallback, useRef, useMemo } from 'preact/hooks';
```

htm uses `html` tagged templates, not JSX:
```js
return html`<div class="foo" onClick=${handler}>${children}</div>`;
```

## htm Gotchas

- **Fragments**: multiple root elements return an array, not a Fragment. Keys on direct children of fragments work for reconciliation.
- **Boolean attributes**: use `tabIndex="0"` not `tabindex="0"`. Preact uses camelCase DOM properties.
- **Events**: `onClick`, `onKeyDown`, `onBlur`, `onFocus`, `onWheel`, `onMouseEnter` — camelCase.
- **`ref`**: works on elements and components, set during commit phase (available in useEffect/useLayoutEffect, NOT during render).
- **`key`**: works on any element, not just mapped lists. Changing key forces unmount+remount.
- **`dangerouslySetInnerHTML`**: `dangerouslySetInnerHTML=${{ __html: str }}` — avoid when possible.
- **Component unmount/remount**: changing the wrapper component type (e.g., conditional provider) causes the ENTIRE subtree to unmount and remount. All refs, effects, and state reset.

## Icon Components

**NEVER inline SVG markup in component files.** SVG paths are opaque noise that drowns out the declarative intent of the component. Always extract SVGs into dedicated icon component files.

Store icons as individual Preact component files in `ui/assets/`:

```
ui/assets/
  icon-copy.js
  icon-close.js
  icon-settings.js
  icon-cog.js
```

Each file exports one component:
```js
import { html } from '../lib/html.js';

export function IconCopy({ size = 13 }) {
    return html`
        <svg viewBox="0 0 16 16" width=${size} height=${size} fill="currentColor">
            <path d="..."/>
        </svg>
    `;
}
```

**Why not `.svg` files?** `<img src="icon.svg">` does not inherit `currentColor` from CSS. Inline SVG via Preact components does.

**Why not a single `icons.js`?** Individual files are discoverable, tree-shakeable, and avoid a growing monolith.

**Why not inline in the component?** SVG markup is long, cryptic, and not declarative. `<${IconCog} size=${14} />` communicates intent; a raw `<svg viewBox="0 0 16 16"><path d="M7 1h2l.3..."/>` does not. Components read better when icons are named imports.

Usage:
```js
import { IconCopy } from '../assets/icon-copy.js';
// ...
html`<button><${IconCopy} size=${16} /></button>`
```

## Global Toast System

Single unified mechanism for all user-facing messages (errors, success, info).

**Dispatch from anywhere:**
```js
import { toast } from '../lib/toast.js';

toast('error', 'Failed to save config');
toast('success', 'Plugin updated');
toast('info', 'No configuration available');
```

**How it works:**
- `toast()` dispatches a `CustomEvent('app-toast')` on `window`
- `GlobalToast` component (mounted once in App.js) listens and renders toasts
- Auto-dismiss: 6s for errors, 4s for others
- Hover pauses timer, shows copy + close buttons
- Stacked in top-right corner, fixed width

**HTTP errors are automatic** — the global fetch interceptor in `api/client.js` calls `toast('error', ...)` for any non-OK response.

**Do NOT use per-view feedback state** (`useFeedback`, `setFeedback` prop drilling). Use `toast()` directly.

## Dissolve Animation

`dissolveIn(element, opts)` from `lib/dissolve.js` creates a canvas overlay that dissolves away, revealing content underneath.

**Trigger from callbacks (before state change):**
```js
const onSelect = useCallback((option) => {
    dissolveIn(contentRef.current, DISSOLVE_OPTS);
    updateState(option);
}, []);
```

**Trigger across unmount/remount (module-level state):**
```js
let prevMode = null;

export function MyComponent({ mode }) {
    const ref = useRef(null);
    useEffect(() => {
        if (prevMode !== null && prevMode !== mode && ref.current) {
            dissolveIn(ref.current, DISSOLVE_OPTS);
        }
        prevMode = mode;
    });
}
```

**Requirements:**
- Container needs `position: relative` for the canvas to anchor correctly
- Parent `overflow: auto/hidden` clips the canvas — use `bleed: 0` for constrained containers
- `dissolveIn` appends a child canvas — if a MutationObserver is on the same element, filter out `.dissolve-canvas` nodes to avoid infinite loops

## Keyboard Focus Trapping

Pattern for trapping Tab within a panel (only Escape exits):

```js
const FOCUSABLE = 'input, select, button, [tabindex="0"]';

function handleKey(e) {
    if (e.key === 'Tab') {
        e.preventDefault();
        if (detailRef.current?.contains(document.activeElement)) {
            cycleFieldFocus(detailRef, e.shiftKey);
            return;
        }
        navigateSidebar(e.shiftKey ? -1 : 1);
    }
}

function cycleFieldFocus(detailRef, reverse) {
    const focusables = Array.from(detailRef.current?.querySelectorAll(FOCUSABLE) || []);
    if (focusables.length === 0) return;
    const idx = focusables.indexOf(document.activeElement);
    if (idx < 0) {
        focusables[reverse ? focusables.length - 1 : 0].focus();
        return;
    }
    const next = reverse
        ? (idx - 1 + focusables.length) % focusables.length
        : (idx + 1) % focusables.length;
    focusables[next].focus();
}
```

**Key rules:**
- Use `detailRef.contains(activeElement)` for trap detection, not `isFocusable()` — catches everything including dropdown lists with `tabIndex="-1"`
- When `cycleFieldFocus` can't find activeElement in the list (idx < 0), jump to first/last instead of wrapping from -1
- Components that handle their own keys (e.g., number edit input) must let Tab propagate (`return` without `stopPropagation`) so the parent trap handles it
- Components that handle Escape must `stopPropagation()` to prevent the parent from also handling it

## Custom Input Patterns

### NumberField (display + inline edit)
- Display mode: `tabIndex="0"` div, arrow keys step value, wheel adjusts
- Type a digit/dot/minus to enter edit mode (first character captured via `editInitRef`)
- Enter opens edit with value selected
- `useEffect` focuses the input and applies initial character or selects all
- After exiting edit: focus returns to display div (only if `activeElement` is `body`)
- Tab from edit input must propagate to parent focus trap

### CustomSelect (keyboard dropdown)
- Trigger button handles click (toggle) and ArrowDown (open)
- Do NOT handle Enter/Space in `onTriggerKeyDown` — let the button's native click handle them (avoids Space keyup race condition)
- List gets focus on open (`tabIndex="-1"`)
- Tab on open list: close dropdown, focus trigger, let event propagate
- Escape on list: close, focus trigger, `stopPropagation()`
- `onBlur` on list closes if `relatedTarget` is outside container

### Toggle (boolean)
- `tabIndex`, `role="switch"`, `aria-checked`, and `onKeyDown` go on the ROW, not the track
- Focus ring covers the entire row, not just the small toggle pill

## Router Guards

Validate before setting state, not after:

```js
const openPluginConfig = useCallback(async (pluginId) => {
    if (!await validatePluginConfig(pluginId)) return false;
    setActivePluginId(pluginId);
    return true;
}, []);
```

Apply the guard at EVERY entry point:
- Click handlers
- URL hash restoration on page load
- Browser back/forward (hashchange)

Do NOT use auto-close (navigate back after mount) as a guard — it causes visual glitches and violates the principle that invalid state should never be entered.

## Context Provider Gotchas

Changing the component type inside a provider causes the entire subtree to unmount:

```js
// BAD — switches between ActiveProvider and bare Provider
function ConfigProvider({ pluginId, children }) {
    if (!pluginId) return html`<${Context.Provider} value=${null}>${children}<//>`;
    return html`<${ActiveProvider} pluginId=${pluginId}>${children}<//>`;
}
```

This unmounts and remounts ALL children (including sidebar, config view, etc.) when `pluginId` changes. Module-level state or refs survive, component state does not.

## Surface Trait Architecture

All interactive elements in qol-tray derive from the `Surface` primordial. **Never write raw `data-selected-surface=""`** — use `Surface` or a hook.

**Traits are hooks, shapes are components:**

```js
// Trait: useSurface — returns { attrs } for any navigable element
import { useSurface, useInputSurface, Surface } from '../components/Surface.js';

// Simple elements: use the Surface component
html`<${Surface} as="button" className="btn" onActivate=${handler}>Save<//>`

// Components needing DOM access: use useInputSurface (owns its ref)
function MyListPanel({ items, highlightIndex }) {
    const { ref, attrs } = useInputSurface();
    useScrollFollow(ref, true, highlightIndex, '.item');
    return html`<div ref=${ref} ...${attrs} class="my-panel">...</div>`;
}

// Specialized rows: compose ListRow (which composes Surface)
html`<${LogRow} time="14:32" level="error" src="plugin" msg="failed" onActivate=${openDetail} />`
```

**Component hierarchy:**
- `useSurface()` → primordial trait (navigable + activatable)
- `useInputSurface()` → useSurface + ref ownership (for components needing DOM access)
- `Surface` → component sugar for simple elements (buttons, toggle wrappers, depth diver)
- `ListRow` → Surface + accent border + header/body strips + optional action column
- `PluginRow`, `LogRow`, `SuppressedRow`, `BackupRow` → specialized rows composing ListRow
- `Expander` → Surface + expand/collapse
- `ViewTabs` tabs, `ModalFooter` buttons, `CommandPalette` items → all use Surface

**Ref ownership rule:** Components that need DOM access create refs internally via `useInputSurface()`. Refs never cross component boundaries — no ref forwarding. If a parent needs access to a child's DOM, the child should own that concern as a self-contained component.

**Reusable hooks:**
- `useListSelection()` — manages selectedIndex + deselect, returns `{ index, select, deselect, selected }`
- `useClickOutside(ref, active, callback)` — dismiss on outside pointer
- `useScrollFollow(containerRef, active, index, selector)` — scroll item into view

**Adding behaviors:** Each behavior is a hook. A component declares what it IS by calling the hooks it needs — no wrapper nesting, no middleware chains.

## Plugin Config Field Integration

Plugin config fields integrate with the wedge selection system via `data-plugin-config-field-id` and `data-plugin-config-index` attributes. Fields call `ctx.setSelectedFieldId(field.id)` on interaction.

**Never bypass the selection system.** Components creating DOM outside Preact's render tree cannot participate in wedge selection. Use native Preact components with Surface for all interactive elements.

**Pattern for shared config field components:**
```js
import { groupFields } from '../../auto-config/object-array-form.js';

function ObjectArrayField({ field }) {
    const ctx = usePluginConfigContext();
    const groups = groupFields(field.item?.fields);
    return html`...native Preact rendering with Surface integration...`;
}
```

## Persisting State Across Remounts

When a component unmounts/remounts (e.g., due to provider switching), use module-level variables to preserve state:

```js
let prevMode = null; // survives unmount

export function MyComponent({ mode }) {
    useEffect(() => {
        if (prevMode !== null && prevMode !== mode) doTransition();
        prevMode = mode;
    });
}
```

For per-key persistence (e.g., selected section per plugin), use `usePersistedIndex(storageKey, default)` which reads/writes localStorage.

## Verification In qol-tray

For `qol-tray` UI work:

```bash
node --check path/to/edited-file.js
```

This only checks JavaScript syntax. It does not prove the app is green.

When the UI change lives inside the `qol-tray` repo, also run the repo validation required by the `qol-tray` skill:

```bash
make build
make test
cargo build --features dev
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo build
cargo test
```
