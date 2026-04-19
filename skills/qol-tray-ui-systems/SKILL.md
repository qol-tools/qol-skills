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
