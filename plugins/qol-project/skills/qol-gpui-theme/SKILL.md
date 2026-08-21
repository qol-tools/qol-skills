---
name: qol-gpui-theme
description: "Use when designing, building, reviewing or restyling any native gpui surface in qol - settings panel, launcher, alt-tab, cli-sessions, remove-app, qol-shot, toasts, gamepad diagram. Defines Bone and Amber V2: the surface token set for light, dark and unfocused, the spacing/height/type/radius ladders, one definition per state, the component register, and the delta between the qol-theme palette and this spec. Companion to qol-plugin-gpui-surfaces, which owns wiring and placement rather than looks."
---

# Bone and Amber (V2)

The visual system every native qol surface is drawn in. `qol-plugin-gpui-surfaces`
says how a surface is wired, summoned and dismissed. This skill says what it looks
like once it is on screen.

Visual reference deck, every surface and every state drawn at real size:
`reference/bone-and-amber-deck.html` beside this file, also published at
https://claude.ai/code/artifact/0eeae966-f0e2-4a88-9c2f-2bcf7280f622

The plan for closing the gap between this spec and the code, with what five recon
lanes found in the tree, is `reference/v2-migration-plan.html`, published at
https://claude.ai/code/artifact/ef0b287c-2827-4de6-97a0-7dda581f0513

The deck is the picture. This file is the contract. When they disagree, this file
wins and the deck gets redrawn.

## The five laws

1. **Square windows, rounded controls.** A surface has no corner radius. Everything
   inside it does. A rounded window on a desktop reads as a web page.
2. **No hard stops.** Separation is a translucent hairline or a wash, never a solid
   line and never a border that changes an element's size.
3. **Amber means two things: where you are, and what you chose.** It is never
   decoration, never a primary button, never a brand colour.
4. **One ladder each.** One spacing scale, one height ladder, one type scale, one
   radius scale. A value that is not on a ladder is a bug.
5. **Nothing is discoverable by hover alone.** If a control exists it is visible at
   rest. Hover may deepen it; hover may not reveal it.

## Scope

Tokens are surface-scoped. A gpui surface owns its whole palette; there is no
inherited page. Every colour in a surface resolves from the table below, in one of
three states: light, dark, and unfocused (a token swap over either theme).

## Surface tokens

| Token | Light | Dark | Job |
|---|---|---|---|
| `--pane` | `#fffefb` | `#16171a` | the surface itself |
| `--pane-2` | `#faf8f3` | `#1d1e22` | bands, wells, insets |
| `--pane-3` | `#efece4` | `#25262b` | pressed, recessed |
| `--edge` | `#e2ded4` | `#2a2b31` | the window's own outer edge |
| `--side` | `#f5f2eb` | `#101114` | navigation rail |
| `--sidetx` | `#57534a` | `#9a978f` | rail text |
| `--ink` | `#1a1815` | `#f3f2f0` | primary text |
| `--ink-2` | `#57534a` | `#b3b1ac` | secondary text |
| `--ink-3` | `#78736a` | `#8b8880` | captions, hints |
| `--acc` | `#b8860b` | `#e0ac3f` | the amber itself |
| `--acc-ink` | `#8a6208` | `#eec468` | amber text on a pane |
| `--acc-bg` | `#fdf5e3` | `#2a2214` | amber wash |
| `--accsolid` | `#201d18` | `#f2f0eb` | primary button fill (ink, not amber) |
| `--onsolid` | `#fbf9f4` | `#16171a` | text on that fill |
| `--pos` | `#2c8159` | `#4aa87a` | running, healthy |
| `--neg` | `#b5504a` | `#d98479` | failed, invalid |
| `--wrn` | `#b35c09` | `#e8964a` | needs attention |
| `--wrn-ink` | `#9e5510` | `#eb9d55` | warning text |
| `--hair` | `rgba(60,48,26,.12)` | `rgba(255,250,240,.09)` | default hairline |
| `--hair2` | `rgba(60,48,26,.2)` | `rgba(255,250,240,.16)` | hairline on a control |
| `--sep` | `rgba(60,48,26,.085)` | `rgba(255,250,240,.075)` | list separator |
| `--fill` | `rgba(90,72,34,.055)` | `rgba(255,250,240,.052)` | hover wash |
| `--fill2` | `rgba(90,72,34,.095)` | `rgba(255,250,240,.09)` | resting control fill |
| `--accsoft` | `rgba(184,134,11,.34)` | `rgba(224,172,63,.38)` | focused border |
| `--acchalo` | `rgba(184,134,11,.22)` | `rgba(224,172,63,.22)` | focus halo |
| `--wash-sel` | `rgba(60,48,26,.055)` | `rgba(255,250,240,.07)` | current row |
| `--wash-wrn` | `rgba(179,92,9,.075)` | `rgba(232,150,74,.1)` | attention row |
| `--wash-neg` | `rgba(181,80,74,.055)` | `rgba(217,132,121,.09)` | invalid row |
| `--edge-neg` | `rgba(181,80,74,.32)` | `rgba(217,132,121,.3)` | invalid frame |
| `--halo-pos` / `--halo-wrn` / `--halo-neg` | `.16` / `.16` / `.14` alpha of each hue | `.2` / `.2` / `.18` | status dot halo |
| `--cast` | `rgba(60,48,26,.11)` | `rgba(0,0,0,.45)` | small shadow |
| `--float` | `0 2px 6px rgba(60,48,26,.1), 0 18px 44px -16px rgba(60,48,26,.34)` | `0 2px 6px rgba(0,0,0,.5), 0 18px 44px -14px rgba(0,0,0,.85)` | window elevation |

Gamepad diagram only, four face-button hues that are never the accent:
`--pad-a #2f7350 / #5cbf8e`, `--pad-b #b5504a / #e08d82`,
`--pad-x #3a639b / #7fb0e8`, `--pad-y #a8760f / #e0ac3f`.

### Unfocused window

A surface that lost focus swaps five tokens and nothing else, over either theme.
The accent goes grey, the halo goes to zero, and `--pos` greys with it so no colour
reads as live in a window the user is not in.

- light: `--acc #8e8e99`, `--acc-ink #5f5f69`, `--acc-bg rgba(22,22,26,.05)`,
  `--accsoft rgba(22,22,26,.16)`, `--acchalo transparent`, `--pos #8e8e99`
- dark: `--acc #7c7c86`, `--acc-ink #b4b4be`, `--acc-bg rgba(255,255,255,.06)`,
  `--accsoft rgba(255,255,255,.16)`, `--acchalo transparent`, `--pos #7c7c86`

This is the pattern for every state that spans themes: the state swaps tokens, the
theme supplies values. Never write a state twice, once per theme.

## Ladders

- **Spacing** `--gut 20` outer gutter, `--padx 16` inner padding, `--mark 3` state bar.
- **Height** `--h-el 28` inline element, `--h-ctl 36` control, `--h-rule 48` rule row,
  `--h-row 52` setting row, `--h-bar 40` hint bar, `--h-band 64` title band
  (sub-band 52). List entries are 32 / 40 / 48 depending on density.
- **Type** `--fs-cap 11.5`, `--fs-sm 12.5`, `--fs-md 13.5`, `--fs-lg 15`, `--fs-xl 17`.
  One exception, the 10.5px mono key-hint chip.
- **Radius** `--r1 4`, `--r2 6`, `--r3 9`, `--r4 11`. The surface itself is 0.

A class or constant named for a size must set that size. Two of them once did not,
and both were shipped bugs.

## One definition per state

| State | Defined once as | Reused by | How you tell it apart |
|---|---|---|---|
| Current | `--wash-sel` + `--acc` bar | row, rule, list entry, rail item, card | amber bar, neutral wash, hairline frame |
| Needs attention | `--wash-wrn` + `--wrn` bar | row, rule, list entry, warning bar, busy dot | orange bar over a warm wash, no frame |
| Invalid | `--wash-neg` + `--neg` bar | row, rule, list entry, field, failure bar | red bar and a red frame around the whole row |
| Focused | `--accsoft` border + `--ring` | field, keycap capture, combo, chip, card, pad button | a solid amber edge inside a soft halo, nothing else halos |
| Hover | `--fill` | row, rule, list entry | a wash with no bar, never the only signal |
| Disabled | `opacity .4` | any row | everything fades together, so no colour reads as live |
| Window unfocused | `.unfoc` token swap | every surface | accent drops to grey, halo goes to zero |
| Running / failed | `--pos` / `--neg` + halo | status dot, toast edge, session row | semantic hue, never the user's accent |

`--ring` is `0 0 0 1.5px var(--acc), 0 0 0 4px var(--acchalo)`.

The solid inner edge is not decoration. No alpha of amber over bone reaches 3:1
against the pane, so a translucent halo alone can never be a compliant focus
indicator. Solid `--acc` on `--pane` is 3.23:1 and clears WCAG 1.4.11 by a hair.
If you soften that ring, focus stops being visible and the surface fails.

Nothing else in a surface carries a halo. A control that always looks focused
teaches the user nothing.

## Component register

| Component | Defined once as | Geometry | Appears in |
|---|---|---|---|
| Key combination | `.combo` | `--h-el` 28 | rules, capture field, hints, launcher |
| Key hint chip | one 10.5px mono recipe | `--hair2` border, `--r1`ish 3px | buttons, hint bars, search slash, kind tags |
| Button | `.btn` | `--h-ctl` 36 | every window with an action |
| Value chip | `.chip` | `--h-el` 28 | settings rows, editors, confirm bars |
| Text field | `.field` | `--h-ctl` 36 | capture, rename, search |
| Setting row | `.row` | `--h-row` 52 | settings panel, every plugin |
| Rule row | `.rule` | `--h-rule` 48 | keyremap, mouse, scroll |
| List entry | `.lrow` | 32 / 40 / 48 | launcher, sessions, remove app |
| Status dot | `.st` | 7px + 3px halo | sessions, toasts, health rows |
| Uppercase section label | one recipe | `--fs-cap`, 600, `.04em` | rail caption, editor label, rule head, dialog label |

Two components that look alike are one component with a modifier. A second copy of
a recipe is the drift that produced every visual inconsistency this system was
built to end.

## Behaviour that carries visual weight

- **Enter** edits one value in place; several values open an editor. The hint bar
  names it.
- **Escape** closes the innermost thing, never discards silently.
- **Arrow keys** move the amber bar. The bar is the cursor and it never lives in two
  lists at once.
- **Clickable** means a border or a fill. Flat text is never a button.
- **Destructive** is red text on a red hairline, never a red fill, and always
  confirmed.
- **Primary** is `--accsolid` on `--onsolid`, one per window. Ink, not amber.
- **Elevation** is `--float`, and only something that actually floats casts it.
- **Separation** is a `--sep` hairline, suppressed beside any washed row so it never
  cuts a state in half.
- **Errors** never show a raw error string. No errno, no status code, no stack. Say
  what happened and what the user can do.

## Relationship to qol-theme and kit.rs

The theme is real code, not a mood board, and it has drifted from this spec. Both
sides are named here so the delta is visible instead of argued about.

`libs/qol-theme/src/lib.rs` owns the palette as `SystemPalette`, built from
`LIGHT_REFERENCE` / `DARK_REFERENCE`. That is the SSOT for colour; never introduce
a colour literal in `libs/qol-gpui`.

Known deltas from V2, each one a decision waiting to be made rather than a bug to
fix silently:

- **Dark surfaces are cool, V2 is warm.** `DARK_REFERENCE.night_900` is `0x14181f`,
  a blue-grey; V2 asks for `#16171a`.
- **The dark accent differs.** `orange_400` is `0xffb454`; V2 asks for `#e0ac3f`.
- **Light is already close.** `night_900` `0xfaf7f0` against V2's `#fffefb`.
- **`SystemPalette` has 16 slots; V2 uses about 30 tokens.** Missing entirely:
  the washes, the two hairline weights, `accsoft` / `acchalo`, `--mark`, the
  gamepad hues, and the unfocused swap.
- **The height ladder in `libs/qol-gpui/src/kit.rs` is a different ladder.**
  `ROW_HEIGHT 44`, `ROW_DESCRIBED_HEIGHT 58`, `HEADER_HEIGHT 42`, `GUTTER 16`
  against V2's 52, 52, 64 and 20.

Closing any of these is a deliberate piece of work with a visible result, so it is
proposed, not slipped into an unrelated change.

## Building a surface

1. Take the palette from `qol_theme::SystemPalette` through `Kit`. Never call `rgb()`
   with a literal in a surface.
2. Pick every size off a ladder. If nothing on the ladder fits, the ladder is wrong
   and changing it is the change, for every surface at once.
3. Draw the resting state first, then hover, focus, current, attention, invalid,
   disabled and window-unfocused. A surface that only has a resting state is a
   third of a surface.
4. Give every action a visible resting affordance and a keyboard route, and name
   that route in the hint bar.
5. Square the window, round everything in it.

## What gpui can and cannot do here

- `linear_gradient()` exists and is used. Conic gradients do not, so the colour
  wheel is an image rather than a gradient.
- There is no cascade and no pseudo-element. A state bar is a real child with a
  fixed width, not a `::before`.
- Borders participate in layout. Use an absolutely positioned inset frame for a
  selection ring so selecting a row cannot shift its contents.
- There is no CSS grid. Every layout in this system is flex, which it was designed
  for.
- A repeating animation repaints the whole window every vsync. Spinners and status
  dots are the only things allowed to run one.

## Verifying

- Read the deck beside the running surface, same theme, same size.
- Contrast: body text clears 4.5:1 and every focus indicator and state marker clears
  3:1, in both themes. Compute it, do not eyeball it.
- Colour-blind check: no state is signalled by hue alone. Every semantic colour is
  paired with a shape, a position or a word.
- Hit targets are at least 24px, counting the row rather than the glyph inside it.
- Grep the surface for colour literals and for sizes that are not on a ladder. Both
  should return nothing.

## Changing the theme

The theme is versioned. This is V2, agreed 2026-08-21, after an audit that found
the focus ring defined six times and invisible in all six, a height class that set
a different height than its name, a state that existed only in the light theme, and
twenty distinct type sizes across two rival scales.

A change to any token, ladder or state definition is a new version: update this
file first, then the deck, then the code, in that order. A change that lands in one
surface only is not a theme change, it is drift.
