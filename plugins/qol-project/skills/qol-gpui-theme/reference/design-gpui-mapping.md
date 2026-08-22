# Design ↔ GPUI mapping registry

Single source of truth linking the Bone & Amber design deck to the GPUI implementation.
One row per shared constant: the design source (deck token or class), the GPUI source (symbol, file),
the current GPUI value, and the delta status.

Status meanings:
- `match` - the design and the code already agree.
- `delta` - values differ; the change direction is named in Notes.
- `missing in code` - the design element has no implementation yet.
- `missing in design` - the code has behavior the design does not specify.

Design sources are classes and tokens in
`/Users/kaho/repos/private/qol-skills/plugins/qol-project/skills/qol-gpui-theme/reference/bone-and-amber-deck.html`.
GPUI sources are in `/Users/kaho/repos/private/qol-monorepo`.

## Foundations

| Design (deck) | Value | GPUI source | Current | Status |
|---|---|---|---|---|
| `--fs-cap` | 11.5 | `qol_theme::TEXT_NANO` | 11.5 | match |
| `--fs-sm` | 12.5 | `TEXT_MICRO` | 12.5 | match |
| `--fs-md` | 13.5 | `TEXT_CAPTION` | 13.5 | match |
| `--fs-lg` | 15 | `TEXT_BODY` | 15 | match |
| `--fs-xl` | 17 | `TEXT_TITLE` | 17 | match |
| `--h-el` | 28 | `HEIGHT_INLINE` | 28 | match |
| `--h-ctl` | 36 | `HEIGHT_CONTROL` | 36 | match |
| `--h-rule` | 48 | `HEIGHT_RULE_ROW` | 48 | match |
| `--h-row` | 52 | `HEIGHT_SETTING_ROW` | 52 | match |
| `--h-band` | 64 | `HEIGHT_BAND` | 64 | match |
| `--h-bar` | 40 | `HEIGHT_HINT_BAR` | 40 | match |
| `--r1` | 4 | `RADIUS_TIGHT` | 4 | match |
| `--r2` | 6 | `RADIUS_CONTROL` | 6 | match |
| `--r3` | 9 | `RADIUS_CARD` | 9 | match |
| `--r4` | 11 | `RADIUS_WELL` | 11 | match |
| `--mark` | 3 | `SPACE_MARK` | 3 | match |
| `--gut` | 20 | `SPACE_GUTTER` | 20 | match |
| `--padx` | 16 | `SPACE_PAD` | 16 | match |
| accent light | #b8860b | `LIGHT_REFERENCE.orange_400` | #b8860b | match |
| accent dark | #e0ac3f | `DARK_REFERENCE.orange_400` | #e0ac3f | match |
| accent ink | #8a6208 | `LIGHT_REFERENCE.accent_ink` | #8a6208 | match |
| wash selected | rgba(60,48,26,.055) | `WashPalette::light().wash_selected` | same | match |
| hairline | rgba(60,48,26,.12) | `WashPalette::light().hairline` | same | match |
| hairline strong | rgba(60,48,26,.2) | `WashPalette::light().hairline_strong` | same | match |
| fill / fill2 | .055 / .095 | `fill_hover` / `fill_resting` | .055 / .095 | match, names swapped in the deck |
| focus ring | 1.5 + 4 | `FOCUS_RING_EDGE` / `FOCUS_RING_HALO` | 1.5 + 4 | match |

## Settings panel

| Design (deck) | Value | GPUI source | Current | Status |
|---|---|---|---|---|
| window width (Key Remap) | 760 (`.w760`) | `PANEL_WIDE_WIDTH` | 680 | delta, design wider; code picks 680/520/420 by content |
| rail width | 196 (`.rail`) | `PANEL_RAIL_WIDTH` | 190 | delta, 6px |
| rail background | `--side` #f5f2eb | `system.surface_rail` | #f5f2eb | match |
| rail text | `--sidetx` #57534a | `system.text_rail` | #57534a | match |
| rail caption | none (removed from deck) | `view.rs` `"SECTIONS"` child | present | delta, remove in code |
| rail item height | `--h-ctl` 36 | `PANEL_RAIL_ITEM_HEIGHT` | 36 | match |
| rail item radius | `--r2` 6 | `RADIUS_CONTROL` | 6 | match |
| rail item marker | 3px, left -6, full height | `kit::row_state` bar | 3px, left 0, top/bottom 8 | delta, full-height + -6 in design |
| band height | `--h-band` 64 | `PANEL_BAND_HEIGHT` | 64 | match |
| band background | `--side` | `render_band` `rail_bg` | same | match |
| band title | 18 semibold | `TEXT_TITLE` 17 semibold | 17 | delta, 1px |
| count chip | 28, r2 6 | `render_count_chip` | 28, r2 6 | match |
| filter height | `--h-ctl` 36 | `PANEL_FILTER_HEIGHT` | 36 | match |
| filter radius | `--r4` 11 | `RADIUS_WELL` | 11 | match |
| filter margin | none (flush) | `PANEL_FILTER_MARGIN` | 20 | delta, code insets 20 |
| group header height | `--h-ctl` 36 | `PANEL_GROUP_HEADER_HEIGHT` | 36 | match |
| group header text | plain uppercase, `--ink-2` | `render_group_header` | accent-ink + underline + mark on open section | delta, code adds accent treatment |
| row height | `--h-row` 52 | `PANEL_ROW_HEIGHT` | 52 | match |
| row radius | `--r3` 9 | `RADIUS_CARD` | 9 | match |
| row marker | full height, clipped to corner | `kit::row_state` bar | 3px, top/bottom 8 | delta, full-height clipped in design |
| row wash | `--wash` | `wash_selected` | same | match |
| disabled row | opacity .4 | `DISABLED_OPACITY` | 0.4 | match |
| toggle on | `--pos` green | `state_on` = `success` | green | match |
| hint bar height | `--h-bar` 40 | `PANEL_HINT_BAR_HEIGHT` | 40 | match |
| hint bar labels | task wording | `render_hint_bar` | generic wording | delta, wording only |
| keycap radius | `--r1` 4 | `RADIUS_KEYCAP` | 3 | delta |
| keycap text | `--fs-sm` 12.5 | `TEXT_KEYCAP` | 10.5 | delta |
| keycap font | mono | `font_mono()` | mono | match |

## qol-shot preview

Capture: `assets/qol-shot-current.png`, 406 x 292 logical.

| Design (deck) | Value | GPUI source | Current | Status |
|---|---|---|---|---|
| thumb max | 360 × 240 | `MAX_THUMB_W` / `MAX_THUMB_H` | 360 × 240 | match |
| thumb radius | 3 | none (overflow hidden only) | 0 | delta, add radius |
| circle | 46 | `CIRCLE` | 46 | match |
| circle gap | 14 | `CIRCLE_GAP` | 14 | match |
| label height | 30 | `LABEL_H` | 30 | match |
| circle shadow | `--flt` | none | none | delta, add elevation in design |
| primary circle | `--accsolid` solid | `accent_fill` tint | tinted | delta, solid primary in design |
| resting circle | `--pane` + `--edge` | `action_bg` + `action_border` | same | match |
| armed circle | accent border + tint | `action_border_selected` + `accent_fill` | same | match |
| label text | `--ink-2` | `label_text` | `text_secondary` | match |
| label content | armed action name | `PreviewControl::label` | armed action name | match |
| label position | centred under the armed control | `preview.rs` label row | centred in the panel, ignores which control is armed | delta, follow the armed control |
| control shape | circle, radius 999 | `preview.rs` action button | rounded square, small radius | delta, round the controls |
| file size | drawn at the right of the label row | not drawn | absent | delta, decide whether to add it or drop it from the deck |

## Toast

| Design (deck) | Value | GPUI source | Current | Status |
|---|---|---|---|---|
| compact width | 340 | `COMPACT_WIDTH` | 340 | match |
| compact height | 76 | `COMPACT_HEIGHT` | 76 | match |
| tone bar | 3, radius 2 | `toast_root` tone bar | 4, square | delta |
| title weight | 600 | `render_compact` | 500 | delta |
| message size | `--fs-sm` 12.5 | `TEXT_CAPTION` | 13.5 | delta |
| corners | plane via `.s` (0) | `rounded_none()` | 0 | match |
| tone colors | `--pos` / `--wrn` / `--neg` | `success` / `warning` / `danger` | same | match |

## Launcher

Read off a host capture, not off the source, so the rows below say what the window
does rather than what a constant holds. Open `launcher/src/ui/layout.rs` to name the
symbols behind the two deltas.

| Design (deck) | Value | GPUI source | Current | Status |
|---|---|---|---|---|
| window width | 500 | `WINDOW_WIDTH` | capture is 504 wide | match within the capture margin |
| header height | 42 | `HEADER_HEIGHT` | query line is the header | match |
| row height | 32 | `ROW_HEIGHT` | nine rows fit the captured height | match |
| visible rows | 8 | `MAX_VISIBLE` | capture shows 9 | delta, or the capture is unclipped |
| query header | the query line is the header, no separate label | `layout.rs` | same | match |
| count | right of the query, tabular | `layout.rs` | same | match |
| icon slot | 23 square, `--r1` 4 | `layout.rs` | same | match |
| kind column | right-aligned, `--fs-sm` 12.5, mono | `layout.rs` | same | match |
| row selection | plane lift, no accent marker | `layout.rs` | wash plus an amber stub at the window edge | delta, drop the stub or add it to the deck |
| matched letters | not specified | `layout.rs` | highlighted in accent, bold | missing in design |
| hint bar | open / reveal / dismiss | `layout.rs` | open / mode / dismiss | delta, wording |
| no-matches state | the query bar on its own, no message and no hint bar | `layout.rs` | not captured yet | unknown |
| unqueried state | the query bar on its own | `layout.rs` | placeholder, 0 / 0, plus an empty body strip | delta, drop the strip |

## Alt-tab picker

| Design (deck) | Value | GPUI source | Current | Status |
|---|---|---|---|---|
| card width | 220 x scale | `BASE_CARD_WIDTH` | not audited | unknown |
| card scale | 0.5 to 2.5 | `MIN_CARD_SCALE` / `MAX_CARD_SCALE` | not audited | unknown |
| preview aspect | 16:9 | `picker/layout.rs` | not audited | unknown |
| card border | 1px hairline, square corners | `picker/layout.rs` | not audited | unknown |
| card selection | amber ring as a shadow, so nothing reflows | `picker/layout.rs` | not audited | unknown |
| label strip | attached to the card, height from font size | `picker/layout.rs` | not audited | unknown |
| scrim | rgba(10,10,13,.58) | `picker/layout.rs` | not audited | unknown |
| hint strip | 48, three bindings, centred | `HOTKEY_HINTS_HEIGHT` | not audited | unknown |

## CLI sessions

| Design (deck) | Value | GPUI source | Current | Status |
|---|---|---|---|---|
| panel size | 360 x 400 | `cli-sessions/src/ui/` | not audited | unknown |
| corner margin | 16 | `CORNER_MARGIN` | not audited | unknown |
| panel corners | radius 12, one soft shadow | `cli-sessions/src/ui/` | square and flat | delta, named in the deck notes |
| band | 52 sub-band | `cli-sessions/src/ui/` | not audited | unknown |
| session row | deck geo says 44, deck markup renders 48 | `cli-sessions/src/ui/` | not audited | fix the deck first |
| status dot | 7px dot, 3px halo, four states | `cli-sessions/src/ui/` | not audited | unknown |
| failed row | subtitle takes the danger tone | `cli-sessions/src/ui/` | not audited | unknown |
| collapsed strip | 32 tall, same surface and dot | `STRIP_HEIGHT` | not audited | unknown |

## Remove app

| Design (deck) | Value | GPUI source | Current | Status |
|---|---|---|---|---|
| window size | 460 x 540 | `WINDOW_WIDTH` / `WINDOW_HEIGHT` | not audited | unknown |
| search height | 40 | `SEARCH_H` | not audited | unknown |
| app row | deck geo says 38, deck markup renders 40 | `ROW_H` | not audited | fix the deck first |
| size column | right-aligned, tabular, mono | `removeapp/src/ui/mod.rs` | not audited | unknown |
| sort order | biggest first | `removeapp/src/ui/mod.rs` | not audited | unknown |
| confirm bar | names the app, the folder count and the size | `FOOTER_H` | not audited | unknown |
| footer height | 34 | `FOOTER_H` | not audited | unknown |

## How to read a delta

1. Change the design first in the deck, because the deck is the spec.
2. Apply the same change to the GPUI symbol in the same row.
3. Update this registry row: value, status, and the note if the direction changed.
4. Rebuild the comparison view
   (`/Users/kaho/repos/private/qol-skills/plugins/qol-project/skills/qol-gpui-theme/reference/design-vs-current.html`)
   from the two columns of this table.
