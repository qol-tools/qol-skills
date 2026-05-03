---
name: qol-tray-ui-systems
description: Use when adding or modifying UI components, modals, keyboard navigation, dropdowns, toggles, focus management, or selection wedge behavior in qol-tray. Use when touching any file under ui/views/, ui/components/, ui/lib/components/, ui/lib/hooks/, ui/app/, or ui/styles/.
---

# qol-tray UI Systems Reference

## Keyboard Navigation

Three layers, each a single source of truth:

### App Level (`useAppKeyboardRouting`)
Routes app-level keyboard flow. Priority: palette toggle > palette guard > plugin config > active view handler > global surface navigation.
- `Ctrl+E`: toggle command palette
- `Tab` / `Shift+Tab`: cycle top-level world views only when the camera is on layer 0 and nothing blocking is open
- Plugin config open: delegates to field navigation system
- Arrow keys / `Enter` / `Space` / `Escape` fall through to global surface navigation when the active view does not consume them
- Focus recovery: plugin-config close and view switches restore a selected surface

### List Level (`useListKeyboard`)
Shared hook for action keys in list-style views (hotkeys, shortcuts, task-runner, logs).
```javascript
useListKeyboard({ itemCount, selectedIndex, onAdd, onDelete, onEdit })
```
Standard bindings: `a` add, `Delete`/`Backspace` delete, `Enter` edit. Arrow movement comes from app-level surface navigation.

### Modal Level (`useModalKeyboard`)
Shared helper for editor forms used by hotkeys, shortcuts, and task-runner. Some render inside `ModalPreact`, some render inside world sub-pages.
```javascript
const { handleKey, fieldProps } = useModalKeyboard({ onSave })
```
- `Enter` or `Escape` inside a text input returns focus to the containing surface
- `Ctrl+Enter`: save from anywhere
- Clicking an empty field surface activates the first control, toggle, or select trigger
- When rendered inside `.edit-modal`, `useLayoutEffect` reclaims focus on the selected surface

**Tab is not default field navigation.** On layer 0 it cycles top-level views; blocking editors must opt into any custom Tab behavior explicitly.

## Selection Wedge System

### Data Attributes
Every navigable element uses these attributes:
- `data-selected-surface=""` — marks element as a selection target
- `data-selected="true"/"false"` — current selection state
- `data-selected-surface-priority="N"` — higher wins when multiple surfaces are selected (CustomSelect options use 10)
- `data-selected-surface-motion="teleport"` — skip glide animation

### Surface Resolution (`ui/lib/selected-surface.js`)
`findActiveSelectedSurface()` resolves the active target:
1. Focused surface (`:focus-within`) wins
2. Highest-priority `data-selected="true"` surface
3. Fallback to currentTarget

### Input Mode Tracking (`ui/lib/components/SelectionCursorOverlay.js`)
- `data-input-mode="keyboard"` on `.app-container`: wedge visible
- `data-input-mode="mouse"`: wedge hidden (CSS `opacity: 0`)
- Switches on `keydown` (keyboard) / `pointerdown` or `wheel` (mouse)

### Z-Index
- `--z-selection-wedge: 101`
- `--z-modal: 100`
- The wedge already sits above modal chrome by default

## Shared Components

### Modal (`ui/lib/components/ModalPreact.js`)
```javascript
<${Modal} open=${true} onClose=${onClose} className="edit-modal">
    <div class="edit-modal-content">...</div>
<//>
```
Auto-focuses first `[data-selected-surface][data-selected="true"]` on open, falls back to first focusable element.

### ModalActions
```javascript
<${ModalActions} onClose=${onClose} onSave=${onSave} disabled=${boolean} />
```
Renders Cancel (Esc) + Save (Ctrl+Enter) buttons. `disabled` greys out Save.

### CustomSelect (`ui/lib/components/CustomSelect.js`)
```javascript
<${CustomSelect} value=${string} options=${string[]} labels=${{ [value]: displayLabel }} onChange=${(value) => void} />
```
Keyboard-navigable dropdown with animated highlight marker. Opens on click/Enter, arrow keys navigate, Enter selects, Escape closes. After selection, `focusFieldLevel` returns focus to nearest `[data-plugin-config-field-id]` or `[data-selected-surface]` ancestor.

### ToggleSwitch (`ui/lib/components/ToggleSwitch.js`)
```javascript
<${ToggleSwitch} checked=${boolean} onChange=${(newValue) => void} label=${string} />
```
Renders `.toggle-track` + `.toggle-thumb` with `role="switch"`. Keyboard: Enter/Space toggles. onChange receives boolean, not event.

## Editor Field Pattern

Every field in an editor form is its own `[data-selected-surface]`:
```javascript
const { fieldProps, handleKey } = useModalKeyboard({ onSave });

// Each field is an independent surface
<div class="form-group" ...${fieldProps(0)}>
    <label>Name</label>
    <input type="text" ... />
</div>
<div class="form-group" ...${fieldProps(1)}>
    <label>Type</label>
    <${CustomSelect} ... />
</div>
<div class="form-group" ...${fieldProps(2)}>
    <${ToggleSwitch} ... />
</div>
```

`fieldProps(index)` returns: `{ tabIndex: -1, data-selected-surface, data-selected, onFocus, onClick }`

### Rules
- ONE interactive control per surface. Never put a select + input in the same surface.
- If a toggle reveals child fields, each child is its own surface. Wrap children in `.form-group-children` for visual grouping (indented with left border).
- `tabIndex: -1` on surfaces — navigation is managed by the hook, not browser tab order.
- No native `<select>` elements. Always use CustomSelect.
- No `<input type="checkbox">`. Always use ToggleSwitch.

## Focus Invariants

**These are non-negotiable. Violating any of these is a bug.**

1. Focus must NEVER land on `document.body` while a modal or view is active.
2. When disabling/removing the focused element, redirect focus FIRST.
3. After closing a modal/config: the underlying view's selected surface gets focus via `useLayoutEffect`.
4. After a toggle click that re-renders: `useLayoutEffect` reclaims focus on the selected surface.
5. After CustomSelect closes: `focusFieldLevel` returns focus to the surface ancestor.
6. Do not paper over focus bugs with `setTimeout`. Prefer `useLayoutEffect`; app-level camera/view handoffs are the rare centralized exception.
7. Disconnected DOM targets must NOT consume keyboard events — fall through to the next handler.

## CSS Token System

### Backgrounds
`--bg-base`, `--bg-elevated`, `--bg-surface`, `--bg-hover`, `--bg-selected`

### Text
`--text-primary`, `--text-secondary`, `--text-muted`, `--text-faint`, `--text-disabled`

### Borders
`--border-subtle`, `--border-default`, `--border-hover`

### Z-Index Stack
```
--z-base: 0 → --z-selected: 10 → --z-row-active: 12 → --z-control: 20 → --z-popover: 30 → --z-menu: 35 → --z-menu-trigger: 36 → --z-modal: 100 → --z-selection-wedge: 101
```

### Selected Surface Border
Global rule: `[data-selected-surface][data-selected="true"] { border-color: var(--accent); }`

### Form Group in Modals
`.form-group[data-selected-surface]` gets padding + transparent border + border-radius for spacing between border and content.

### Channel Variables
For dynamic alpha: `rgba(var(--accent-rgb), 0.2)`. Available: `--accent-rgb`, `--success-rgb`, `--danger-rgb`, `--warning-rgb`, `--ink-rgb`.

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Using native `<select>` | Always use `CustomSelect` — native selects can't be opened programmatically and don't integrate with keyboard nav |
| Using `<input type="checkbox">` | Always use `ToggleSwitch` — consistent visual language, `role="switch"`, keyboard accessible |
| Putting multiple controls in one surface | Each control gets its own `[data-selected-surface]`. A toggle + revealed select + input = 3 surfaces |
| Using `setTimeout` as a focus fix | Prefer `useLayoutEffect`; app-level camera/view handoffs are the centralized exception |
| Expecting `useModalKeyboard` to move selection with arrow keys | Arrow navigation lives in app-level surface routing; `useModalKeyboard` supplies field props plus editor-local key handling |
| Using `tabindex="0"` on editor fields | Use `tabIndex: -1` (via `fieldProps`) — navigation is managed, not tab-order |
| Passing `editingId` when computing remaining actions after save | Only pass `editingId` when editing an existing entry, not when checking what's left after adding |
| Swallowing events from disconnected DOM nodes | `if (!target.isConnected) return false` — let events fall through to the next handler |
| Forgetting to update `hotkeysRef.current` eagerly after `setHotkeys` | `useStateRef` ref only updates on render; sync it manually: `d.hotkeysRef.current = nextHotkeys` |
| Using Tab as implicit field navigation | Root-layer `Tab` cycles top-level views; any editor-specific Tab behavior must be implemented explicitly |
| Branching on event.shiftKey inside a view to invoke an alternate action | Declare it as `onSecondaryActivate` (or `actions[1]`) on the surface. The router synthesizes the modifier-aware click; views stay declarative. |
| Reaching into the keyboard router to add a new modifier path | Add it to the modifier→slot table or to the `surface-actions.js` registry. Don't fork `useAppKeyboardRouting`. |
| Adding a `data-dive-target` row but expecting clicks to dive without using `Surface` | Click→dive is wired in `Surface.handleSurfaceClick`. Raw `<div data-dive-target>` doesn't dive on click. Always use a Surface descendant. |
| Calling `window.confirm()` for a destructive action | Use `<${ConfirmButton} confirmWith="...">`. Native dialogs are blocking and don't match our visual language. |
| Rendering an ad-hoc Shift-overlay div on a new surface | Set `data-secondary-label` and pass `onSecondaryActivate` (or `actions[1]`). Global CSS draws the overlay. |
| Using a `<pre>` with `tabIndex=0` for a scrollable JSON/log dump | Use `CodeBlock` (or follow its `data-scroll-surface-active` pattern). Plain `tabIndex=0` won't be reachable via arrow nav. |
| Letting modifier-Enter dive a row that has a secondary action | Already handled by `Surface`: Shift/Ctrl/Meta + Enter runs the secondary action and suppresses dive. Don't reimplement. |
| Forgetting to call `restoreDiveSourceFocus` when adding a new ascend path | The existing camera-layer ascend path already does this. Don't add a parallel ascend mechanism — extend the existing one. |

## Surface Trait Architecture

All interactive elements in qol-tray derive from the `Surface` primordial. **Never write raw `data-selected-surface=""`** — use `Surface` or a hook.

**Traits are hooks, shapes are components:**

```js
// Trait: useSurface — returns { attrs } for any navigable element
import { useSurface, useInputSurface, Surface } from '../lib/components/Surface.js';

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

**Reusable hooks** (in `ui/lib/hooks/`):
- `useListSelection()` — manages selectedIndex + deselect, returns `{ index, select, deselect, selected }`
- `useClickOutside(ref, active, callback)` — dismiss on outside pointer
- `useScrollFollow(containerRef, active, index, selector)` — scroll item into view

**Adding behaviors:** Each behavior is a hook. A component declares what it IS by calling the hooks it needs — no wrapper nesting, no middleware chains.

## Surface Action Contract (modifier-table actions)

Every Surface accepts a single primary action plus optional modifier-keyed alternates. The contract lives entirely in `Surface` and one helper module — no per-view keyboard branching, no per-row click handlers.

### Two equivalent shapes

```js
// Lightweight: primary + optional secondary
<${Surface} as="button"
    onActivate=${primary}
    onSecondaryActivate=${secondary}
    data-secondary-label="Open in editor"
>Edit<//>

// Composable: a list of named action descriptors (preferred for 3+ slots)
<${Surface} as="button" actions=${[
    diveAction('profile-backup-detail', dive),       // slot 0 — Enter / Click
    openExternalAction(() => openBackup(name)),      // slot 1 — Shift+Enter / Shift+Click
    revealInFolderAction(() => openBackupsDir()),    // slot 2 — Ctrl+Enter / Ctrl+Click
    copyPathAction(name),                            // slot 3 — Ctrl+Shift+Enter
]}>Edit<//>
```

The router's modifier→slot table:

| Modifier | Slot |
|---|---|
| (none) | 0 — primary |
| Shift | 1 — secondary |
| Ctrl / Meta | 2 — tertiary |
| Ctrl+Shift | 3 — quaternary |

### Strategy registry — `ui/lib/surface-actions.js`

Action factories return `{ kind, label, run }`:
- `diveAction(target, dive)` — primary slot for divable rows.
- `openExternalAction(invoke, { label })` — opens via OS handler (xdg-open / open / explorer).
- `revealInFolderAction(invoke, { label })` — same but for the parent dir.
- `copyTextAction(text, { label, message })`, `copyPathAction(path)` — clipboard helpers with toast.
- `customAction(run, { label, kind })` — escape hatch.
- `pickAction(actions, event)`, `modifierIndex(event)` — used internally by Surface; rarely needed at call sites.

Add new action kinds here, not in surfaces. Each surface stays declarative.

### Mouse parity

Surface `onClick` now also dives when `data-dive-target` is set on the element AND the primary slot ran (no modifier held). This is centralized via the `diveFromSurface` singleton in `ui/lib/world-navigation-singleton.js`, wired by `App.js`.

**Consequence:** the keyboard router no longer dives. `routeToView` had a "data-dive-target priority" shortcut that has been removed; `activateAndMaybeDescend` only fires `dispatchModifierClick(el, keyEvent)` plus optional descend. The single source of truth for click→dive is `Surface.handleSurfaceClick`. Mouse and keyboard go through the same path.

**Modifier semantics on dives:** Plain Enter/Click on a divable surface → primary + dive. Shift+Enter/Click → secondary, dive suppressed. Ctrl+/Meta+ → tertiary, dive suppressed. The "no dive when modifier" rule is in Surface, not router.

### Shift-held overlay (global, CSS-only)

`useShiftHeld()` (mounted once at AppShell root) toggles `body[data-shift-held]` while Shift is held. The CSS rule in `common-controls.css`:

```css
body[data-shift-held] [data-selected-surface][data-secondary-label][data-selected="true"]::after,
body[data-shift-held] [data-selected-surface][data-secondary-label]:focus::after {
    content: attr(data-secondary-label);
    position: absolute; inset: 0;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0, 0, 0, 0.6); backdrop-filter: blur(2px);
    border-radius: inherit;
    color: var(--accent); font-size: var(--fs-lg); font-weight: var(--fw-semibold);
    text-transform: uppercase; letter-spacing: 0.08em;
    z-index: var(--z-control); pointer-events: none;
}
```

Any surface with `data-secondary-label` gets the overlay automatically — no per-component div. The dual `[data-selected="true"], :focus` selector covers both controller-managed surfaces (Profile, Hotkeys, Shortcuts) and standalone focus-driven ones (CodeBlock).

The legacy `<div class="plugin-shift-overlay">Menu</div>` on the Plugins page is now redundant — its CSS still matches but new surfaces don't render their own overlay element.

### Ascend focus restoration (`data-dive-source`)

When `Surface.maybeDive` fires, it sets `data-dive-source=""` on the originating element. On Esc-ascend:
- The non-camera ascend path (parent-container) finds the source and refocuses it.
- The camera ascend path (escaping a dive subpage) was missing this — fixed via `restoreDiveSourceFocus()` after `_ascendRef.current()` in `useAppKeyboardRouting::ascendLayer`.

Result: Esc-from-dive on any divable surface returns focus to the originating row. No per-view wiring.

## Scroll-Mode Opt-Out (`data-scroll-surface-active`)

Surfaces that need native arrow-key / PgUp / PgDn scrolling within their bounds set `data-scroll-surface-active=""` while in scroll mode. `globalSurfaceNav` early-returns when the focused element has this attribute, letting the browser scroll the focused element natively.

Pattern in `CodeBlock.js`:
1. Initial state: surface registered, focused via arrow nav.
2. Enter (or click) → set `scrollMode=true` → emit `data-scroll-surface-active`.
3. Browser handles arrows / PgUp / PgDn / Home / End natively (scrolls the `<pre>`).
4. Esc → globalSurfaceNav dispatches `exit-scroll-mode` CustomEvent → CodeBlock clears state → returns to arrow-nav.

Reusable for any future scrollable surface (logs viewer, JSON dumps, large config previews).

## ConfirmButton trait (`ui/lib/components/ConfirmButton.js`)

For destructive actions. Drop-in replacement for `Button`. Morphs into an inline input that requires the user to type a contextual keyword. Replaces ad-hoc `window.confirm()`.

```js
<${ConfirmButton} confirmWith="restore" onActivate=${restore}>
    Restore this backup
<//>
```

- Click / Enter on the button → morphs to `<input>` placeholder `Type "<word>" + Enter`, auto-focused.
- Type the word + Enter → `onActivate` fires.
- Wrong word + Enter → red shake animation, danger ring; stays open for retry.
- Esc / blur → reverts to button, `onCancel` if provided.
- Case-insensitive, whitespace-trimmed.

`confirmWith` defaults to `"confirm"`. Use a contextual word (`"restore"`, `"delete"`, `"reset"`, `"disconnect"`) when it adds clarity.

**Use this for any destructive action** instead of native confirm dialogs or single-click destructive buttons.

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

### HA-style status gating

`PluginConfigContext` (`ui/views/plugin-config/context.js`) tracks `statusTones` reported by `StatusField` (driven by polled queries). `isRuntimeDisabled = some tone === 'danger'` gates runtime-dependent fields (`action`, `color+stream`, `list`). Recovery actions (reload, pair) are exempt — they're how the user fixes the broken state.

Fields read `ctx.isRuntimeDisabled`. `StatusField` reports tone via `ctx.reportStatusTone(fieldId, tone)`.

## View keyboard fallback (`ui/lib/view-keyboard-fallback.js`)

During a dive into an editor sub-page (`hotkeys-editor`, `shortcuts-editor`, `task-runner-editor`), `activeViewId` stays on the parent view because dive doesn't switch top-level views — only the navigation anchor moves.

`resolveViewKeyboard(viewId, getViewKeyboard, anchorPageId)` resolution order:
1. Anchor pageId direct lookup (if anchor differs from viewId).
2. Anchor's editor parent (strip `-editor` suffix).
3. viewId direct lookup.
4. viewId's editor parent.

**Intentionally narrow:** only `*-editor` sub-pages get the fallback. The seven other dive sub-pages (`logs-detail`, `profile-backup-detail`, `dev-log-filters`, `dev-plugin-actions`, `plugins-uninstall-confirm`, `plugins-actions`, `task-runner-test-runner`) do NOT register their own keyboard handler — they rely on `activeViewId` staying at the parent during dive, so the direct lookup of `activeViewId` already resolves to the parent's handler.

If a non-editor sub-page ever needs its own keyboard handler with parent fallback, register it directly under its own viewId (don't widen `editorParentViewId`).

## Modal key dispatch (`ui/lib/hooks/modal-key-action.js`)

`resolveModalKeyAction({ key, ctrlKey, isEditing, hasOnClose })` returns one of:
- `noop` — don't preventDefault.
- `blur-edit` — return focus from input to its surface (Esc/Enter while editing).
- `blur-edit-and-save` — Ctrl+Enter while editing.
- `save` — Ctrl+Enter on a surface.
- `close` — Escape on a surface (only when `hasOnClose`).

**Esc-on-surface MUST resolve to `close` when `onClose` is provided.** If it resolves to `noop`, `globalSurfaceNav.ascendLayer()` runs the dive ascend without ever clearing the parent view's `editModal`, the parent's `isBlocking()` stays true, and root-layer Tab cycling silently breaks. Locked by `modal-key-action.test.js::regression: esc on dive-editor form-group surface closes (not noop)`.

## Focus retention (`ui/lib/focus-retention.js`)

`createFocusRetention(doc)` watches for `focusout` + DOM mutations that leave `document.activeElement === document.body`. Attempts recovery via `pickFallbackSurface({ lostContainer, lostSlot, viewport })` in this order:

1. Selected surface in lost container, then first surface in container.
2. Selected surface in lost slot, then first surface in slot.
3. **Anchored** slot surface in viewport — slot whose rect actually intersects the viewport (selected first, then first).
4. First surface in viewport whose rect intersects the viewport.

**Off-screen world-slot rule:** world slots live at distant world coordinates inside `#viewport` (CSS-transformed). After ascend, the lost editor slot is empty; we must NOT fall back to a surface in another world slot that happens to be off-screen, or the camera will chase it. `pickAnchoredSlotSurface` only considers slots whose rect intersects the viewport rect — i.e. the slot the camera is currently showing.

Locked by regression test in `focus-retention.test.js`: `pickFallbackSurface ignores off-screen world-slots in viewport fallback`.

## Viewport DOM resolution (`ui/lib/viewport-resolve.js`)

`resolveViewport(viewportRef, doc)` recovers when the cached `#viewport` ref is stale. During dive transitions the `#viewport` element can be replaced; the shared ref in App.js then points at a detached node (`clientWidth === 0`, `isConnected === false`), which collapses every viewport-derived calculation (minimap rect, camera follow, focus tracking) to zero until the next ref write.

Two-step:
1. Trust cache when connected and `clientWidth > 0`.
2. Otherwise re-query DOM by id and **overwrite the cache** so other consumers (`camera.getViewportSize`, `navigation.domHelpers`) recover too.

Pure helper — callers pass any object with a mutable `current` property and the doc. Use this anywhere viewport dimensions are read after a transition.

## Plugin context menu (`ui/lib/plugin-context-menu-items.js`)

Single `ITEMS` array drives both visibility and dispatch. Order is the on-screen order: `update`, `config`, `delete`. Visibility:
- `update`: requires `plugin.update_available`.
- `config`: requires `plugin.has_config`.
- `delete`: always shown.

Each item carries `handler(ctx, pluginId)`. `dispatchPluginContextAction(actionId, pluginId, ctx)` looks the item up by id and runs its handler. Adding a new item = one row in the array. No new dispatcher branches.

`bindPluginContextMenuItems(plugin, ctx)` returns the visible items with bound `run` closures — for the `plugin-actions` subpage that doesn't know action ids.

## Selection cursor pointermove gate

`SelectionCursorOverlay` (`ui/lib/components/SelectionCursorOverlay.js`) ignores `pointermove` while `camera.animating` is true. Camera-driven layout shifts retarget the cursor's hit-test under a stationary pointer; the browser fires a synthetic `pointermove` that flips mode to `mouse`, then `syncFromCamera` reverts to `keyboard` on the next tick — hundreds of flip-flops per pan animation peg CPU and trigger Firefox's slow-script warning. Real user input doesn't happen mid-animation in any meaningful way.

CTRL-held preview: wedge centres in viewport, highlights the nearest surface via `nearestSurfaceToCenter` and `data-selection-cursor-active="true"`. Wedge hue/depth: `--wedge-hue: 50 + (depth-1)*45`, capped at 275. Badge text colour switches to black when the HSL luminance > 0.18.

## DiveEditorSubPage shell (`ui/lib/components/DiveEditorSubPage.js`)

Shared shell for editor sub-pages reached by dive (`hotkeys-editor`, `shortcuts-editor`, `task-runner-editor`). Subscribes to a `createSharedSlot`, registers a view-keyboard binding under the sub-page id, and wraps the form body in the canonical five-deep page chrome.

Props:
- `slot` — `createSharedSlot` whose value is `{ modal, handleKey, isBlocking, ... }`.
- `viewId` — keyboard registration id (e.g. `hotkeys-editor`).
- `fallbackTitle`, `fallbackSubtitle` — shown when `slot.modal` is null.
- `renderHeader(value)` — returns the PageHeader for the active editor.
- `children(value)` — form body (typically wrapping `.edit-modal-content`).

Sets `activeModalContainer` for `useModalKeyboard` while the modal is open. The parent view's `useDiveEditor` hook (`ui/lib/hooks/useDiveEditor.js`) pushes its `{ modal, handleKey, isBlocking, ... }` payload into the slot whenever the editor state changes.

## Hotkey recorder (`ui/views/hotkeys/recorder.js`)

`applyRecordingKey(modal, event)` is pure — node:test friendly. Canonical shortcut format matches `profile/core/hotkeys.json`: modifier order `Ctrl → Alt → Shift → Super → key`, joined with `+`.

- Escape cancels recording without overwriting the previously captured key.
- Lone modifier press shows the partial chord (`Alt`, `Ctrl+Shift`) but stays in recording mode and does not advance.
- Pressing a recordable key + any modifier mask commits and advances to the next field.
- Special keys browsers steal (Tab, F-keys, arrows, Backspace) are recordable.

**macOS dead-keys:** Option+letter on a US layout produces a composed character in `event.key` (Alt+Q → Œ, Alt+E → é). `getKeyName(event.code)` derives the terminal key from the physical code (`KeyQ`, `KeyE`), so the saved shortcut is `Alt+Shift+Q`, not `Alt+Shift+Œ`. Tests in `recorder.test.js` lock this contract.

`useRecorder` hook (`ui/views/hotkeys/useRecorder.js`) wraps the pure helper as the single source of truth for `isRecording`/`key` state — the modal in `use-hotkeys.js` no longer needs a `recording` field.
