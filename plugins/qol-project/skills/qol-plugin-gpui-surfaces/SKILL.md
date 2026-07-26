---
name: qol-plugin-gpui-surfaces
description: "Use when giving a qol plugin a native gpui surface - a contract-driven settings panel, toast, picker, or other summonable window - instead of or beside the web auto-config page. Covers the tray-owned singleton settings host, the shared qol-gpui surface kit, capability routing and fallbacks, runtime queries/actions, and placement/focus/dismiss invariants."
---

# qol-plugin-gpui-surfaces

qol plugins feel "installed" when their UI is native: summoned from the
launcher, centered on the active monitor, keyboard-first, gone on ESC.
The shared kit in `libs/qol-gpui` makes that a wiring job, not a
windowing project. **Never hand-roll plugin windows; extend the kit.**
Contract-driven settings are hosted by qol-tray; custom pickers, overlays,
and toasts remain plugin-owned.

## The shared kit (libs/qol-gpui)

| Piece | File | What it owns |
| --- | --- | --- |
| `Surface` builder | `surface.rs` | Window creation for `SurfaceKind::Toast` (PopUp, unfocused, corner-anchored, optional timeout) and `SurfaceKind::Panel` (Normal, focused, monitor-centered, designed-size locked) |
| `SurfaceDismisser` | `surface.rs` | Close from anywhere (key handler, click, timer). Deferred out of event dispatch - see invariants |
| `SettingsWindowHost` | `settings_panel/` | Retains exactly one settings window and implements open, focus-same-plugin, replace-with-another-plugin, and park/reveal across Escape |
| `SettingsRuntime::tray` | `settings_panel/` | Routes hosted runtime queries and actions through qol-tray's existing HTTP API |
| `settings_panel::open` / `run_standalone` | `settings_panel/` | Plugin-owned fallback entrypoints for code already running GPUI or starting a standalone GPUI app |
| `Dropdown` + `DropdownStyle` | `dropdown.rs` | Keyboard option picker built on `ScrollList`; caller decorates labels (e.g. `[x]` marks for multi-select) and paints it via `deferred(anchored(...))` so it overlays later rows |
| `ScrollList` | `scroll_list.rs` | Selection + scroll-window state shared with launcher/removeapp |

`Surface::show_focused` is for interactive panels (`Render + Focusable`),
`Surface::show` for passive toasts. Both hand the view a
`SurfaceDismisser`.

`SurfaceKind::Panel` is the single window-behavior contract for ordinary QoL
GPUI panels: the declared size is fixed against user resize/maximize, the
window is centered on the active monitor, and it remains a normal movable
task-switcher window. Mark only non-interactive top chrome with the shared
`PanelDragArea::panel_drag_area`; never put a drag listener on the whole root,
where child clicks would start window moves. Retained settings panels may
change their declared size programmatically when replacing content; the shared
surface layer must update the native size constraint with that change.

## Contract settings are host-owned

On Linux and macOS, qol-tray intercepts an action before normal plugin
dispatch when all three conditions hold:

1. The selected action has `kind = "settings"`.
2. The plugin has `qol-config.toml`.
3. `[capabilities] gpui = true` is present in `plugin.toml`.

The first eligible request starts qol-tray's hidden settings-surface process.
Later requests go to that process over its singleton socket. One GPUI
`Application` and one `SettingsWindowHost` own the visible window:

- The same plugin request focuses the retained window.
- A different plugin request replaces the root view in that window.
- Escape parks the native window unmapped and pauses live queries; the next
  request recenters and reveals that same window before resuming queries.
- qol-tray stops the host during orderly shutdown and before restarting GPUI
  processes after an accent change.
- The shared daemon listener arms the host-death watchdog, so a tray crash or
  orphaned child cannot leave the settings host resident.

Do not add a plugin ID switch to the host. It loads the manifest and contracts
from the resolved plugin root, derives the heading from the manifest, and uses
the minimum declared query poll interval. A new contract-driven panel opts in
through metadata and contracts only.

Windows and host-start failures continue through the plugin's normal
daemon/runtime settings target. A host that starts but cannot load or render a
panel opens the web settings URL. Keep that fallback path working; native
settings must never strand a headless or unsupported environment.

## Settings panel = contract, not new UI truth

A plugin's gpui settings panel derives everything from the existing
`qol-config.toml` contract - the same single source the web auto-config
renders. The host builds `SettingsPanel { plugin_id, contract, heading }`
and `SettingsRuntime::tray(plugin_id)`; plugins do not wire a second normal
settings window.

Use `run_standalone` only for a native runtime fallback that owns its own GPUI
application. From an existing plugin GPUI daemon, use `open_from_async` and
retain a browser fallback on `Err`. These are fallbacks or direct plugin entry
points, not the normal tray settings route.

Do not re-implement rows, key handling, or persistence per plugin -
extend `settings_panel/` instead. What the kit module guarantees:

1. Values load via `GET /api/plugins/{id}/config` on the tray
   (127.0.0.1:42700), falling back to the plugin's `config.json` only
   when the tray is unreachable; `resolve_config` merges them over the
   contract.
2. `ResolvedField` kinds map to row controls: boolean → toggle (space),
   select → dropdown (enter), string_array with `options` or `query` →
   multi-select dropdown, number → typed edit with min/max clamp,
   string/string_array → text edit, color → hex text edit with a live
   swatch, status → query-backed shared `StatusIndicator`, action →
   dispatchable row, and list → query-backed live rows. Query-less actions
   render as commands, never as a false `[off]` state. Query-backed actions
   may use `label_map` keys `true` and `false` for semantic state labels;
   semantic states stay neutral instead of inheriting boolean on/off colors.
   Unsupported kinds (object maps, ...) are skipped; the web page still shows
   them. `show_when` is evaluated from the current controller value by the
   shared row model; hidden rows leave both rendering and keyboard navigation
   immediately when that value changes. Query-backed option objects may carry
   an optional RGB `accent`; shared renderers preserve that generic decoration,
   while the producing domain owns its meaning. Never teach `qol-gpui` about
   provider, device, session, or tool identities.
3. All query-backed controls use the shared `SettingsRuntime`. Hosted panel
   persistence uses the tray config endpoint, while `SettingsRuntime::tray`
   sends queries and actions through the existing HTTP and action paths. If a
   daemon owns mutable runtime state (discovery, pairing, connection health),
   it remains the only hardware owner. A plugin-owned fallback adapter must
   call that daemon rather than re-running hardware logic in the GPUI process.
   Contract seeds and stored values render immediately; live options and rows
   merge through the runtime poll after the first frame. Slow IPC never runs in
   first-frame construction or occupies GPUI executor workers. The executor
   boundary is canonical in `qol-langs:gpui-conventions`.
4. Runtime activity presentation belongs in the contract, never plugin UI.
   Action and list fields reuse `active_query`, `active_value_from`, and
   `active_label`; shared renderers own polling and presentation. GPUI uses the
   shared `qol_gpui::StatusIndicator`, and plugins add no local animation or
   polling state. Set `variant = "toggle"` when an action's active query is a
   stable on/off state; shared renderers then show the colored binary state
   without presenting it as ongoing work. Reserve the default active spinner
   for operations that are actually in progress. A successful action refreshes
   its `active_query` immediately. The daemon must acknowledge only after the
   mutation completes. When that acknowledgement carries a boolean at
   `active_value_from`, the tray preserves the payload and the shared renderer
   applies it directly; otherwise it queries immediately. Periodic polling is
   only the external-change backstop. Rearm that backstop from action
   completion so a pre-action or propagation-stale read cannot overwrite the
   authoritative result.
5. List row actions use `row_action` / `row_actions` in contract order. The
   first action whose `when` field is truthy is the primary action; Enter on an
   active list row dispatches it, interpolates its `input` from the row, and
   shows the shared spinner until the query refreshes. When multiple actions
   are visible, Space, Right, or the row action affordance opens the shared
   `Dropdown`; Up/Down select, Enter dispatches, and Escape/Left returns to the
   list. This mirrors the web `SearchableActionList` primary-action plus
   `ActionMenu` contract. Wire payload-bearing adapters with
   `SettingsRuntime::with_input_action`; never decode row data or build action
   menus in plugin-specific GPUI code.
6. Every change saves immediately by PUTting **row values merged over
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
7. Whole numbers serialize as JSON integers, and `qol-config`
   canonicalizes whole floats at load as the backstop - a `6.0` in a
   stored config once made a `usize`-typed plugin config fail to parse
   ENTIRELY, silently reverting every setting to compiled defaults.
8. Rows scroll when the contract is taller than the monitor; selection
   stays visible, so keyboard-first holds on any screen size.
9. Colors come from `qol-theme`'s `SettingsPanelPalette`
   (`settings_panel_runtime()`) - every plugin panel looks the same.
10. Multiple contract sections open through one shared section menu. Section
    labels and descriptions come from the contract; Enter or Right opens a
    section. Inside a section, Left returns to the section menu unless the
    selected control owns horizontal adjustment: number and select rows keep
    Left/Right for their values. Escape is the universal back action, and
    Escape from the section menu dismisses the panel. Plugins do not create
    local category cards or navigation state.

Contract field capabilities (options on string_array, query-backed
selects) are documented in `qol-project:qol-shared-libs`.

## Wiring checklist for a plugin

1. **Settings action** in `plugin.toml` (`kind = "settings"`). qol-tray
   auto-exports a launcher entry (`<Name> Settings`) for every installed
   plugin with one - no per-plugin launcher code.
2. **Native opt-in** via `[capabilities] gpui = true`. This capability covers
   hosted contract settings as well as the existing GPUI lifecycle behavior.
3. **Config contract** in `qol-config.toml`; do not create a second settings
   schema or plugin-local renderer.
4. **Queries the contract references** are declared in
   `qol-runtime.toml` and answered by the daemon
   (`ReadResult::HandledWithData(json)`), so the web UI gets the same
   dynamic data over `GET /api/plugins/<id>/queries/<name>` and the hosted
   panel reaches it through `SettingsRuntime::tray`.
5. **Fallback target** remains valid for unsupported platforms or host-start
   failure. It may open the web settings URL or use the shared standalone
   panel; never silently do nothing.
6. **Keyboard-first**: up/down navigate, space toggles, enter activates
   (opens dropdowns / begins edits / commits), typing a digit starts a
   number edit directly, ESC closes innermost-first (edit → dropdown →
   panel). Mouse is secondary.

## Invariants (violations are bugs)

- **At most one hosted settings window is visible.** Never create a second
  `Application`, host process, or window per plugin. Same-plugin activation
  focuses; cross-plugin activation replaces; Escape parks the retained native
  window. Remove and recreate only when retention is unsupported or the native
  park operation fails.
- **The host is generic.** Eligibility comes from action kind, the config
  contract, and the GPUI capability. Rendering comes from `qol-gpui`; runtime
  work comes from existing tray routes. No per-plugin host branches.
- **Only contract settings are host-owned.** Custom pickers, transient
  overlays, and toasts keep their plugin-owned lifecycle.
- **Panels pick the runtime-owned active monitor** -
  `MonitorTracker::snapshot_monitor()`, which consumes qol-tray's
  `pick_active_monitor` decision. Never re-derive from raw focus or
  cursor indices (`snapshot_monitor_focus_first` pins panels to the
  last-focused window's monitor). Toasts use `snapshot_cursor` corners.
- **Panels reveal only after placement and fresh content settle.** Muffin
  places WM-managed Normal windows itself; `Surface` maps the real view behind
  a zero-opacity/input-passthrough native gate and asserts the origin. On Linux
  it then waits for GPUI to process a new native bounds event, render the target
  viewport at that layout epoch, and present a frame covering that render
  before restoring opacity. A render callback or requested repaint without
  the bounds/viewport proof is insufficient: X11 may still have the old
  drawable, leaving the compositor to show the previously focused app until
  the user moves the window. The GPUI-specific implementation constraint is
  canonical in `qol-langs:gpui-conventions`.
  Every live native window title must be unique because placement and focus
  helpers resolve by title; retained activations intentionally keep the same
  title and native window ID.
- **Interactive surfaces are `WindowKind::Normal`** on Linux; PopUp maps
  to a non-focusable NOTIFICATION and keystrokes leak to the terminal.
- **Window dismissals are deferred.** `SurfaceDismisser::dismiss` runs via
  `cx.defer`; a re-entrant `WindowHandle::update` from inside that window's own
  event dispatch fails silently. Destructive dismissals are one-shot. Retained
  settings dismissals stay reusable across every park/reveal cycle.
- **State colors come from the theme** (`state_on`/`state_off` etc. in
  the palette structs). No literal colors in surface code - a qol-theme
  test enforces this.

## Verifying

`cargo test -p qol-gpui` covers row, activation-decision, intent, and merge
logic. qol-tray action-executor tests cover eligibility and fallback routing.
Visual, focus, and singleton behavior need a live compositor. In an isolated
guest VM (`qol-project:qol-dev-environments`), exercise this sequence:

1. Open one eligible plugin and record the visible window ID.
2. Open it again and require a `focused` activation.
3. Open another eligible plugin and require `replaced` with the same window ID.
4. Press Escape and require the window ID to disappear from the mapped window
   list. Reopen the same plugin and require `focused`, the same window ID,
   compositor visibility, and keyboard focus.
5. Repeat the Escape/reopen cycle; a retained dismisser must not become
   one-shot after the first close.

Use `qol trace --grep SURFACE_ACTIVATION --replay` for route, dispatch, command
receipt, preparation, activation, fallback, and stop evidence. For open
latency, compare dispatch to `SURFACE_REVEAL phase=revealed`, then require
`phase=frame-ready moved=true layout_confirmed=true viewport_ready=true
fresh_frame=true content_rendered=true`, matching `expected`, `observed`, and
`rendered` sizes, `phase=revealed shown=true`, and finally `phase=ready
focus=true`. `repaint_requested=true` says only that GPUI accepted a refresh
request; it does not prove presentation. Command receipt and preparation
distinguish executor starvation from construction cost. Exercise cold
first-show, ESC/reopen, cross-plugin size changes, and multi-monitor centering
in the isolated Mint guest; never drive the developer's desktop. A headless
test cannot prove compositor behavior.

## gpui specifics

Framework-level patterns and gotchas (focus, key handling, deferred
elements, testing) live in `qol-langs:gpui-conventions`.
