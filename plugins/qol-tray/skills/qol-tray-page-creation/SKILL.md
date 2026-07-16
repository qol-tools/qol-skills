---
name: qol-tray-page-creation
description: Use when adding a qol-tray world-canvas page, dive target, sub-page, Component Gallery showcase, or reusable user-facing UI component that must be represented in the gallery. Trigger on gallery source-of-truth, gallery/production parity or drift, and requests to prevent plugin-local or stray UI implementations. Covers page registration, dive contracts, content sizing, and the 1:1 production/gallery test-bed rule.
---

# qol-tray Page Creation Reference

## Model recap

Pages are entries in the world registry at integer `layer` values:

- `layer: 0`: top-level views (the seven sidebar pages plus `dev`)
- `layer: -1`: sub-pages (editors, detail panels, plugin sections, gallery showcases)
- `layer: -2, -3, ...`: deeper dives (rare; reserved)

A **dive target** binds a `sourceSelector` (DOM matcher) to a `claim` rect and a list of `pages`. `diveInto(selector)` pushes a frame onto the dive stack, sets `currentConfinedPages` to `target.pages`, and lands the camera on `pages[0]` (or the remembered page).

Component-depth (dropdown open, edit-mode, modal, palette) is NOT a layer change. See `qol-tray-ui-systems` for component-depth handling.

## Build a page from scratch (walkthrough)

Follow these steps in order. Each step links to a recipe or section below
for the concrete code. The walkthrough is intentionally abstract: it
describes the decisions, not the code, so it stays stable as the
underlying primitives evolve.

1. **Classify the page.** Pick the row in the *Page type matrix* below
   that fits: top-level (a sidebar entry), single-page dive (one detail
   per host), multi-page dive (siblings to tab between), or plugin
   section (driven by a plugin contract). Type drives every later step.

2. **Sketch the shell.** Every page renders inside the standard shell
   (`view-container`, `PageHeader`, `SurfaceContainer`, `view-body`). See
   *SurfaceContainer is mandatory inside a page* below. Without the
   shell, keyboard nav silently breaks.

3. **Declare it in `WORLD_PAGES`.** Add an entry to `ui/app/views.js`.
   Set `contentSized: true` unless the page is fixed-frame. Top-level
   pages also go in `BASE_ORDER` and `view-labels.js`. Sub-page entries
   pull `contentSized` from their dive registration.

4. **Wire the entry into the world.** Top-level pages need nothing more.
   Anything deeper needs a `DiveTarget` registered in
   `registerStaticDiveTargets` (or `registerPluginDiveTarget` for plugin
   sections). Pick the recipe matching your type below.

5. **Pick an activation trigger.** How does the user dive in? Whole-view
   defaults to `[data-view-id="<parent>"]`; specific cards/rows use
   `data-dive-source="..."` on a `Surface`. See *Triggering a dive*. If
   the row has a one-shot detail view, set `data-dive-target` on the row
   and write the detail slot synchronously in `onActivate`.

6. **Decide if it is interactive.** A read-only page is done after
   step 5. A list-style page (rows, add/edit/delete) needs:
   - selection state (`useListSelection` or `usePersistedIndex`)
   - keyboard bindings declared in `VIEW_BINDING_DEFAULTS` and surfaced
     via `<KeyLegend>` in the `PageHeader` `aside` slot
   - a handler that respects the dive contract (do not pair
     `useListKeyboard` with rows that own `data-dive-target`, see the
     *Don't pair* section).

7. **Decide if it needs an editor sub-page.** If activation opens an
   editor (form), build a sub-page using `DiveEditorSubPage` with its
   own `viewId` prop (default to `<parent>-editor`). Drive the slot from
   a `useDiveEditor` call in the parent view; fill in `modal`,
   `fieldProps`, `handlers`, `handleKey`, `isBlocking`. Esc-close
   ascending is automatic (see *Ascend on editor close*).

8. **Add a gallery showcase** if the page or any new component is
   reusable. The gallery mirrors prod 1:1 with sandbox handlers, see
   *Gallery is a 1:1 prod test bed*. For an editor sub-page, scope its
   `viewId` so it doesn't overwrite prod's view-keyboard registration.

9. **Verify the four invariants.**
   - Dive lands the camera on the new page and the first surface is
     focused.
   - Esc ascends back and restores focus on the originating row
     (`data-dive-source`).
   - Tab cycles top-level views at layer 0 and cycles siblings inside a
     multi-page dive.
   - `<KeyLegend>` reflects every key the handler actually consumes.

10. **Commit atomically.** One logical change per commit. If you added
    bindings, the legend defaults and the handler change live in the
    same commit. If you added a gallery showcase, ship it with the
    production page.

## Page type matrix

| Type | Example | Layer | Pages per dive | Registration site |
|---|---|---|---|---|
| Top-level | `plugins`, `dev` | 0 | n/a | `BASE_ORDER` + `WORLD_PAGES` |
| Single-page dive | `dev-log-filters`, `logs-detail` | -1 | 1 | `registerStaticDiveTargets` |
| Multi-page dive | `dev-gallery-*` | -1 | N (stride-spaced) | bespoke loop in `registerStaticDiveTargets` (or async) |
| Plugin section | `<pluginId>-<sectionId>` | -1 | per plugin contract | `registerPluginDiveTarget` (async) |

## Recipe: top-level view

```js
// ui/app/views.js
const BASE_ORDER = [..., 'my-view'];
const WORLD_PAGES = [
    ...,
    { id: 'my-view', contentSized: true, render: () => html`<${MyView} />` },
];
```

- `contentSized: true` unless the page is fixed-frame (rare; default to true).
- Add a label entry in `view-labels.js` for the human-readable sidebar text.
- The camera-layer is 0; nothing else to wire.

## Recipe: single-page dive

```js
// ui/components/App.js, registerStaticDiveTargets
const staticTargets = [
    ...,
    { parentId: 'my-view', subId: 'my-view-detail', label: 'Detail',
      sourceSelector: '[data-dive-source="my-view-detail"]' },
];
```

```js
// ui/app/views.js, WORLD_PAGES
{ id: 'my-view-detail', render: () => html`<${MyDetailSubPage} />` },
```

- The static-target loop sets `contentSized: true` on the entry automatically.
- Default `sourceSelector` is `[data-view-id="${parentId}"]` (whole-view dive). Use a specific `data-dive-source="..."` when the dive is triggered from a card/row.
- Trigger: any `Surface` descendant with `data-dive-source="my-view-detail"` and `onActivate=${() => diveViaSelector('[data-dive-source="my-view-detail"]')}`.

## Recipe: multi-page dive (gallery, wizard, tabs-as-pages)

```js
// ui/components/App.js, at the end of registerStaticDiveTargets
const parent = registry.getEntry('my-view');
if (parent) {
    const N = MY_PAGE_KEYS.length;
    const inner = {
        x: parent.x,
        y: parent.y,
        width: (N - 1) * PLUGIN_PAGE_STRIDE + PLUGIN_PAGE_WIDTH,
        height: PLUGIN_PAGE_HEIGHT,
        layer: parent.layer - 1,
    };
    const claim = withPadding(inner, PLUGIN_PAGE_WIDTH, PLUGIN_PAGE_HEIGHT);
    const pages = MY_PAGE_KEYS.map((key, i) => {
        const id = `my-view-${key}`;
        registry.addEntry({
            id, x: inner.x + i * PLUGIN_PAGE_STRIDE, y: inner.y,
            width: PLUGIN_PAGE_WIDTH, height: PLUGIN_PAGE_HEIGHT,
            layer: inner.layer, label: key, contentSized: true,
        });
        return id;
    });
    registry.addDiveTarget({
        sourceSelector: '[data-dive-source="my-view-detail"]',
        claim, pages,
    });
}
```

```js
// ui/app/views.js, renderPageContent: handle dynamically
if (pageId.startsWith('my-view-')) {
    const key = pageId.slice('my-view-'.length);
    return html`<${MyShowcasePage} pageKey=${key} />`;
}
```

```js
// ui/app/views.js, renderWorldViews: render slots dynamically
${registry.getAllEntries()
    .filter(e => e.id.startsWith('my-view-'))
    .map(e => slotFor(e, renderPageContent(e.id, ctx)))}
```

- Stride MUST be `PLUGIN_PAGE_STRIDE` (10000). Drift breaks the minimap rect.
- Each page entry MUST set `contentSized: true`.
- The dive target points to ALL pages in `pages`; the user lands on `pages[0]` and tabs/minimaps between siblings.

## Sub-pages take slot+config as required props (no defaults)

Any sub-page that reads from a `createSharedSlot` or invokes side-effecting
actions takes those as REQUIRED props. Both prod (in `views.js`) and any
embedder (gallery, future test harness) inject them explicitly. Defaults hide
intent and make drift invisible.

```js
// page module
export const prodMyDetailConfig = { onClose, onCopy, onRestore, ... };

export function MyDetailSubPage({ slot, config }) {
    const [, bump] = useState(0);
    useEffect(() => slot.subscribe(() => bump(t => t + 1)), [slot]);
    const { entry } = slot.get();
    if (!entry) return placeholder;
    return html`<...><${MyDetailContent} text=${config.formatText(entry.content)}
        onClose=${config.onClose} onCopy=${() => config.onCopy(entry.content)} ... /></...>`;
}

// views.js
import { mySlot } from '...'; import { MyDetailSubPage, prodMyDetailConfig } from '...';
{ id: 'my-detail', render: () => html`<${MyDetailSubPage} slot=${mySlot} config=${prodMyDetailConfig} />` }

// gallery
<${MyDetailSubPage} slot=${galleryMySlot} config=${sandboxConfig} />
```

Pages without actions (e.g. `LogDetailSubPage`) take only `slot`.

## Editor sub-pages: viewId must be a prop, not hardcoded

Any editor sub-page that mounts `DiveEditorSubPage` internally MUST accept
`viewId` as a prop. The default matches prod; the gallery (or any future
embedder) passes a different one so the view-keyboard registration does NOT
collide with prod.

```js
export function HotkeyEditorSubPage({ slot, viewId = 'hotkeys-editor' }) {
    return html`<${DiveEditorSubPage} slot=${slot} viewId=${viewId} ... />`;
}

// gallery wrapper
return html`<${HotkeyEditorSubPage} slot=${gallerySlot}
    viewId="dev-gallery-hotkey-row-editor" />`;
```

Hardcoding `viewId="hotkeys-editor"` inside the editor means whichever copy
mounts last (often the gallery) overwrites the prod view-keyboard slot under
the shared id. Esc inside the prod editor then routes through a slot with
`handleKey: null`, `isBlocking: false`, and the modal stays open.

## Gallery editor controllers wire the full slot

When a gallery showcase mounts a prod editor sub-page, the controller hook
(`useGallery<X>EditorController`) MUST populate every field the prod view
would, especially `handleKey` and `isBlocking`. Otherwise Ctrl+Enter and
Escape behave inconsistently with prod.

Minimum slot value:

```js
const { fieldProps, handleKey: modalHandleKey } = useModalKeyboard({ onSave, onClose });
const handleKey = useCallback((e) => {
    if (recorder.handleKey(e)) return;
    modalHandleKey(e);
}, [recorder.handleKey, modalHandleKey]);

useDiveEditor({
    slot: galleryEditorSlot,
    deps: [modal, fieldProps, handleKey, recorder.isRecording],
    build: () => ({
        modal, plugins, recording: recorder.isRecording,
        fieldProps,
        handlers: { onPluginChange, onActionChange, onStartRecording, onClose, onSave },
        handleKey,
        isBlocking: () => !!modal,
    }),
});
```

If the editor records keystrokes (e.g., hotkey shortcut field), mount the
real `useRecorder` from the prod hook and put `recorder.handleKey` ahead of
`modalHandleKey` in the slot's handleKey chain. The gallery should never
diverge from prod input behavior; if it does, the gallery is failing its
regression-bed contract.

The longer-term fix is extracting a `useHotkeyEditor` (or `useShortcutEditor`)
driver from the prod view, so both prod and gallery call the same hook and
duplication goes away.

## Ascend on editor close is automatic via DiveEditorSubPage

`DiveEditorSubPage` watches the slot's `modal` value. When it transitions
from non-null to null (modal closed via Save, Cancel, or Esc), it calls
`ascend()`. View-side `onClose` wrappers (e.g., hotkey's `closeAndExit`)
that ALSO ascend are harmless: the second ascend no-ops on an empty stack.

A view that closes its modal without ascending (because the inner
`closeModal` only clears state) still returns the user to layer 0 thanks
to this generic effect. Don't reintroduce per-view ascend wrappers unless
you also need to fire post-close side effects (logging, focus restoration
beyond what `data-dive-source` already does).

## Key legend (contextual hotkeys per page)

List views show a `<KeyLegend>` strip next to the page subtitle so users
don't have to guess what `a`, `Enter`, `r` do. Bindings come from a single
defaults table (`ui/lib/view-bindings.js`) keyed by `viewId`, read via
`useViewBindings(viewId)`. The same source feeds the keyboard handler in
the future; for now defaults are baked.

```js
// in the view
const bindings = useViewBindings('shortcuts');
return html`
    <${PageHeader} subtitle="..." aside=${html`<${KeyLegend} bindings=${bindings} />`} />
    ...
`;
```

The legend renders via PageHeader's `aside` slot, so its vertical position
is anchored to the header (not the bottom of `.view-body`, which varies
with content height). Same screen y on every page.

When you add a key to a list view's handler, add the corresponding entry
to `VIEW_BINDING_DEFAULTS` in the same commit. Drift between the handler
and the legend lies to the user.

Drop ad-hoc "Press <kbd>a</kbd> to add one" empty-state hints once the
legend exists. The legend communicates the binding; the empty state should
state the fact ("No actions configured.") without repeating the key.

## Gallery is a 1:1 prod test bed

Component Gallery showcases MUST render the same component, in the same shell,
with the same props as production. Drift here is a bug. The gallery becomes
useless as a regression catcher.

Every new reusable user-facing component MUST ship with a Component Gallery
showcase in the same change. Production and the gallery import the same
component; a gallery-only copy or plugin-local reimplementation is forbidden.

When prod and gallery render the same detail/sub-page, extract a shared
presentational component (e.g. `LogDetailContent`, `BackupDetailContent`) into
`ui/components/domain-rows/<Row>.js` next to the row component. Both consumers
import it. Production wires real handlers; the gallery wires sandbox toasts.

**Gallery actions never touch real state.** Every callback in a gallery
showcase or sub-page must be a `toast('info', '<Action> (gallery sandbox)')`,
including ones that look harmless like Copy. The clipboard, the filesystem,
the daemon socket, plugin config files: all off-limits. The gallery is a
visual + navigation test bed, not a way to mutate the user's machine.

The shell (view-container + PageHeader + view-body content-shell-body +
content-shell-inner + SurfaceContainer.content-frame) lives in the consumer,
but MUST be identical between prod and gallery. If you find yourself writing
`<${SurfaceContainer} className="view-body">` in a gallery sub-page while prod
uses the deeper nesting, fix the drift.

## Recipe: row-activates-into-detail (no modals)

Modals clash with the world layer concept and are being removed. Rows that show
a "detail view" on activation MUST dive into a sub-page, not open a modal.

```js
// 1. The row component sets data-dive-target on the underlying Surface.
//    Any non-empty value works; the value is informational.
//    Example from LogRow:
<${ListRow} ... data-dive-target="logs-detail">...</>
```

```js
// 2. Register a DiveTarget on the host page's view-id selector.
//    The dive() helper resolves the target by walking up to the row's
//    [data-view-id] ancestor.
//    In registerStaticDiveTargets:
const hostPage = registry.getEntry('my-page');
if (hostPage) {
    const claim = {
        x: hostPage.x, y: hostPage.y,
        width: PLUGIN_PAGE_WIDTH, height: PLUGIN_PAGE_HEIGHT,
        layer: hostPage.layer - 1,
    };
    registry.addEntry({
        id: 'my-page-detail',
        x: claim.x, y: claim.y,
        width: PLUGIN_PAGE_WIDTH, height: PLUGIN_PAGE_HEIGHT,
        layer: claim.layer, label: 'Detail', contentSized: true,
    });
    registry.addDiveTarget({
        sourceSelector: '[data-view-id="my-page"]',
        claim, pages: ['my-page-detail'],
    });
}
```

```js
// 3. Pass row data via createSharedSlot. The row's onActivate writes
//    the slot; the detail sub-page subscribes and reads.
//    In my-detail-subpage.js:
export const myDetailSlot = createSharedSlot({ entry: null });

export function MyDetailSubPage() {
    const [, bump] = useState(0);
    useEffect(() => myDetailSlot.subscribe(() => bump(t => t + 1)), []);
    const { entry } = myDetailSlot.get();
    if (!entry) return html`<div class="view-container content-shell">
        <${PageHeader} title="Detail" subtitle="Activate a row to inspect" />
    </div>`;
    return html`<div class="view-container content-shell">
        <${PageHeader} title="Detail" />
        <${SurfaceContainer} className="view-body">
            <${MyDetailContent} entry=${entry} />
        <//>
    </div>`;
}
```

```js
// 4. Wire the row activation to write the slot.
//    In the showcase / parent page:
<${MyRow} key=${i} ...${entry}
    onActivate=${() => myDetailSlot.set({ entry })} />
```

The dive itself is automatic: `Surface.maybeDive` fires on activation (click or
keyboard), reads `data-dive-target`, walks up to `[data-view-id]`, and the
registered DiveTarget claims the dive. The user lands on `my-page-detail` (one
layer deeper than the host page). Esc ascends back, focus restores to the row.

**Don't use `Modal` for this.** A modal sits in screen-space, escapes the world
camera, and breaks Esc routing (since `ascendLayer` and the modal's onClose
contend). Use a sub-page even when the detail is small.

**Write the detail slot synchronously in `onActivate`.** `Surface.maybeDive`
fires the dive in the same click tick as `onActivate`, so if the slot is
populated via `useState` + `useEffect`, the camera lands on the sub-page
before the slot has data and the user sees the empty placeholder. Always:

```js
onActivate=${() => detailSlot.set({ entry })}
```

Never:

```js
onActivate=${(entry) => setEntry(entry)}    // BAD: queued, runs after dive
useEffect(() => detailSlot.set({ entry }), [entry]);
```

If gallery and prod render the same component but only the gallery's dive
shows data, this is the smell.

## Don't pair `useListKeyboard` with divable rows

`useListKeyboard` intercepts Enter, calls `e.preventDefault()`, and runs
`onEdit`. The preventDefault blocks `globalSurfaceNav`, so
`Surface.maybeDive` never fires and the row's `data-dive-target` becomes
inert.

`useListKeyboard` is for editor-style lists (hotkeys, shortcuts, task-runner)
where Enter opens an edit modal, NOT for lists where Enter dives into a
detail page. If a row has `data-dive-target`, let surface activation handle
Enter natively. Either drop the view-keyboard binding entirely (logs view
pattern after the fix), or only register one when the view truly needs
blocking semantics or modifier keys that surfaces can't express.

## Debugging recipe: "gallery dives but prod doesn't"

If the same row component dives correctly in the gallery but not in
production, walk this list before suspecting registration:

1. **Async slot writes.** Prod writing the slot via `useState` + `useEffect`
   while the gallery writes synchronously in `onActivate`. The dive resolves
   before the slot is populated. Fix: write the slot directly in the handler.
2. **Extra view-keyboard binding.** A `useListKeyboard` (or similar) on the
   prod view eats Enter with preventDefault. Drop it (see above).
3. **Different `[data-view-id]` ancestry.** `dive()` walks up to
   `[data-view-id]` to resolve the DiveTarget. If the prod row is wrapped in
   an extra layer that strips the surrounding view-id, lookup fails. The
   gallery's flat slot structure usually avoids this.
4. **Modifier-Enter in the gallery.** Don't suspect a real bug if you tested
   gallery with Shift/Ctrl+Enter (those run secondary actions, suppress dive).

## Triggering a dive

Three idiomatic forms:

| Trigger | When |
|---|---|
| `data-view-id="parent"` (default selector) | Whole top-level view dives into a single sub-page. |
| `data-dive-source="..."` on a `Surface` | A specific card/row/button dives. |
| `diveViaSelector(selector)` from JS | Programmatic dive (e.g., from a command palette entry). |

`Surface` handles click→dive automatically when the element has `data-dive-target` (NOT `data-dive-source`). If you want both: set `data-dive-target` for click parity AND wire `data-dive-source` for selector lookup. Refer to `qol-tray-ui-systems` § Surface Action Contract for modifier semantics.

## Tab / Shift+Tab paging within a dive

`useAppKeyboardRouting::cycleSubPages` reads `navigation.getConfinedPages()` and gates on `stackDepth > 0`. Any multi-page dive gets paging for free.

To verify paging works on a new dive: dive into it, press Tab, watch the camera move to `pages[1]`.

## Sub-page keyboard handler

By default the parent view's keyboard handler stays active during the dive (`activeViewId` does not change). Only **editor** sub-pages (`hotkeys-editor`, `shortcuts-editor`, `task-runner-editor`) register their own keyboard handler via `useRegisterViewKeyboard`. See `qol-tray-ui-systems` § view-keyboard-fallback for the resolution order.

Non-editor sub-pages (gallery showcases, log detail, backup detail, etc.) MUST NOT register their own keyboard handler. Rely on parent view fallback.

## SurfaceContainer is mandatory inside a page

Any page that hosts navigable surfaces MUST wrap them in a `SurfaceContainer`:

```js
<div class="view-container content-shell">
    <${PageHeader} title="..." />
    <${SurfaceContainer} className="view-body">
        ...
    <//>
</div>
```

Without `SurfaceContainer`, `globalSurfaceNav` cannot find the surfaces and keyboard navigation breaks silently. The sidebar and wedge will appear to work, but arrow keys will not move between elements inside the page.

## Locked-down tests

| Test | Lock |
|---|---|
| `world-pages-content-sized.test.js` | Top-level views in `MUST_BE_CONTENT_SIZED` must declare `contentSized: true`. `registerStaticDiveTargets` and `registerPluginDiveTarget` must call `addEntry({ contentSized: true })`. |
| `views.test.js::resolveViewLabel` | New static dive targets with a `label` should be added to the test list (cosmetic, confirms the label flows back through `resolveViewLabel`). |

## Don'ts

| Mistake | Why it bites |
|---|---|
| Single page with 16 embedded views (sidebar or tab inside the page) | Defeats the world model. Each conceptual page must be its own entry. Tab and minimap cannot navigate inside a single page. |
| Using `ViewTabs` inside a dive | ViewTabs is a layer-0 affordance. Inside a dive, multi-page is the answer. |
| Removing the parent's `SurfaceContainer` while refactoring | Silent keyboard-nav break. Always preserve the wrapper. |
| Hand-rolling `data-selected-surface` | Use `Surface`, `useSurface`, or `useInputSurface`. Raw attributes do not integrate. |
| Page width or stride drift from `PLUGIN_PAGE_WIDTH` (1280) and `PLUGIN_PAGE_STRIDE` (10000) | Minimap rect, slot scale, and camera bounds desync. |
| Forgetting `contentSized: true` on a content page | Slot pins to fixed 900px height; long content gets clipped (no inner scrollbars allowed). |
| Adding a sub-page to `WORLD_PAGES` AND rendering it dynamically | Double-render in `renderWorldViews`. Pick one. |
| Registering a keyboard handler under a non-editor sub-page id | Breaks parent fallback. Only `*-editor` sub-pages register handlers. |
| Wiring a dive trigger as a raw `<div>` instead of a `Surface` | Click-to-dive lives in `Surface.handleSurfaceClick`. Raw elements do not dive on click. |
| Coupling a sub-page to its trigger's local state | Use `createSharedSlot` (see `log-filters-subpage.js`, `plugin-actions-subpage.js`). |
| Opening a `Modal` for a detail view | Modals clash with world layers and break Esc routing. Use a dive sub-page (see Recipe: row-activates-into-detail). |
| Pairing `useListKeyboard` with rows that have `data-dive-target` | preventDefault on Enter blocks `globalSurfaceNav` and the dive never fires. Let surface activation handle it (see "Don't pair useListKeyboard with divable rows"). |
| Defaulting `slot` or `config` props on a reusable sub-page | Hides the contract, makes drift invisible. Make them required; both prod and gallery wire explicitly. |
| Setting the detail slot via `useState` + `useEffect` from `onActivate` | The dive resolves in the same click tick before the effect runs. Land on empty placeholder. Write the slot directly in `onActivate`. |
| Hardcoding `viewId="<x>-editor"` inside an editor sub-page used by the gallery | Gallery's mount overwrites the prod view-keyboard registration. Prod Esc routes through gallery's slot, modal stays open. Make `viewId` a prop. |
| Gallery editor slot with `handleKey: null` and `isBlocking: () => false` | Ctrl+Enter / Esc never reach `onSave` / `onClose`. Wire modalNav handleKey and `isBlocking: () => !!modal`. |
| Page-specific keyboard help text in the empty state (`Press <kbd>a</kbd> to add`) | `<KeyLegend>` already shows that next to the subtitle. Duplicated source of truth, drifts. |
| Adding a key to a list handler without updating `VIEW_BINDING_DEFAULTS` | Legend lies to the user. Handler and table change in the same commit. |

## Where things live

| File | Responsibility |
|---|---|
| `ui/app/views.js` | `WORLD_PAGES`, `BASE_ORDER`, `renderPageContent`, `renderWorldViews`, dynamic page rendering passes. |
| `ui/components/App.js` | `registerStaticDiveTargets`, `registerPluginDiveTarget`, page constants (`PLUGIN_PAGE_*`). |
| `ui/lib/world-registry.js` | `addEntry`, `addDiveTarget`, `getDiveTargetForSource`. Pure data store. |
| `ui/lib/world-navigation.js` | `diveInto`, `ascend`, `getConfinedPages`, dive stack. |
| `ui/lib/world-navigation-singleton.js` | `diveViaSelector`, `ascend` shims for non-React call sites. |
| `ui/app/useAppKeyboardRouting.js` | Tab cycling (top-level vs sub-pages), Esc routing. |
| `ui/app/view-labels.js` | Human-readable view labels for the sidebar and breadcrumb. |
| `ui/lib/view-bindings.js` | `VIEW_BINDING_DEFAULTS` per viewId. Add an entry when adding a list view. |
| `ui/lib/hooks/useViewBindings.js` | Read defaults (later: merged with user config). |
| `ui/lib/components/KeyLegend.js` | Renders the contextual hotkey strip. Lives in `PageHeader`'s `aside` slot. |
| `ui/components/PageHeader.js` | `aside` prop carries the legend alongside the subtitle. |
| `ui/lib/components/DiveEditorSubPage.js` | Generic editor sub-page shell. Auto-ascends on modal-close transition. |
