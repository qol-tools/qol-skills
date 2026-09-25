---
name: qol-gpui-theme
description: "Use when designing, building, reviewing or restyling any native gpui surface in qol - settings panel, launcher, alt-tab, cli-sessions, remove-app, qol-shot, toasts, gamepad diagram - or the web settings page tokens. Defines Bone and Amber V3: grounds for light, dark and unfocused, the eleven text styles, keys and drawn icons, the spacing/height/radius/depth/motion ladders, one definition per state, the kit parts every window is built from, and the guard tests that fail the build on a mismatch. Companion to qol-plugin-gpui-surfaces, which owns wiring and placement rather than looks."
---

# Bone and Amber (V3)

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
6. **State is a ground, never a line.** The chosen item is the band, a warning is
   the attention ground, a failure is the invalid ground, and a status dot says
   which kind of message it is. Nothing is drawn on an edge: no coloured side
   line on any card, row, bar or toast, the settings card included.

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

### Amber is the default accent, not a constant

The product ships six accent presets per theme and the user picks one, so the
`--acc` values above are the **default preset**, not a fixed colour. Every
accent-derived token is a function of whatever accent is active: `--acc-ink`,
`--acc-bg`, `--accsoft`, `--acchalo` and the focus ring. Nothing else in the
system is accent-derived; the semantic hues, the washes and the hairlines stay
put whichever accent is chosen, which is what keeps state readable in all six.

Two consequences. A preset is only shippable if its derived tokens still clear
the contrast floors, so the floors are enforced per preset rather than once for
amber. And the preset keys are slots rather than colour names: the key `amber`
carries a different hue and label in each theme, which is how the light theme
ended up rendering the default accent as the blue `Harbour` (`#2f74a0`) while
its actual amber sits under the key `violet`, labelled `Brass`. That is a bug
against this spec, not a design choice.

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

In code the swap is `Theme::quiet()` (grey accent, accent ink and running green,
from `LIGHT_QUIET_*` / `DARK_QUIET_*`) plus `Grounds::quiet()` (every ground's
focus halo to zero). The kit reads focus once per window: `SurfaceRoot` watches
activation and calls `kit::enter_window(WindowLook::Quiet)` while a shown panel
is not focused, and every other window root calls
`kit::enter_window(WindowLook::Live)` first thing in `render`. A window never
checks focus on its own. Toasts and popups never take focus, so they never go
quiet, and a hidden panel reopens live.

## Ladders

- **Spacing** `--s-stack 2` label over its description, `--s-tight 4` between rows,
  `--s-snug 6` keycap inset and keycap-to-label gap, `--s-inset 8` row and chip inset
  and value-cell gap, `--s-cell 12` control inset and row label-to-value gap,
  `--padx 16` inner padding, `--gut 20` outer gutter. `--mark 3` is a bar width, not
  a spacing. In gpui code every rung is a `qol_theme::SPACE_*` constant, and gpui's
  rem helpers (`gap_2`, `px_3`, `py_1` ...) are banned in settings scope because they
  hide the number.
- **Height** `--h-el 28` inline element, `--h-ctl 36` control, `--h-rule 48` rule row,
  `--h-row 52` setting row, `--h-bar 40` hint bar, `--h-band 64` title band
  (sub-band 52). List entries are 32 / 40 / 48 depending on density.
- **Type** is eleven text styles, `qol_theme::TextStyle`, each a face, size,
  weight and line height. Text is set with `.text(TextStyle::…)` and nothing
  else; every style ends on one line with an ellipsis, and `.wraps()` or
  `.line_clamp(n)` are the only ways out.

  | Style | Face | Size | Weight | Line | Job |
  |---|---|---|---|---|---|
  | Masthead | display | 34 | 600 | 1.0 | rail section head |
  | Heading | display | 20 | 600 | 1.15 | window and group heading, crumb trail |
  | Colophon | display | 11.5 | 600 | 1.2 | the line under a heading, accent ink |
  | Name | ui | 15 | 500 | 1.25 | setting label, rail item |
  | ListName | ui | 13.5 | 500 | 1.25 | list entry, toast and notice title, button |
  | Value | ui | 15 | 400 | 1.25 | value cell, window root |
  | Detail | ui | 12.5 | 400 | 1.25 | description, notice detail, chip |
  | Hint | ui | 12.5 | 400 | 1.0 | hint bar |
  | Key | mono | 12.5 | 400 | 1.0 | key chip |
  | Code | mono | 13.5 | 400 | 1.25 | paths, scores, typed search |
  | Label | ui | 11.5 | 600 | 1.2 | uppercase section label (`text::cased`) |
- **Radius** `--r1 4`, `--r2 6`, `--r3 9`, `--r4 11`. The surface itself is 0.
- **Depth** `qol_theme::depth`. See-through strengths are `Alpha` Trace 5, Wash 9,
  Halo 16, Edge 24, Veil 40, Strong 70 percent, applied with `translucent(rgb,
  alpha)`; a gradient end uses `clear(rgb)` or `solid(rgb)`. Two shadows,
  `SHADOW_FLOAT` (1/2 at Trace, 8/20 at Wash) for anything above the window and
  `SHADOW_RAISED` (1/2 and 6/16 at Wash) for a control, through
  `kit::float_shadow` and `kit::raised_shadow`. Dimming is `OPACITY_DISABLED` 0.4
  or `OPACITY_REST` 0.6. A line is `LINE` 1 px; 1.5 px exists only inside the
  focus ring. A status dot is `STATUS_DOT` 7 px with a 3 px halo. Glows are gone.
- **Motion** `qol_theme::Motion`: `QUICK` 140, `SETTLE` 180, `TRAVEL` 260 and
  `FADE` 1000 ms on two curves (`Settle` ease-out quint, `Travel` ease-in-out),
  and `MOTION_LOOP` 1200 ms for everything that repeats. Timing:
  `STAY_BRIEF` 4 s, `STAY_LONG` 8 s, `STAY_UNTIL_CLOSED`, `WAIT_BEFORE_BUSY`
  300 ms, `SETTLE_INPUT` 140 ms.

A class or constant named for a size must set that size. Two of them once did not,
and both were shipped bugs.

## One definition per state

| State | Defined once as | Reused by | How you tell it apart |
|---|---|---|---|
| Current | the band ground through `kit.highlight(row, selected)`: the accent mixed `RAIL_FILL_MIX` (45%) over `accent_fill_base`, hovered as the band hover ground | every list, menu, card and rail in every window, Alt Tab's selected card included | a filled band edge to edge, square, no bar; the accent turns to ink |
| Needs attention | the attention ground + a warning status dot | row, notice, toast | a warm ground and a dot, nothing on the edge |
| Invalid | the invalid ground + a danger status dot | row, notice, toast, the Remove App bar | a red-tinted ground and a dot, nothing on the edge |
| Focused | `kit.focus_ring(ground)`: `FOCUS_RING_EDGE` 1.5 px of the ground's `mark` inside a `FOCUS_RING_HALO` 4 px halo of the ground's `halo` | field, key capture, combo, card, pad button | amber on the pane, ink on the band, same part |
| Hover | the ground's `lift` through `kit.pointable(element, lift)` | row, rule, list entry, button | a lift, never the only signal |
| Disabled | `OPACITY_DISABLED` 0.4 | any row | everything fades together |
| Resting | `OPACITY_REST` 0.6 | a section or card that is not current, a resting chevron | dimmed, never hidden |
| Window unfocused | `Theme::quiet()` + `Grounds::quiet()` through `kit::enter_window` | every window that takes focus | accent drops to grey, halo goes to zero |
| Running / failed | `--pos` / `--neg` + halo | status dot, notice, session row | semantic hue, never the user's accent |

`--ring` is `0 0 0 1.5px var(--acc), 0 0 0 4px var(--acchalo)` on the pane; in code
`Ground.halo` is the mark at `Alpha::Edge` on a surface ground and ink at
`Alpha::Halo` on the band.

The solid inner edge is not decoration. No alpha of amber over bone reaches 3:1
against the pane, so a translucent halo alone can never be a compliant focus
indicator. Solid `--acc` on `--pane` is 3.23:1 and clears WCAG 1.4.11 by a hair.
If you soften that ring, focus stops being visible and the surface fails.

Nothing else in a surface carries a halo. A control that always looks focused
teaches the user nothing.

## Grounds

Locked 2026-09-13 on sheet 17. Four laws:

1. **A ground is what a control sits on.** Pane, rail, band, menu, attention and
   invalid are grounds. A control never picks its own colours and never gets a
   patched palette; it reads roles from the ground it sits on.
2. **A ground mixed from the accent never carries the accent.** On the band the
   chosen colour is ink, so a switch that is on turns into an ink track with a
   cut-out knob instead of violet on violet.
3. **Wells are ink, not surfaces.** A chip, a track or a number well is a
   translucent ink wash, so it shows up on any ground instead of melting into one.
4. **Hover lifts a ground, it never replaces it.** Hovering the current row
   deepens the band; it cannot remove it.

Every ground resolves the same eight roles: `ink`, `soft`, `faint`, `well`,
`edge`, `mark`, `on mark` and `lift`.

| Ground | `bg` | `soft` | `mark` |
|---|---|---|---|
| pane | `system.surface_elevated` | `system.text_secondary` | `system.accent` |
| rail | `system.surface_rail` | `system.text_rail` | `system.accent` |
| menu | `system.surface_raised` | `system.text_secondary` | `system.accent` |
| attention | `mix(system.surface_elevated, system.warning, washes.wash_attention.alpha_milli)` | `system.text_secondary` | `system.warning` |
| invalid | `mix(system.surface_elevated, system.danger, washes.wash_invalid.alpha_milli)` | `system.text_secondary` | `system.danger` |
| band | `mix(system.accent_fill_base, system.accent, RAIL_FILL_MIX)`, the existing `fill_current` | `floored_mix(bg, ink, 820, 4.5)` | `ink` |
| band hover | `band.lift` | `floored_mix(bg, ink, 820, 4.5)` | `ink` |

A surface ground (pane, rail, menu, attention, invalid) resolves `ink` as
`system.text_primary`, `faint` as `system.text_muted`, `well` as
`washes.fill_resting`, `edge` as `washes.hairline`, `on mark` as its own `bg`,
and `lift` as `mix(bg, ink, 50)`.

A ground mixed from the accent (band and band hover) resolves `ink` as
`system.text_primary`, `faint` as `floored_mix(bg, ink, 660, 3.0)`, `well` as
`css_rgba_milli(ink, 140)`, `edge` as `css_rgba_milli(ink, 240)`, `mark` as
`ink`, `on mark` as its own `bg`, and `lift` as `mix(bg, ink, 80)`.

`floored_mix(bg, ink, permille, floor)` is `mix(bg, ink, p)` for the smallest `p`
starting at `permille` and rising in steps of 10 up to 1000 whose WCAG contrast
against `bg` reaches `floor`, or `ink` when none does. The floor only moves
`soft` and `faint` where the locked 820 and 660 fall short: dark green and dark
cyan at rest, and dark amber, green and cyan on hover. Violet, blue, magenta and
every light preset keep the locked values exactly. Ink and soft clear 4.5:1 and
faint clears 3:1 on every ground, in all twelve accent presets, at rest and on
hover.

Components read roles from the ground they sit on, so the same switch paints
itself correctly on the pane and on the band. The code home is `Grounds` in
`libs/theme/src/lib.rs`, carried on the `Kit` as `kit.grounds`; every ground also
carries `halo` for the focus ring. The per-window palettes are gone: every
window reads grounds, `kit.washes`, and the semantic hues (`success`, `info`,
`warning`, `warning_ink`, `danger`, `accent_ink`). Only Alt Tab's
`PickerSurfacePalette` stays, because it carries the user's own card colour and
opacity, plus the two export palettes for the Cinnamon extension and the web.

## Component register

Every window is built from these kit parts (`libs/gpui/src/kit.rs`). Windows pick
which one and fill in the words; they never style one by hand.

| Part | Defined once as | Geometry |
|---|---|---|
| Window | `kit.window()` | square, pane ground, `LINE` edge hairline, `SHADOW_FLOAT` |
| Heading | `kit.heading(title, colophon)`, `kit.heading_title(style, title, colophon, live)` | Heading or Masthead over a Colophon in accent ink, `HEADER_HEIGHT` bar, faint when not live |
| Highlight | `kit.highlight(row, selected)` | the band ground, lift on hover |
| Notice | `kit.notice(NoticeTone, title, detail)` | Attention, Invalid, Done, Quiet; ground + status dot, ListName title, Detail on two lines, keys appended by the caller; a toast is a Notice in a floating window |
| Chip | `kit.chip(Chip, ground)` | `Chip::Key` / `KeyText` at `KEY_CHIP_HEIGHT` 20 (mono Key, faint, `Alpha::Edge` ink edge); `Count` / `Status` / `Tag` at `CHIP_HEIGHT` 22 on the ground's well, Detail in soft |
| Empty | `kit.empty(title, detail)` | centred ListName over Detail |
| Hint | `kit.hint(Key, label)`, `kit.hint_bar()` | a key chip and its label; every hint takes a `qol_gpui::Key` |
| Focus | `kit.focus_ring(ground)` | see Focused above |
| Busy | `qol_gpui::Busy` | eight drawn dots turning in `MOTION_LOOP`, shown only after `WAIT_BEFORE_BUSY` |
| Live | `kit.live_dot(id, tone, halo, live)` | the 7 px status dot pulsing in `MOTION_LOOP` |
| Scroll cue | `kit.scroll_cue(ScrollSource, ground)` | fade, chevron and bar at every edge with more; windowed lists keep one row between the chosen row and a faded edge |
| Icon | `qol_gpui::icon::icon(Icon, size, ink)` | drawn SVG for every symbol the shipped fonts lack: enter, tab, backspace, arrows, the mac modifiers, close, tick, more, prompt and the rest |
| Action circle | `Kit::action_circle(size, state)` inside `Kit::action_row` | `ACTION_CIRCLE_SIZE` 46, `HEIGHT_CONTROL` 36 or `HEIGHT_INLINE` 28, gap `ACTION_CIRCLE_GAP` 14; Resting, Primary, Armed, Disabled |

Keys have one namer: `qol_hotkeys::chord::caps` turns a chord into caps, lowercase
words joined by `+` on Linux and Windows (`win` on Windows) and glyphs with no
joiner on macOS; `qol_gpui::Key` is the typed key every hint and chip takes.

Two components that look alike are one component with a modifier. A second copy of
a recipe is the drift that produced every visual inconsistency this system was
built to end.

## Settings surfaces: one register, two hosts

The plugin contract panel and the qol core tools (`__core-shortcuts`,
`__core-hotkeys`, hosted as `CustomPanelView`) draw from the same register. A
component that exists for only one of them is a defect. This is the code truth for
that register; the table above is the general one.

A core tool reaches the panel chrome through `CustomSettingsBreadcrumbs`.
`settings_breadcrumbs` adds its words to the trail, and `settings_hints` returns
`CustomHints { question, left, right }`, where the panel adds `esc back` when
`right` is empty. While a core tool reports a crumb its own deck is deeper than
its list, so the panel draws no accent edge on the tool's card and the tool's
`deck::render` draws every edge and mark. Both hosts build choose cards from the
same `tile_arts`, `choose_step` and `choose_hints`.

| Component | Symbol | Geometry |
|---|---|---|
| Page body | `components::settings_page()` | `flex_1 min_h_0 flex flex_col`, px `SPACE_PAD`, pb `SPACE_PAD`, gap `SPACE_TIGHT` |
| Group header | `SettingsGroupHeader` | `kit.heading_title(Heading, …, current)` with its activity spinner, pt `SPACE_PAD`, pb `SPACE_SNUG`, closed by the masthead rule |
| Rail masthead | `components::rail_caption` | h `HEIGHT_BAND`, px `SPACE_CELL`, `kit.heading_title(Masthead, …, focused)` |
| Crumb trail | `components::settings_crumb_trail` | the Heading style, separator `/` at px `SPACE_TIGHT` |
| Setting row | `SettingsRow::setting` | h `HEIGHT_SETTING_ROW`, px `SPACE_INSET`, py `SPACE_TIGHT`, gap `SPACE_CELL`; `.separated(true)` draws the top hairline |
| Rule / add row | `SettingsRow::rule` / `::add` | h `HEIGHT_RULE_ROW`, same insets, rounded `RADIUS_CONTROL` |
| Label group | `components::settings_label_group(label, Option<description>, row, kit)` | `flex_1 min_w_0 flex flex_col`, gap `SPACE_STACK`; `settings_label` + optional `settings_description` |
| Value group | `settings_value_group()` | gap `SPACE_INSET` |
| Toggle | `SettingsToggle` | 40 x 24 track (`HEIGHT_INLINE - 4`), knob inset `SPACE_STACK` |
| Choice value | `SettingsChoiceValue` with `ChoiceArt` | every select row, single or multi, and the display mode row: word `TEXT_BODY` truncated at `CHOICE_WORD_MAX_WIDTH` 180, art box `CHOICE_PICTURE_WIDTH` x `CHOICE_PICTURE_HEIGHT` 56 x 35 drawn by `pictures::fitted_image`, or by `pictures::stacked_image` for two chosen pictures, arrow 8 x 14 drawn by `pictures::chevron`, gap `SPACE_CELL`; no fill, border or chip |
| Text field | `SettingsTextField`, and `SettingsTextField::live(field, row, palette)` for the field being typed into | h `HEIGHT_CONTROL`, px `SPACE_CELL`, rounded `RADIUS_CONTROL`, min `TEXT_FIELD_MIN_WIDTH` 220, max `FIELD_MAX_WIDTH` 320; the live field is focused, grows with its text between the two widths and draws its caret, and every key reaches it through `text_edit::apply_edit_key`, which answers `EditKey::Changed`, `Handled` or `Ignored` |
| Key combination | `SettingsKeyCombination` | h `HEIGHT_INLINE`, px `SPACE_INSET`, rounded `RADIUS_CONTROL` |
| Modifier chip | `SettingsModifierChip` | `kit.chip(Chip::KeyText)` on its row ground: on is a `well` fill with `ink` text, off has no fill and `faint` text; the border is `ink` at the cursor, `soft` when on, else `edge` |
| Mono label | `components::settings_mono_label(text, row, kit)` | `flex_1 min_w_0`, truncated, the Code style, `soft` on the pane and `ink` on the band |
| Feedback bar | `SettingsFeedback` | `kit.notice(Attention or Invalid, message)` |
| Message | `components::settings_message(text, danger: bool, kit)` | `kit.empty(text)`, or an Invalid notice when danger |
| Count chip | `kit.chip(Chip::Count(n, label), row ground)` | the kit Chip |
| Key chip | `kit.chip(Chip::Key(key), ground)` | the kit Chip |
| Hint bar | `Kit::hint_bar()` | h `HEIGHT_HINT_BAR`, px `SPACE_PAD`, gap `SPACE_GUTTER`, border_t hairline, bg `washes.fill_hover`, the Hint style |
| Hint | `Kit::hint(key, label)` | gap `SPACE_SNUG`: key chip + label |
| Cards, band bar, filter field | `components::settings_card`, `floating_card`, `settings_band_bar`, `settings_filter_field`, `settings_filter_overlay`, `rail_scrim_layer`, `rail_item_label`, `settings_slider_track`, `settings_swatch`, `settings_accent_dot`, `settings_error_line`, `settings_arrow` | recipes, so the views compose and never style |
| Buttons | `Kit::button_primary/ghost/danger` | px `SPACE_CELL`, py `SPACE_SNUG` |
| Dropdown menu | `dropdown.rs` | list item action menus only, never a select: menu p `SPACE_SNUG`, item px `SPACE_INSET`, item gap `SPACE_INSET`, min `MENU_MIN_WIDTH` 214, max `MENU_MAX_WIDTH` 280, label truncated |
| Row ground | `components::RowGround` | pane at rest, band when the row is selected with the body focused, band hover through `group_hover(SETTINGS_ROW_GROUP)` |
| Settings tile | `components::SettingsTile` with `TileArt`, `tile_layout`, `settings_tile_rows` and `TILE_HEIGHT` | `TILE_HEIGHT` 116, px `SPACE_SNUG`, gap `layout.gap`, rounded `RADIUS_CARD`; art 112 x 70 at three per row, 104 x 65 at four and 88 x 55 at five; grid gap `SPACE_CELL` at three and four per row and `SPACE_INSET` at five; name `TEXT_CAPTION`, `TEXT_MICRO` at five per row; tick 16 x 12 at top `SPACE_CELL`, right `SPACE_INSET`; `settings_tile_rows` pads the first row by `SPACE_INSET`; `tile_arts` gives each option its valid picture, else `letters_for` letters, else `letters:?`; `choose_step` moves the highlight and stops at every edge; `choose_hints` is `↵ choose` with `←→ move`, or `←→↑↓ move` once the tiles wrap |
| Hint bar (question) | `components::SettingsHintBar` with `SettingsHint` and `HintTone` | resting: `kit().hint_bar()` with the left hints, a spacer and the right hints; question: the bar fills `translucent(grounds.pane.ink, Alpha::Wash)`, the question in the ListName style in ink, then the hints, with no mark on its edge; `hint_tone_color` gives `success` for `Save` and `danger` for `Discard`, each key chip edged in its hue at `Alpha::Veil`; `SettingsHint::busy(label)` draws `settings_action_spinner` at 12 px where the keycap would be, then its label |
| Tile spinner | `components::settings_tile_spinner` | 44 px (`TILE_SPINNER_SIZE`) in `grounds.pane.faint` |
| Tick | `pictures::tick` | the locked 16 x 12 markup: a 6 x 11 box with 2 px right and bottom borders turned 45 degrees about its centre; drawn in a tile in `grounds.pane.mark` at rest and `grounds.band.ink` when highlighted |
| Deck | `deck::render` with `DeckFrame`, `deck::resting`, `deck::edge_alpha` and `deck::rail_opacity` | front card rests at `9d+1`; sliver `i` at left `9i`, 12 wide, inset `7(d-i)`; sliver edge `status_muted` at `max(0.08, 0.5 x 0.62^(d-1-i))`; rail `max(0.12, 0.5 x 0.65^(d-1))`, 0.5 at depth 0 and 1; mark `HEIGHT_INLINE` at `top(y - 14 - inset)`; `DeckFrame.on_sliver` takes a click on sliver `i`, and every card, sliver and drawer calls `.occlude()` |

Rules for settings scope:

- **R1** No gpui rem spacing helper (`gap_N`, `p_N`, `px_N`, `py_N`, `pt_N`, `pb_N`,
  `pl_N`, `pr_N`, `m_N`, `mx_N`, `my_N`, `mt_N`, `mb_N`, `ml_N`, `mr_N`, including
  the `p5` halves). Every spacing is `px(SPACE_*)`.
- **R2** No local spacing constant (a `const` whose name contains PAD, GAP, INSET,
  GUTTER or MARGIN and holds a number). Reference `SPACE_*` directly. Widths and
  sizes (`TOGGLE_TRACK_WIDTH`, `FIELD_MIN_WIDTH`, `PANEL_*_WIDTH`,
  `CRUMB_MAX_WIDTH`, `RAIL_CARD_OVERLAP`, `SWATCH_SIZE`, `MENU_MIN_WIDTH`) are
  geometry, not spacing, and stay.
- **R3** One recipe per component. Recipes live in `settings_panel/components.rs`
  (settings-only) or `kit.rs` (shared by every surface). Other settings-scope files
  compose recipes; they do not call `text_size`, `text_color`, `font_weight`,
  `font_family`, `bg`, `border`, `border_color`, `rounded`, `shadow` on their own.
- **R4** Colour in settings scope comes from the grounds (`kit.grounds.*`),
  `kit.washes.*`, a Kit recipe or a semantic hue (`kit.palette.success`, `info`,
  `warning`, `warning_ink`, `danger`, `accent_ink`). Any other
  `kit.palette.<field>` stays inside `kit.rs` and `components/`.
- **R5** Core tools and plugin panels render through the same components. A
  component that exists for only one of them is a defect.
- **R6** Focus has one owner. `SettingsPanelView` decides where keyboard focus
  lives from its own state: the rail while the source menu is open, the contract
  body while a plugin page is open, the custom body while a core tool is open.
  `focus_target()` resolves that decision to one `FocusHandle`;
  `Focusable::focus_handle` returns it, so the surface and the host focus it on
  open, replace and reveal without knowing which body is up; and
  `reconcile_focus` (called from every transition and from render) moves gpui
  focus onto that target whenever focus sits inside the panel but not on it.
  Nothing else in settings scope calls `window.focus`. A custom body publishes
  its `FocusHandle` on `CustomPanelView` and paints its selection from
  `is_focused`, which is the reconciled truth of the same decision.
- **R7** One progress cue. `qol_gpui::Busy` (eight drawn dots turning in
  `MOTION_LOOP`, shown only once `WAIT_BEFORE_BUSY` has passed) is the only
  motion for work that has not finished, with or without a caption. Text never pretends to be motion: a running phrase
  never ends in an ellipsis. In settings scope spinners are built only through
  `components::settings_query_spinner` (waiting on a plugin query,
  `status_muted`), `components::settings_action_spinner` (an action the user
  started, `state_on`) and `components::settings_busy_message` (a whole body
  loading, same frame as `settings_message`). A value cell waiting on a query
  shows the spinner alone, status rows included. A status value that is null
  shows an en dash, not loading. A toast for an operation still running is
  marked `Toast::busy()` and spins before its title. A core tool saving from
  its question keeps the question up with `SettingsHint::busy("saving")`, the
  action spinner where the keycap would be.

- **R8** Every heading in a settings surface is the masthead, and its colophon
  says what that group is for. See "The masthead, the colophon and the trail"
  below; it is locked copy and geometry, not a starting point.

### The masthead, the colophon and the trail

Locked 2026-09-12 after twelve canvas rounds. Do not redesign any line of this
without the user asking for it by name.

1. **One masthead, three sizes.** The rail section head, the page heading and
   every group head are the same component: a lowercase name in the display
   face (`qol_theme::font_display()`, Saira SemiCondensed SemiBold) over a
   colophon in accent ink. The rail sits at `TEXT_MASTHEAD`, a group at
   `TEXT_DISPLAY`. Nothing else may draw a heading.
2. **The colophon says what the thing is for.** Never a count, never "N
   settings", never "N fields". A count in a colophon has been rejected by the
   user more than once: it is a defect, not a fallback. Page and group
   colophons are lowercase (the component lowercases them) and come from the
   contract's `[section.*] description`, so a qol-owned contract section
   without a description is the bug. Fix the contract, never the renderer.
   The rail masthead is the one exception and carries identity instead of
   purpose: the core version, the installed plugin count.

   Every card also carries a colophon from contract copy, lowercase like the
   others. A select, list, live card or display layout card uses the field's
   `card_description`. The add card uses "a new {item_label}.", an entry card
   "a {item_label}." (`an` before a vowel), and a nested string list uses the
   `lists` `card_description` with `{entry}` replaced by the entry's crumb. At
   most 36 characters (`CARD_DESCRIPTION_MAX`).
3. **The cursor is what amber marks.** `SettingsGroupHeader` is quiet by
   default, name and colophon both `status_muted`, and a caller earns the ink
   name and the accent colophon by declaring the cursor with `.current(true)`:
   the body holds focus and this group holds the selection. Both halves are
   required, so no page accents a head while the cursor is in the rail, and a
   core tool page passes its own `body_focused`. One amber place per page,
   and a head that forgets to ask reads as quiet instead of as the cursor.
   The masthead name carries `line_height(relative(1.15))`, which is what
   keeps a descender ("plugins") off the clip edge. The
   rail obeys the same law: while the cursor is in the body the rail carries
   no accent at all, so its colophons drop to `text_muted` and the selected
   item's fill is mixed from `text_muted` instead of the accent
   (`rail_bg_selected_quiet`). The rail
   section the selection is not in also drops to `RAIL_SECTION_OPACITY`
   (0.55), which is what makes the live section read as the live one.
4. **A masthead closes with a hairline, and nothing else in the body has
   one.** Every masthead ends in `components::masthead_rule`, a 1px
   `washes.hairline`: the full width of a group head `SPACE_SNUG` under its
   colophon, and absolute along the bottom edge of the rail caption band so
   `HEIGHT_BAND` still holds its text. Nothing else: rows are not
   underlined, no group is boxed, separation everywhere else is whitespace.
   The crumb band keeps its bottom hairline, which is window chrome, not a
   body rule. Row hairlines were tried on 2026-09-12 and rejected by the
   user; do not bring them back. The masthead rule was asked for by name the
   same day.

5. **The trail is lowercase names with slashes.** `settings_crumb_trail` at
   `TEXT_CAPTION` in the display face: earlier crumbs `status_muted` and
   truncated at `CRUMB_MAX_WIDTH`, the last crumb `section_text`, separators
   `/` at `SPACE_TIGHT` padding and `status_muted` at alpha `0x70`. The band
   holding it is `HEIGHT_SETTING_ROW` tall, not `HEIGHT_BAND`, and it carries
   the trail and nothing else: no count chip, no subtitle, no rule under it.
6. **No card carries a coloured edge.** Law 6 removed the front card's amber
   edge on 2026-09-25: the front card is lifted by its shadow alone and the band
   marks the row. Behind it, sliver `i` at depth `d` has a grey edge at alpha
   `max(0.08, 0.5 x 0.62^(d-1-i))`, the steep fade, and every sliver keeps a
   28 px grey mark at `0.9` of its edge alpha, centred on the row that opened
   the next card.
7. **The page card slides over the rail.** Opening a source slides the card
   left by `RAIL_CARD_OVERLAP` (98) while the rail dims under `kit::rail_scrim`.
   At depth `d` the rail opacity is `deck::rail_opacity(d)`,
   `max(0.12, 0.5 x 0.65^(d-1))`: 0.5 is the depth 1 value and every deeper
   card takes about a third off it.
   Dim plus scrim is the cue; do not add a fake blur. Recheck backdrop-blur
   support in the workspace-selected GPUI source before replacing this treatment
   with native blur.
8. **One push, one pop, every depth.** `deck::slide` drives the card motion
   whether the rail is open or closed, at depth 0 and at any depth inside a
   deck. Lists, entries, Add, nested string lists and selects each open a card
   with that slide, and the trail gains one word per card. Cards stack at any
   depth, and clicking a sliver goes back to that level. A card that appears
   without that slide is a wiring bug. A transition animates only while it is
   in flight (`transition_in_flight` against its tracker): once it has run,
   every render draws the settled state, so a card that comes back when a page
   above it closes never replays its slide or its amber edge. Closing is a
   drawer: the page being closed stays mounted and slides off to the right
   through `deck::drawer` while the page underneath is rendered at the same
   time (`render_level` picks which level the body builds from), and the stack
   pops when the slide ends or on the next key.

Settings scope is `libs/gpui/src/settings_panel/**`,
`libs/gpui/src/gamepad/**`, `libs/gpui/src/kit.rs`, `dropdown.rs`,
`hint_bar.rs`, `deck.rs`, and `apps/qol-tray/src/settings_surface/**`.

The guard tests live in `libs/theme/tests/theme.rs`, and every debt list is
empty: a window that picks its own size, weight, key name, symbol, corner,
colour, shadow, alpha, time or chip does not build.

- Ladders: `gpui_surfaces_do_not_use_rem_spacing_helpers`,
  `gpui_spacing_literals_stay_on_the_space_ladder`,
  `settings_surfaces_declare_no_local_spacing_constants`,
  `the_depth_ladders_hold_their_approved_values`,
  `text_styles_hold_their_approved_values`,
  `stays_and_waits_hold_their_approved_values`.
- Composition: `settings_surfaces_compose_shared_components`,
  `settings_surfaces_take_colour_from_the_settings_palette`,
  `every_chip_badge_and_pill_is_the_kit_chip`,
  `every_heading_notice_and_empty_list_is_a_kit_part`,
  `every_window_frame_is_kit_window`, `every_hover_is_the_kit_pointable_lift`.
- Text, keys, symbols: `every_text_takes_a_text_style`, `every_hint_takes_a_key`,
  `every_character_a_window_draws_is_in_the_shipped_fonts`.
- Windows and state: `every_window_is_square`, `no_surface_draws_a_coloured_side_line`,
  `every_window_says_whether_it_goes_quiet`,
  `a_quiet_window_greys_only_the_accent_and_the_running_green`,
  `every_scrolling_list_says_when_there_is_more`.
- Depth and motion: `every_shadow_alpha_opacity_and_line_comes_from_the_theme`,
  `every_animation_takes_a_theme_motion`.
- Focus and progress: `settings_surfaces_have_one_focus_owner`,
  `gpui_surfaces_draw_progress_with_the_spinner`,
  `settings_surfaces_build_spinners_through_components`.
- Web: `the_web_settings_page_takes_sizes_times_and_shadows_from_the_theme`.

## Behaviour that carries visual weight

- **Enter** edits one value in place; several values open an editor. The hint bar
  names it.
- **Escape** closes the innermost thing, never discards silently.
- **A click outside a menu** closes it, and the click still lands where it was aimed. In a
  settings panel a click on the body also takes the cursor from the rail, so the next
  Escape closes the innermost thing there, never the window.
- **A card blocks the mouse.** A gpui hitbox under a painted element still takes
  clicks, so every card, sliver and drawer calls `.occlude()`. Without it a
  sliver click also switched plugins through the rail item beneath.
- **A rail click from a card** asks first when the top form changed, and
  otherwise lands on the chosen source's page with no cards open.
- **Arrow keys** move the amber bar. The bar is the cursor and it never lives in two
  lists at once.
- **Clickable** means a border or a fill. Flat text is never a button.
- **Destructive** is red text on a red hairline, never a red fill, and always
  confirmed.
- **Primary** is `--accsolid` on `--onsolid`, one per window. Ink, not amber.
- **Elevation** is `--float`, and only something that actually floats casts it.
  In code that is `kit::float_shadow`, two casts at alpha `0x0d` 1px down over
  a 2px blur and alpha `0x14` 8px down over a 20px blur. It was heavier and the
  user called the glow excessive on 2026-09-12; keep it a hint of lift.
- **A control never sizes itself to its content.** A menu chip, its menu and a
  text field sit between a default width and a maximum and truncate what does
  not fit. A choice value truncates its word at 180 and keeps its art and arrow
  at fixed sizes. A long value can never squeeze the label that names it.
- **The panel re-reads the theme every frame.** `Render` takes both the palette
  and the `Kit` fresh, so changing the accent repaints the open surface at
  once. A cached `Kit` is how half a panel kept the old accent.
- **Separation** is a `--sep` hairline, suppressed beside any washed row so it never
  cuts a state in half.
- **Errors** never show a raw error string. No errno, no status code, no stack. Say
  what happened and what the user can do.
- **A group arrives with its head.** Scrolling to the first row of a group
  reveals that group's masthead too: `SelectionScroll::follow` takes the head
  as a lead item and scrolls up to it unless the row would leave the viewport.
  A page that stops scrolling with a head half cut off is a bug.
- **Live values** show the moment a query answers, a row never waits for the next
  poll tick, and the spinner appears only when the answer is late.
- **Busy** is the spinner, alone in a value cell and beside a caption everywhere
  else. Text never animates.

## Leaving a changed card

Locked 2026-09-13. There is no Save row, no autosave and no inline draft: a card
holds its changes while it is open, and leaving it is what decides them.

Esc on a changed form card turns the hint bar into the question. The bar is a
plain ink lift, ink at `Alpha::Wash` over the hint bar, with the question in the
ListName style in ink and nothing on its edge. `↵` save is in `success` and `esc`
discard in `danger`, each key chip edged in its own hue at `Alpha::Veil`.

Any other key closes the question and does its normal job. A required empty
field blocks with a sentence in the bar, and `↵` goes to that field. Esc twice
discards.

The Shortcuts and Hotkeys editors are form cards that ask the same way. Their
crumb is fixed when the card opens, `secondary+↵` asks at once and saves when
nothing blocks, and while the save runs the question stays up beside the busy
`saving` hint. A failed save keeps the card and its question.

## Picture choices

Locked 2026-09-13 on the pictures page. All 28 selects open a card of picture
tiles, and the markup is identical to the locked `pics.mjs` output. The core
tools' five selects (Action, App reference, Browser reference, Plugin and the
hotkey's Action) open the same card at depth 2 of the tools deck.

- The tile is 116 px tall with radius 9: an inset `hairline_strong` ring at
  rest, the band fill when highlighted with no ring.
- The art box is 112 x 70, or 104 x 65 at four per row and 88 x 55 at five.
- The name is 13.5 px (12.5 at five per row) in `soft`, or `ink` when
  highlighted, clamped to two lines. The detail after " · " is 11.5 px in
  `faint`, or the band's `soft` when highlighted, truncated.
- The tick sits top right at 12 px, in the accent at rest and `ink` on the
  band.
- The waiting tile has a hairline ring, a 44 px spinner in the art box and the
  name in `faint`.
- Up to 6 options show 3 tiles per row, up to 8 show 4, and more show 5. Two
  rows are visible, then the card scrolls, and arrows move.
- The layout snaps to the ladder: the grid gap is `SPACE_CELL` at three and
  four per row and `SPACE_INSET` at five, the gap between art and words is
  `SPACE_INSET`, `SPACE_SNUG` at five per row, and the name and detail lines
  have no gap.

The band marks the highlight, and the tick marks the saved value. The tick is
left out while adding, for a field the saved entry did not have, and for a
hotkey action once its plugin changed. An option without a picture gets a
letter tile. Pictures are
drawn in ink by `qol_gpui::pictures` from the spec grammar in
`docs/plugin-contract.md`. A picture never shows a key the user binds, and a
system default is the device drawn on a screen. The Bone desktop picture draws
with the shipped light palette, whose edge and soft differ from the canvas
literal.

The pixel reference is the design lock snapshot at
`~/.claude/projects/-media-kmrh47-WD-SN850X-Git-qol-monorepo/design-locks/settings-choice-pictures-v14/`
(`nownext/pics.mjs` sha256
`3825c20e98c7b8639b242ac84a957efd3914a481e8edf55229718ae73d0a04e1`,
`nownext/choices.mjs` sha256
`341b3b614b116ff0b8c95ec4469546a4be67fa64fa4c97b84822a9ad6e1bd345`), and the
goldens in `libs/gpui/tests/fixtures/pictures` hold it in the repo.

### Choice values

Locked 2026-09-14 as design G1, snapshotted in
`~/.claude/projects/-media-kmrh47-WD-SN850X-Git-qol-monorepo/design-locks/settings-select-row-g1/`
with `png/RowsG1.png` as the reference. A select row whose value opens a
picture card never draws a chip, because a boxed value with an arrow reads as
a dropdown.

- `SettingsChoiceValue` shows the value word, the chosen option's art in a
  56 x 35 box and an 8 x 14 arrow, `SPACE_CELL` apart. The word is
  `TEXT_BODY` and truncates at 180; the box and the arrow never change size.
- The art is the option's tile art from its card: its valid picture, else its
  letters.
- `pictures::fitted_image` draws a picture whole. Its stroke bounds are
  scaled to fit the box and centred, nothing is cropped or clipped, and lines
  at the default width render 1 px. A colour choice fills the box at radius 6.
  Letters sit on a 56 x 35 tile of the line colour at 20 percent inside a
  1 px ring at 80 percent, in 16 px SemiBold.
- At rest the word is `faint` and the arrow is `faint` at 40 percent. The art
  rests: explicit stroke colours take the line colour (`soft`), explicit fills
  become the line colour at 12 percent, and the art sits at 70 percent,
  desaturated. Mask contents keep their colours. A colour choice is exempt: a
  `swatch` keeps its own colour at full strength at rest, neither faded nor
  desaturated, because the colour is the value.
- The pointer wakes a pane row: the word turns `soft`, the art shows its own
  colours at full strength and the arrow is full. On the band the art stays
  awake with `ink` as its line colour, and the arrow is band `faint`.
- A multi-select row is a choice value too. Its word lists the chosen names,
  the part of each label before ` · `, joined by `, `, or reads `none`. With
  nothing chosen the art is the `empty` tile: a 56 x 35 ring at radius 6 in the
  line colour at 80 percent, dashed 3 on 3, with no wash. One chosen option
  shows its own art. Two or more stack the first two: the second one's art is
  fitted into 44 x 27.5 at (12, 0) at 50 percent, the box is cut away under a
  44 x 27.5 rounded rect (radius 4.5) at (0, 7.5) so the row ground shows
  through, and the first one's art is fitted into that rect in front. Letters
  in the stack sit on a 44 x 27.5 tile at radius 4.5 in 12 px SemiBold. Locked
  2026-09-14 as H2 and H6, snapshotted in
  `~/.claude/projects/-media-kmrh47-WD-SN850X-Git-qol-monorepo/design-locks/settings-last-dropdowns/`.
- ↵ on a multi-select opens the same picture card as a select. A tick marks
  every chosen tile, ↵ or a click ticks or unticks the highlighted tile and
  saves at once, and the card stays open until esc. The ↵ hint reads `tick` or
  `untick` for the highlighted tile, and the highlight opens on the first
  chosen tile.
- The Resolution and refresh row of the display Arrangement card is a choice
  value. Its word is the staged or current mode, such as `2560x1440 · 165 Hz`
  (`2560x1440` without a refresh rate), and its art is
  `display-mode:<width>x<height>`: a screen in the mode's own shape, scaled to
  fit 76 x 44 in the 96 x 60 art space, radius 4, centred, with a 6 high stand
  and a 16 wide foot. ↵ opens a picture card of the selected display's modes
  under the sub header `Size and refresh for this display.`, ticked on the
  staged mode, else the current one; choosing a tile stages that mode and
  returns to the Arrangement card. Locked 2026-09-14 as J1.
- No select opens a floating dropdown, and `SettingsSelectValue` is gone.
  `dropdown.rs` serves list item action menus only.

## Relationship to qol-theme and kit.rs

The theme is real code, not a mood board. Where it differs from the token table
above, both sides are named here so the delta is visible instead of argued about.

`libs/theme/src/lib.rs` owns the palette as `SystemPalette`, built from
`LIGHT_REFERENCE` / `DARK_REFERENCE`. That is the SSOT for colour; never introduce
a colour literal in `libs/gpui`. The same file owns the ground table as `Grounds`:
the six grounds plus band hover, each with its eight roles and its halo.
`libs/theme/src/css.rs` writes every token to the web page too: the text styles
as `--qol-text-*` and `.qol-text-*` classes, spacing, radii, motion, the alpha
ladder, opacities, the line, the status dot, both shadows and the focus ring,
plus IBM Plex Mono served from `libs/gpui/assets/fonts`.
`desktop_theme_preview(mode, accent_key)`, `web_theme_preview(theme_key)` and
`accent_swatch(mode, accent_key)` describe a theme for the theme and accent
pictures without building a live surface.

Known deltas from V2, each one a decision waiting to be made rather than a bug to
fix silently:

- **Dark surfaces are cool, V2 is warm.** `DARK_REFERENCE.night_900` is `0x14181f`,
  a blue-grey; V2 asks for `#16171a`.
- **The dark accent differs.** `orange_400` is `0xffb454`; V2 asks for `#e0ac3f`.
- **Light is already close.** `night_900` `0xfaf7f0` against V2's `#fffefb`.
- **The gamepad face hues have no home yet.** `SystemPalette` carries the
  solids and `WashPalette` carries the translucent tokens, built as `CssRgba`
  pairs whose `packed()` yields the `0xRRGGBBAA` word gpui wants. The
  accent-derived washes follow whichever accent is active.

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
- A gpui repeat animation repaints the whole window every vsync, so no surface
  runs one. Busy and the live dot tick from the shared `ActivityAnimation`
  timer clock on `MOTION_LOOP`, which is the only running motion allowed.

## Verifying

- Read the deck beside the running surface, same theme, same size.
- Contrast: body text clears 4.5:1 and every focus indicator and state marker clears
  3:1, in both themes. Compute it, do not eyeball it.
- Colour-blind check: no state is signalled by hue alone. Every semantic colour is
  paired with a shape, a position or a word.
- Hit targets are at least 24px, counting the row rather than the glyph inside it.
- Grep the surface for colour literals and for sizes that are not on a ladder, and
  the settings scope for rem spacing helpers and off-ladder gaps and paddings. All
  should return nothing.

## Changing the theme

The theme is versioned. This is V3. V2 was agreed 2026-08-21, after an audit that found
the focus ring defined six times and invisible in all six, a height class that set
a different height than its name, a state that existed only in the light theme, and
twenty distinct type sizes across two rival scales.

V2.1, agreed 2026-09-05: the spacing ladder was added and the settings register was
unified - page body, label group, message, count chip, keycap, hint bar and
dropdown insets each have one recipe shared by plugin panels and the core tools.
V2.1 also names the single focus owner for settings surfaces (R6), after a core
tool reopened from the launcher lost its selection to a second focus path.
V2.1 also adds R7, one progress cue, after the PointZerver pairing code row
spelled loading in text forever while every other row spun.

V2.2, agreed 2026-09-13: grounds, cards at any depth, the save question and
picture choices, locked on the canvas at
https://claude.ai/code/artifact/215304ee-6161-4de9-a6d1-c38f377d3b81.

V2.3, agreed 2026-09-14: a select row that opens a picture card shows its word, the chosen picture fitted whole and an arrow, quiet at rest and awake on the highlight and under the pointer, locked on the canvas at https://claude.ai/code/artifact/215304ee-6161-4de9-a6d1-c38f377d3b81 as design G1.

V2.4, agreed 2026-09-14: every select row is a choice value, multi-selects and display modes included: a dashed empty tile when nothing is chosen, two stacked pictures when several are, a card with a tick on every chosen tile, and display modes drawn as screens in their own shape, locked on the canvas at https://claude.ai/code/artifact/215304ee-6161-4de9-a6d1-c38f377d3b81 as H2, H6, J1 and the multi-select card.

V2.5, agreed 2026-09-14: a colour choice keeps its own colour at rest instead of greying out with the other pictures, asked for by the user after V2.4 shipped.

V3, agreed 2026-09-25 on the "Theme, now and after" canvas (sixteen boards): keys
named once and drawn icons, eleven text styles, square windows, no coloured side
lines (law 6), the kit parts every window is built from (window, heading,
highlight, notice, chip, empty), one motion ladder, one Busy and one live dot,
one hover, the depth ladder, the web page generated from the same tokens,
unfocused grounds, and a scroll cue in every list, each held by a guard test
with no recorded exceptions.

A change to any token, ladder or state definition is a new version: update this
file first, then the deck, then the code, in that order. A change that lands in one
surface only is not a theme change, it is drift.
