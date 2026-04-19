---
name: qol-world-canvas
description: Use when working on divable elements, dive traits (confined, peripheral-preview, atmosphere), world navigation, the dive stack, or plugin spatial layout in qol-tray. Use when touching ui/lib/world-*, ui/components/shell/WorldViewport.js, PeripheralPreview.js, AtmosphereLayer.js, plugin-trait-overrides.js, or ui/styles/atmosphere.css / peripheral-preview.css.
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
