---
name: qol-plugin-gpui-surfaces
description: Use when giving a qol plugin a native gpui surface - a settings panel, toast, or other summonable window - instead of (or beside) the web auto-config page. Covers the shared qol-gpui surface/dropdown kit, contract-driven settings panels, launcher integration, daemon routing with browser fallback, and the placement/focus/dismiss invariants that make panels behave. Reference implementation: qol-shot.
---

# qol-plugin-gpui-surfaces

qol plugins feel "installed" when their UI is native: summoned from the
launcher, centered on the active monitor, keyboard-first, gone on ESC.
The shared kit in `libs/qol-gpui` makes that a wiring job, not a
windowing project. **Never hand-roll plugin windows; extend the kit.**
qol-shot is the reference implementation end to end.

## The shared kit (libs/qol-gpui)

| Piece | File | What it owns |
| --- | --- | --- |
| `Surface` builder | `surface.rs` | Window creation for `SurfaceKind::Toast` (PopUp, unfocused, corner-anchored, optional timeout) and `SurfaceKind::Panel` (Normal, focused, monitor-centered) |
| `SurfaceDismisser` | `surface.rs` | Close from anywhere (key handler, click, timer). Deferred out of event dispatch - see invariants |
| `settings_panel::open` | `settings_panel.rs` | The complete contract-driven settings panel: row mapping, keyboard flow, tray-API persistence, `SettingsPanelPalette` styling. Plugins pass `SettingsPanel { plugin_id, contract, heading }` plus an in-process query provider - nothing else |
| `Dropdown` + `DropdownStyle` | `dropdown.rs` | Keyboard option picker built on `ScrollList`; caller decorates labels (e.g. `[x]` marks for multi-select) and paints it via `deferred(anchored(...))` so it overlays later rows |
| `ScrollList` | `scroll_list.rs` | Selection + scroll-window state shared with launcher/removeapp |

`Surface::show_focused` is for interactive panels (`Render + Focusable`),
`Surface::show` for passive toasts. Both hand the view a
`SurfaceDismisser`.

## Settings panel = contract, not new UI truth

A plugin's gpui settings panel derives everything from the existing
`qol-config.toml` contract - the same single source the web auto-config
renders. The entire panel lives in the kit
(`qol_gpui::settings_panel`); a plugin wires it in one call:

```rust
qol_gpui::settings_panel::open_from_async(
    SettingsPanel { plugin_id, contract, heading: "Alt Tab Settings" },
    tracker.clone(),
    |query| ...,   // in-process query provider; |_| Vec::new() if none
    &cx,           // AsyncApp; wraps cx.update and flattens both Results
)
```

From a daemon command loop use `open_from_async` (one `Result` to match
for the browser fallback); `open(panel, &tracker, &provider, cx)` is the
same entry for code already holding `&mut App`.

Do not re-implement rows, key handling, or persistence per plugin -
extend `settings_panel.rs` instead. What the kit module guarantees:

1. Values load via `GET /api/plugins/{id}/config` on the tray
   (127.0.0.1:42700), falling back to the plugin's `config.json` only
   when the tray is unreachable; `resolve_config` merges them over the
   contract.
2. `ResolvedField` kinds map to row controls: boolean → toggle (space),
   select → dropdown (enter), string_array with `options` →
   multi-select dropdown, number → typed edit with min/max clamp,
   string/string_array → text edit, color → hex text edit with a live
   swatch (6-digit hex, optional `#`, invalid input rejected on
   commit). Unsupported kinds (object maps, ...) are skipped; the web
   page still shows them.
3. Query-backed selects (`query = "..."` on a select) resolve options
   **in-process** through the provider closure - the panel runs inside
   the plugin, so it calls the same provider the daemon uses for the
   tray query, no socket hop.
4. Every change saves immediately by PUTting **row values merged over
   the loaded config** to `PUT /api/plugins/{id}/config`. No apply
   button. Merging (not rebuilding from rows) is load-bearing: fields
   the panel skips (object maps, ...) must survive a save, while row
   fields still self-heal stale values. NEVER write `config.json`
   directly as the primary save: those files are materialized artifacts
   the tray regenerates from its profile scope store at boot, so direct
   writes silently revert on restart (and a partial file in the
   installs root shadows the whole canonical config, because
   first-readable-wins). File write is the offline fallback only; the
   boot-time config drain merges it back into the store.
5. Whole numbers serialize as JSON integers, and `qol-config`
   canonicalizes whole floats at load as the backstop - a `6.0` in a
   stored config once made a `usize`-typed plugin config fail to parse
   ENTIRELY, silently reverting every setting to compiled defaults.
6. Rows scroll when the contract is taller than the monitor; selection
   stays visible, so keyboard-first holds on any screen size.
7. Colors come from `qol-theme`'s `SettingsPanelPalette`
   (`settings_panel_runtime()`) - every plugin panel looks the same.

Contract field capabilities (options on string_array, query-backed
selects) are documented in `qol-project:qol-shared-libs`.

## Wiring checklist for a plugin

1. **Settings action** in `plugin.toml` (`kind = "settings"`). qol-tray
   auto-exports a launcher entry (`<Name> Settings`) for every installed
   plugin with one - no per-plugin launcher code.
2. **Daemon routes the action** to the panel: single-binary daemons
   receive every action on the socket, so the settings branch calls
   `settings_panel::open_from_async(panel, tracker, provider, &cx)` and
   **falls back to the browser settings URL on `Err`** - a headless or
   broken gpui context must not strand the user.
3. **Queries the contract references** are declared in
   `qol-runtime.toml` and answered by the daemon
   (`ReadResult::HandledWithData(json)`), so the web UI gets the same
   dynamic data over `GET /api/plugins/<id>/queries/<name>`.
4. **Keyboard-first**: up/down navigate, space toggles, enter activates
   (opens dropdowns / begins edits / commits), typing a digit starts a
   number edit directly, ESC closes innermost-first (edit → dropdown →
   panel). Mouse is secondary.

## Invariants (violations are bugs)

- **Panels pick the runtime-owned active monitor** -
  `MonitorTracker::snapshot_monitor()`, which consumes qol-tray's
  `pick_active_monitor` decision. Never re-derive from raw focus or
  cursor indices (`snapshot_monitor_focus_first` pins panels to the
  last-focused window's monitor). Toasts use `snapshot_cursor` corners.
- **Panels reveal only after placement settles.** Muffin places
  WM-managed Normal windows itself; `Surface` maps the window painting
  nothing, asserts the origin, then reveals (plus a short post-reveal
  reassert). Don't bypass the gate - a visible map-then-jump is the
  failure mode it exists to kill. The kit suffixes every window title
  with a per-open sequence number because the origin assert looks
  windows up by title: a reused title can match a lingering previous
  window and leave the new one wherever the WM dumped it.
- **Interactive surfaces are `WindowKind::Normal`** on Linux; PopUp maps
  to a non-focusable NOTIFICATION and keystrokes leak to the terminal.
- **Window closes are deferred.** `SurfaceDismisser::dismiss` runs the
  close via `cx.defer`; a re-entrant `WindowHandle::update` from inside
  that window's own event dispatch fails silently.
- **State colors come from the theme** (`state_on`/`state_off` etc. in
  the palette structs). No literal colors in surface code - a qol-theme
  test enforces this.

## Verifying

`cargo test -p <plugin>` covers the pure row/intent/merge logic
(table-driven). Visual and focus behavior needs a live compositor:
Recompile via qol-tray, then exercise cold first-show, ESC, and
multi-monitor centering. Runtime repros belong in a guest VM
(`qol-project:qol-dev-environments`); interactive panel clicking is not
CLI-automatable today, so keyboard flows are the testable surface.

## gpui specifics

Framework-level patterns and gotchas (focus, key handling, deferred
elements, testing) live in `qol-langs:gpui-conventions`.
