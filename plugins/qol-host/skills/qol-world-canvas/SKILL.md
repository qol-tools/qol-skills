---
name: qol-world-canvas
description: Use when working on divable elements, dive traits (confined, peripheral-preview, atmosphere), world navigation, the dive stack, plugin spatial layout, or the minimap in qol-tray. Use when touching ui/lib/world-*, ui/lib/minimap-*, ui/components/shell/WorldViewport.js, Minimap.js, PeripheralPreview.js, AtmosphereLayer.js, plugin-trait-overrides.js, or ui/styles/atmosphere.css / peripheral-preview.css.
---

# qol-tray World Canvas Reference

## Model

The world is one continuous 2D coordinate space plus a layer axis (see `docs/superpowers/specs/2026-04-11-world-confinement-design.md`). Pages live at world coordinates; the camera pans/zooms/changes layer. Dive frames are pushed on a LIFO stack; ascend pops one frame at a time.

Each divable element declares a **DiveTarget** (source selector, claim rect, page list) and may carry a `traits` map. Traits are orthogonal capabilities that affect how the divable is rendered or behaves while the user is inside it.

Design spec: `docs/superpowers/specs/2026-04-15-divable-traits-design.md`.

## Trait Registry

Three traits ship today. Future traits compose on the same surface.

| Trait | Config | Effect |
|---|---|---|
| `confined` | `{}` | Walls off the world outside the divable's claim. Already in place; this trait formalized it. |
| `peripheral-preview` | `{ neighbors: int }` | Renders ±N sibling miniatures at viewport edges. Non-interactive. |
| `atmosphere` | `{ preset, background, tint, audio }` | Paints a backdrop inside the confined region. Preset-driven with per-divable overrides. |

A DiveTarget with no `traits` field gets defaulted to `{ confined: {} }` by `addDiveTarget`. Existing non-traited targets keep current behavior by construction.

## Files

### Navigation + registry (shape + propagation)

- `ui/lib/world-registry.js` — `addDiveTarget` defaults `traits: { confined: {} }` when omitted; preserves explicit traits.
- `ui/lib/world-navigation.js` — `diveInto` sets `currentTraits = target.traits || {}` and pushes prior traits on the dive stack; `ascend` restores prior traits. Exposes `getCurrentTraits()`.
- `ui/lib/world-navigation.test.js` — tests for: trait defaulting, explicit trait preservation, dive/ascend trait propagation.

### Contract flow (plugin → DiveTarget)

- `ui/components/App.js`:
  - `fetchPluginContract(pluginId)` reads `/api/plugins/:id/config-form`, returns `{ sections, traits }`. Backend currently only sends `sections` — `traits` falls back to `null`.
  - `registerPluginDiveTarget(registry, plugin, sections, traits, pluginsEntry, pluginIndex)` applies `pluginTraitOverride(plugin.id)` when backend returns no traits. Pilot shortcut; remove once backend wires contracts.
- `ui/lib/plugin-trait-overrides.js` — per-plugin-id fallback trait map. Pilot only.

### Renderers (mounted inside `WorldViewport`)

- `ui/components/shell/PeripheralPreview.js` — reads `navigation.getCurrentTraits()['peripheral-preview']`, renders sibling miniatures at viewport edges. Hard cap of 4 neighbors per side. Subscribes to anchor changes via `subscribeAnchor`.
- `ui/components/shell/AtmosphereLayer.js` — reads `navigation.getCurrentTraits().atmosphere`, applies preset class or custom background to a positioned layer behind `#world`.
- `ui/components/shell/WorldViewport.js` mounts both: atmosphere behind `#world`, peripheral preview alongside.
- `ui/lib/atmosphere-presets.js` — `isKnownPreset`, `resolvePresetClass`. Central place to list valid preset names.

### Styles

- `ui/styles/peripheral-preview.css` — slot positioning, scale, opacity falloff per `data-distance`. CSS transitions provide v1 smoothing (full ~240ms choreographed animation is a follow-up).
- `ui/styles/atmosphere.css` — base `.atmosphere-layer` + four preset classes: `atmosphere-preset-{wood,parchment,terminal,spacecraft}`. Presets use layered backgrounds, no external assets.
- Both imported from `ui/styles.css`.

## Declaring Traits on a Plugin

Canonical (contract-driven, not yet wired end-to-end):

```toml
# qol-config.toml for a plugin
schema_version = 1

[field.foo]
type = "number"

[traits.confined]

[traits.peripheral-preview]
neighbors = 1

[traits.atmosphere]
preset = "terminal"
```

For contract-driven traits to reach `addDiveTarget`, the backend must:

1. qol-config side: parse `[traits]` from plugin TOML into a serializable map.
2. qol-tray backend: include `traits` in `CombinedPluginForm` (`src/features/plugin_store/server/settings/plugin_config_handlers/form.rs`). Serde flattening or an explicit field works.
3. Frontend `fetchPluginContract` already consumes `form.traits` if present.

Until that lands, add a fallback entry in `ui/lib/plugin-trait-overrides.js` keyed by plugin ID. The override map is a pilot scaffold; delete once contracts ship.

## Declaring Traits on a Static Target

Static dive targets (hotkeys editor, shortcuts editor, logs detail, task-runner editor) declared in `registerStaticDiveTargets` in App.js rely on `addDiveTarget`'s default traits. Pass an explicit `traits` key if a static target needs non-default behavior.

## Adding a New Preset

1. Add the preset name to `PRESETS` in `ui/lib/atmosphere-presets.js`.
2. Add a `.atmosphere-preset-<name>` selector to `ui/styles/atmosphere.css` with background/image/tint.
3. Optionally document the preset intent (vibe, inspiration) in the design spec.

Presets are pure CSS. They intentionally do not use theme tokens — atmosphere is a decorative escape hatch, not part of the semantic token system.

## Adding a New Trait

1. Extend the design spec with the trait's purpose, config shape, composition rules, and non-goals.
2. Trait config flows automatically through `addDiveTarget` → `getCurrentTraits()` — no navigation changes required.
3. Add a renderer component in `ui/components/shell/` that reads `getCurrentTraits()[your-trait]` and returns `null` when absent.
4. Mount the component in `WorldViewport.js`, outside `#world` if viewport-space, inside `#world` if world-space.
5. Add CSS if the trait has visuals.

Traits must have a no-op default (absence = no effect). Do not couple traits to each other; they're orthogonal.

## Current Gaps / Follow-ups

- **Backend contract wiring.** Plugins can only declare traits via `plugin-trait-overrides.js` today. Once qol-config's contract parser and qol-tray's `CombinedPluginForm` include `traits`, delete the override file and its consumer in `App.js`.
- **Peripheral-preview rendering depth.** Current miniatures are label-only cards. Spec calls for real page content at reduced scale with a snapshot fallback — implement when rendering budget allows.
- **Peripheral-preview animation.** CSS transitions only. The full choreographed ~240ms scale+fade+parallax from the spec is a follow-up.
- **Atmosphere audio.** Trait config accepts `audio` but `AtmosphereLayer` ignores it. Audio manager with fade-in/out, nested-dive pause/resume, and global mute respect is unimplemented.
- **Minimap pipeline share.** Peripheral-preview currently renders placeholders; minimap renders real scaled pages. Once real-content peripherals land, consider sharing the scaled-page pipeline.

## Key Invariants

- Trait config is declarative, not imperative. No runtime trait registration.
- A trait's absence must equal its no-op default. Never gate mandatory behavior on a trait being *absent*.
- Peripheral previews are non-interactive. They capture no pointer/keyboard events. Navigation always resolves to the real active page.
- Atmosphere paints inside the confined region. It must not leak outside the divable.
- Every trait consumer must tolerate `getCurrentTraits()` returning `{}` and its own trait config being absent.

## Minimap projection

`ui/components/shell/Minimap.js` + `ui/lib/minimap-geometry.js` + `ui/lib/minimap-draw.js`.

### Model — focal point with continuous falloff

The focal point at `minimapWidth / 2` sits at `activePosF` (CONTINUOUS float) derived from the camera's world-x centre via `activePosFromCameraCentre`. Slot widths derive from a per-slot weight = `decay^d × fade(d, R)` where `d = |i - activePosF|`, `R = focusRadius` (= slider value), `decay = 0.3^(1/R)` (sharper at low R, flatter at high R), and `fade(d, R) = clamp(R + 1 - d, 0, 1)`.

The `fade` term is what eliminates the pop: as `activePosF` slides past an integer, the slot at `d = R + 1` ramps from 0 → 1 monotonically; the symmetric slot on the other side ramps 1 → 0. Gap between slots is suppressed when one of them has zero width.

- No slicing. Pass the full layer through; slots beyond `R + 1` get zero width and the draw layer culls them.
- As the camera pans, `activePosF` is continuous. `panSmooth` ticks rAF over 140ms; the minimap re-renders on each notify and slot widths interpolate smoothly.
- Active stays at the strip centre even at world edges — neighbours fan out only on the side that has them.
- Camera rect is honest: walk visible slots, project camera world-x intersection through each entry's slot pixel range, union the pieces. Reflects the camera's true world span — no cosmetic adjustment.

### Readability floor (`MINIMAP_MIN_SLOT_PX`, `MINIMAP_MIN_SLOT_FRAC`)

Per-slot pixel floor passed into the layout. Each slot's natural geometric size is clamped to `max(MINIMAP_MIN_SLOT_PX, MINIMAP_MIN_SLOT_FRAC × minimapWidth)`. The redistributor compensates: floored slots take the floor, the rest split the remaining budget weighted by their original decay-relative size. If the budget is tight enough to overrun, the entire row is rescaled to fit.

Floor disabled when the slider is at MAX ("all"): user explicitly asked for everything; tiny slots are accepted.

### What lives where

- **`Minimap.js`** owns slicing (`sliceFocalNeighbours`), the floor decision, and the cog-wheel `WorldSettingsPanel`.
- **`minimap-geometry.js`** is pure pixel math: `computeMinimapFocalLayout`, `computeMinimapFocalRect`, `computeSlotCoverage`, `FOCAL_DECAY`, `FOCAL_GAP_PX`. No setting reads, no DOM.
- **`minimap-draw.js`** renders to canvas. `clampRectForDraw` widens narrow rects so they stay visible at high zoom.

### Constants

- `MINIMAP_NEIGHBOURS_MIN = 1` (Minimap.js) — slider floor.
- `MINIMAP_NEIGHBOURS_MAX = 12` (Minimap.js) — slider ceiling; sentinel for "all" (focusRadius set to layer length).
- `MINIMAP_MIN_SLOT_PX = 28` (Minimap.js) — absolute pixel floor.
- `MINIMAP_MIN_SLOT_FRAC = 0.08` (Minimap.js) — minimum slot as fraction of minimap width; effective floor = max of these two.
- `FOCAL_GAP_PX = 5` (minimap-geometry.js) — inter-slot pixel gap, suppressed when one neighbour has w = 0.
- `FOCAL_SLOT_ASPECT = 0.62` (minimap-geometry.js) — fixed slot height/width ratio. Per-entry `entry.height` is intentionally ignored; otherwise navigating between pages with different content heights would reshape the active slot, which the user reads as the minimap "redrawing differently per page".

`computeMinimapFocalLayout` derives decay from `focusRadius` as `0.3^(1/R)` so the slot at distance R is at ~30% of active. Lower R = sharper falloff.

### Settings (`world-settings.js`)

- `minimapZoomFactor` (default 1, integer): slider value. Effective `focusRadius = factor × pow(viewportRange / pageWidth, 0.3)` — slow growth so reveal is paced. `pageWidth` is the **first** entry's width on the layer (invariant under navigation), NOT the active entry's width — using the active's width made `focusRadius` jiggle when navigating between pages of different world widths, which the user reads as "the minimap relayouts when I tab between pages even though the viewport zoom didn't change".

Earlier attempt: per-entry boost from `computeSlotScale` to mirror the viewport's CSS-scale focal effect. Removed — its proximity-to-camera weighting made pages near the camera scale at a different rate than far pages, so as the user zoomed the viewport, slots on the minimap appeared to scale unevenly. Focal decay alone (with the slow-growth `focusRadius`) provides the active-dominant feel without that distortion.
- `minimapSize` (px width of strip).

### Don't

- Don't reintroduce a world-x linear projection over the strip — slots stretch across world gaps when you do, the rect grows to half the strip on a single page, and the model loses the focal feel.
- Don't pack gap-collapsed (slot.w = entry.width × minimapWidth/sumOfWidths) — slot widths rescale as visible count changes and navigation feels like the minimap is zooming.
- Don't centre on the camera. Centre on the active entry; the rect represents where the camera is within that focus context.
- Don't read settings from `minimap-geometry.js`. Pure pixel math only.
- Don't change `ACCENT_R/G/B` in `minimap-draw.js` without updating `--accent-rgb` in `theme-tokens.css`. Canvas can't read CSS vars.

## World geometry (`ui/lib/world-geometry.js`)

### `PAGE_TOP_PAD_PX = 96`

Pixels from the top of the viewport where every navigated page anchors. Holding this constant across pages of different heights is what stops the vertical bounce when cycling through dive pages of varying height. Also reserves enough headroom for the `world-region-label` (positioned at `entry.y - 56`) to sit fully above each page without being clipped by the viewport top.

### `cameraTargetFor`

`y = entry.y - PAGE_TOP_PAD_PX / zoom`. Tested invariant (see `world-geometry.test.js`): for any zoom, `(entry.y - cam.y) * zoom == PAGE_TOP_PAD_PX`. Cycling between pages of any height never moves the page top up/down on screen.

### `viewportPadding`

Returns `{ padX: w/(2*zoom), padY: h/(2*zoom) }` when viewport is valid, falls back to `maxEntryExtent(entries)` otherwise. Padding result is independent of entries when viewport is valid (only the fallback uses entries). Used by `paddedWorldBounds` to expand confinement rects so the camera can anchor a page top at `PAGE_TOP_PAD_PX` regardless of how tight the claim is.

### `paddedWorldBounds`

Single source of truth for camera bounds on any layer. Confinement rects are padded by `vp/(2*zoom)` so the camera can always anchor a page top, and so bounds-driven `minZoom` doesn't force auto-zoom-in when the confinement is tighter than the viewport.

**Pad at zoom=1 baseline, not current zoom.** Padding by current zoom shrinks as the user zooms in, which tightens bounds, raises the bounds-driven minZoom floor, and traps zoom at the zoomed-in state. App.js `recomputeBounds` and `setBounds` in world-navigation both pass `zoom: 1` explicitly.

### Region labels

`LABEL_GAP_PX = 10` and `HIDE_BELOW_SCREEN_W = 120`. The label bottom anchors `LABEL_GAP_PX` above the page top in screen pixels (CSS `transform: translateY(-100%)` applied via class). When `entry.width * zoom < HIDE_BELOW_SCREEN_W` the label hides — otherwise tiny labels pile up when zoomed far out.

Labels render in screen space (outside `#world`) so they don't scale with the world transform. Per-frame positions are written imperatively inside the camera subscribe callback so labels update in the SAME frame as `#world`'s transform. `RegionLabels` writes once on subscribe using live camera getters because the parent's mount-time `gotoAnchor` often settles BEFORE the subscription is registered (parent useLayoutEffect runs after child ones), so a future `notify()` may never arrive — without this sync labels stay frozen at their initial stale position.

### Slot-scale (zoom-out inflation)

`computeBaseScale(zoom, threshold)` and `computeSlotScale({...})` model the CSS `transform: scale(--slot-scale)` applied to pages when the camera zooms below `ghostThreshold` and `uiScaleOnZoomOut` is on. Pure functions extracted from `App.js::applySlotScales` so the minimap viewport rect can use the visually inflated bounds when checking what the camera frames — otherwise the rect under-represents what the user actually sees.

`WORLD_PAGE_STRIDE = 10000` and `WORLD_SLOT_GAP_FACTOR = 0.85` MUST stay in sync with `App.js`'s `PLUGIN_PAGE_STRIDE` / equivalent. Drift means the minimap rect and rendered slots disagree.

Constants:
- `SLOT_SCALE_CENTER_FLOOR = 0.75` — minimum proximity factor at the centre.
- `SLOT_SCALE_FALLOFF_FACTOR = 2.5` — how far inflation reaches.
- `SLOT_SCALE_ZOOM_FLOOR = 0.05` — protection against div/0 at extreme zoom.

`inflatedEntryRange(entry, slotScale)`: slots scale around their centre, so inflated x-range is `centre ± (width/2)*scale`.

## Slot DOM contract (`ui/lib/world-slot-style.js`)

The "slot is the content" model: when `entry.contentSized === true`, the slot emits no inline `height` — natural content height drives the slot box, and the world camera follows selection across tall pages. When false, the slot pins to `entry.height` (legacy fixed-page behavior, still used for editor sub-pages with fixed frames).

`isSlotVisible(entry, cameraLayer, confinedPages, diveDepth)` — layer match AND not ascending AND (no confinement OR id in confinement). `slotStyle(entry, visible)` emits `left/top/width`, optional `height`, optional `display:none`.

**Tested invariant** (see `world-slot-style.test.js`): `slotStyle` output never contains `overflow` or `scroll` tokens. The canvas is the viewport — no inner scrollbars allowed.

`world.css` `.world-view-slot .view-body { overflow: visible }` is locked down by the `world-pages-content-sized.test.js` source-text test, along with `.code-block`, `.view-body`, and `.plugin-config-detail`. Long lists (hotkeys, logs) and grids (plugins, store) MUST size to their content height.

## Top-level views must declare `contentSized: true`

The list is locked by `world-pages-content-sized.test.js`: `plugins`, `store`, `hotkeys`, `shortcuts`, `task-runner`, `profile`, `logs`, `dev`. Both `registerStaticDiveTargets` and `registerPluginDiveTarget` in `App.js` register entries with `contentSized: true`.
