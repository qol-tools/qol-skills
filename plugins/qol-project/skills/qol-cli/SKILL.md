---
name: qol-cli
description: Use when answering questions about `qol` CLI commands or changing `tools/qol-cli` behavior. Stable ownership model only; command facts come from `qol --help`, never from memory.
---

# qol CLI

Use this when you need the `qol` CLI ownership model, source-of-truth paths, or rules for answering command questions.

## Source Of Truth

- `qol --help`
- `tools/qol-cli/src/main.rs`
- `tools/qol-cli/src/cli.rs`
- `tools/qol-cli/src/commands`

Do not treat this skill as a command database. A `qol-project` SessionStart hook injects current `qol --help` output into context. If that context conflicts with this skill, the hook output and source files win.

## Rules

- For exact command names, flags, or subcommands, use the current `qol --help` output.
- Before changing command behavior, inspect `tools/qol-cli/src/main.rs`, `tools/qol-cli/src/cli.rs`, and the relevant file under `tools/qol-cli/src/commands`.
- After changing `tools/qol-cli`, run `qol setup` before trusting the installed `qol` binary.

## Named build selection

Resolve named builds from Cargo workspace metadata and plugin manifests, never
from a maintained product-name list or an alias for the workspace root. Select
the owning package explicitly so duplicate binary names cannot build unrelated
packages. Preserve that package's declared development features; Cargo rejects
qualified feature flags for unselected packages. Keep whole-workspace builds
explicit in the command planner. Verify selection with a temporary workspace
containing an unrelated broken binary and with renamed package/binary fixtures.
Recheck these contracts when changing Cargo invocation or target discovery.

## Repeated staged checks

Retain a verified, detached checkout in the check-owned cache so unchanged files
keep their mtimes across staged checks. Snapshot identity must be deterministic
for the captured source HEAD and index tree. Reuse never skips checks: retain
source/index drift checks, complete staged-tree verification, hook and Git routing
isolation, and the single-owner lock. Remove ignored and untracked generated files
inside the owned checkout before reuse; rebuild a checkout with nonstandard index
flags rather than letting skip-worktree or assume-unchanged hide mutations.
Refuse an unregistered or foreign directory at the cache path.

Git owns checkout and cleanup semantics ([checkout](https://git-scm.com/docs/git-checkout),
[clean](https://git-scm.com/docs/git-clean), [commit-tree](https://git-scm.com/docs/git-commit-tree)).
Verify unchanged mtimes, changed staged inputs, contaminated cache recovery,
partial staging, and real Cargo freshness when changing this flow or upgrading
Git. Record materialization mode and duration in the existing check report.

## Ownership Model

- `qol` is the terminal CLI and owns the command parser.
- `qol dev` is a CLI workflow/dashboard that starts `qol-tray --write-mode=dev` as a child process.
- `qol dev` dashboard rows are CLI-owned status/action panes, not tray launcher commands.
- `qol-tray` exported launcher commands live separately in `apps/qol-tray/src/commands/mod.rs`.

## Dev console design rules

These are the full rule set. They are load-bearing: each one exists because the
opposite shape shipped once and drifted.

### One frame, breadcrumb sign

`draw()` renders a single bordered frame (the `qol dev` panel) and hands its
inner `Rect` to the view. The view paints its content straight into that rect via
`view_content` (lists) or a direct `Paragraph` (streams); it does NOT wrap itself
in a second box. The frame's `Sign` is the breadcrumb `breadcrumb(dash)`,
**location only** (`qol dev · <page>`, `qol dev · emu · <id>`; ancestors dim, leaf
bold) plus the global `ARMED`/`RELOADING` flag. No live status (line counts,
follow, age) in the title; that is a separate concept. A new view is a `draw_*`
that renders content into its rect.

### Page description is a dim header, not title chrome

`page_description` returns a short static blurb per view; `page_header` renders
it as a dim line at the top of the content rect (then a blank row) and returns
the shrunk rect the view draws into. Pages without a description (dashboard,
emu-detail) get the rect unchanged. Keep blurbs short so the title sign never has
to carry them.

### Ongoing activity lives in the bottom activity sign, never inline

Any long-running job the console started (reload prebuild, doctor check/fix, and
every future one) reports progress through `activity::Activity`
(`{title, phase, detail, elapsed}`), rendered as the centered compact `SignBox`
above the branch sign by `draw_activity`. A source owns its own progress state
and produces an `Activity` snapshot; `Dash::activity` picks the one to show.
Never add a second progress surface for the same job: the page body keeps showing
the last result, and a dashboard row shows at most the one-word state (`fixing`),
with step and elapsed left to the sign.

### `SignBox` is for genuine sub-panes only

The bordered+titled `SignBox` is reserved for a real nested pane inside a page
(the run.log pane in `draw_emu_detail`, the doctor details panel) and the
floating keys badge. Never use it to wrap a whole page. `Sign`, `SignBox`, and
the breadcrumb all compose the same centered tab, so signs cannot drift apart.

### Size scrolling from the rect, gap-aware

List pages window against the full inner rect via `list_capacity(area.height)`
(which divides by the item gap); the run.log pane windows against
`SignBox::capacity` for its own chrome. Never `area.height - N` arithmetic.

### One selection caret, one cursor model

Every browsable list page marks its selection with `render_util::caret(selected)`,
never a hand-rolled `"▸ "` span, and windows with `cursor_window_start` against a
per-view cursor (`cursor`, `plugin_cursor`, `emu_cursor`, `doctor_cursor`), so
↑/↓ move a pointer and read `move`/`select` in the keys HUD. `scroll_offset` is
for stream pages (logs, trace, endpoints, run.log) that have no selection. A page
picks one model, never both.

Dispatching ↑/↓ by view is an exhaustive `match` on `View` by contract. If you
extract that dispatch into a helper, enumerate the stream views by name rather
than falling back to `_`: the wildcard silently routes a future cursor page into
`scroll_offset`, and the symptom is arrow keys that appear dead. See
`qol-langs:rust-conventions`, "Exhaustive matching".

### One line per list item

Detail lines below an item are reserved for failure states; healthy items earn
exactly one line. Static facts that never change between renders (paths,
versions) belong in `qol emu doctor` or the empty state, not on every frame.

### One accent source

`draw()` derives the frame accent once (`frame_accent`: red RELOADING > orange
WORKTREE > yellow ARMED-or-BUSY > `BASE_ACCENT` green) and publishes it via
`render_util::set_frame_accent`. Green means idle, so the frame must never fall
back to it while an activity runs: `Dash::is_busy` (any live `Activity`) holds it
yellow even though starting the job consumed the arm. Every "healthy/brand green"
in any view reads `render_util::accent()`.

Never write `Color::Green` in render code. Hardcoding it splits the color source
and that element stops following the frame state. Red/yellow error and warning
semantics stay literal; only the green family routes through the accent. Status
helpers that already return `accent()` for the healthy case (`doctor_line_style`)
are the correct source for a panel that should follow the selected row's status.

`frame_accent` itself is the ONE place that must NOT read `accent()`: its
fallback is the `BASE_ACCENT` constant. Reading the thread-local there feeds the
published value back into itself and latches the previous frame's color
permanently.

### One worktree source

The persisted worktree selection lives in exactly one place: the active-worktree
marker (`qol_dev_build::tray` marker IO), shared with the web UI and the tray boot
contract. Argv is a transient directive (`<branch>` writes the marker, `--base`
clears it, absent follows it) and `Dash.worktree_selection` is transient session
intent.

Anything that builds or launches a tray binary resolves its target FROM the
marker (`marker_tray_target`); never resolve from argv or console state directly,
and never clear the marker except on an explicit `--base`. Marker writes happen
only at commit points: after a successful build right before launch (startup), or
right before spawning the successor with rollback on handoff failure (armed
reload). The prebuild never writes the marker: a build is not a commitment, and an
aborted switch must not move the persisted selection.

## Dev console testing

`testkit::render_rows` collects `cell.symbol()` only, so no existing helper can
catch a color regression. Assert color by unit-testing the pure function that
derives it (the `doctor_status` / `frame_accent` shape), not through a rendered
buffer.

## Behavioral notes

- Unknown command shape returns a usage error and appended help text.
- `qol emu` prints its own subcommand help on missing or `help` argument.
