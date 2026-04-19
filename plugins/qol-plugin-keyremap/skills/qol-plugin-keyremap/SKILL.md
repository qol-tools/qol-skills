---
name: qol-plugin-keyremap
description: Use when working on the qol-tray key remap plugin (macOS only). Covers the CGEventTap-based daemon, four rule kinds (char/key/mouse/scroll), per-app exclusions, hot-reload, and the rule editor UI.
---

# qol-plugin-keyremap

macOS-only key, mouse, and scroll remapping plugin for qol-tray. Runs as a long-lived daemon that intercepts input via `CGEventTap` and rewrites events in real time. Edits via a Preact-based rule editor in `ui/`. Hot-reloads on `--reload`.

## Plugin Contract

`plugin.toml`:

- `runtime.command = "keyremap"` (binary name differs from `plugin-keyremap` directory name)
- `runtime.actions = { reload = ["--reload"] }`
- `[daemon] enabled = true`, `socket = "/tmp/qol-keyremap.sock"`
- Menu: `Reload Config` (action `run`)
- Platforms: `macos` only — the binary `compile_error!`s on other OSes. This predates the `qol-architecture` strategy-pattern guidance; see that skill for the preferred approach when migrating cross-platform.
- Binary download repo: `qol-tools/plugin-keyremap`, pattern `keyremap-{os}-{arch}`

`qol-config.toml`:

- `[section.general]`: `enabled` (bool), `excluded_apps` (string array of bundle IDs — preloaded with terminals + JetBrains IDEs + VS Code)
- `[section.char_rules]`: `char_rules` (`object_array`) with fields `from_mods` (string_array), `from_key`, `to_char`, `global` (bool)
- `[section.key_rules]`: `key_rules` (`object_array`) with `from_mods`, `to_mods` (string_array), `keys` (string_array), `from_key`, `to_key`, `global`
- `[section.mouse_rules]`: `mouse_rules` (`object_array`) with `from_mods`, `button` (string), `to_mods`, `global`
- `[section.scroll_rules]`: `scroll_rules` (`object_array`) with `from_mods`, `to_mods`, `global`

No `qol-runtime.toml` — actions/queries aren't referenced from config.

## Architecture

| File / Dir | Purpose |
|---|---|
| `src/main.rs` | Entry. Handles `--kill`, `--reload`, otherwise loads config and starts the tap + daemon. macOS-only `compile_error!` at top. |
| `src/config.rs` | Loads + parses `qol-config.toml` into raw rule kinds. |
| `src/remap.rs` | `resolve(raw)` translates raw config into runtime-friendly resolved rules; `diff_key_rules` reports rule conflicts on reload. |
| `src/keycode.rs` | Key-name ↔ keycode translation tables. |
| `src/tap.rs` | Owns the `CGEventTap`. `TapState` is the `Arc`-shared state the tap callback reads on every event. `start_tap`, `swap_config` for hot reload. |
| `src/app_tracker.rs` | Tracks the frontmost app's bundle ID via NSWorkspace. Used to apply per-app exclusions. |
| `src/daemon.rs` | Socket daemon protocol (Reload, Kill commands). |
| `ui/index.html` + `ui/app.js` + `ui/components/` | Preact rule editor: AppPicker, CharRules, CharSwaps, EnableToggle, ExcludedApps, KeyRules, ModChips, MouseRules, SaveBar, ScrollRules. |
| `ui/hooks/`, `ui/lib/`, `ui/schemas/` | Editor hooks and Zod-style schemas for rule validation. |

## Rule Kinds

1. **Char rules** — translate `<mods>+<from_key>` directly into an emitted character. Useful for "Cmd+Shift+1 → !" style remaps.
2. **Key rules** — translate `<from_mods>+<from_key>` into `<to_mods>+<to_key>`. The most common kind; covers Ctrl→Cmd-style swaps.
3. **Mouse rules** — apply modifier remaps to specific mouse buttons (e.g., Cmd+left-click → middle-click).
4. **Scroll rules** — apply modifier remaps to scroll gestures (e.g., Shift+scroll inverts direction).

`global = true` means the rule applies even in excluded apps. Without it, excluded-app rules never fire when that app is frontmost.

## Daemon Lifecycle

1. qol-tray starts `keyremap` at boot.
2. Daemon checks for an existing instance on the socket. If one exists, it sends `--reload` and exits.
3. New daemon: load config, resolve rules, start `CGEventTap`, start app tracker, register socket listener.
4. On `--reload`: re-read config, diff against current key rules (warning logs for behavior changes), `state.swap_config(new_resolved)` — the tap callback picks up new rules atomically on next event.
5. On `--kill` or shutdown: tap cleanup, socket cleanup, exit.

## Common Tasks

**Add a new rule kind**: extend `qol-config.toml` with the new `object_array`, add the resolved type in `remap`, handle it in the tap callback in `tap.rs`. Update the editor: a new component in `ui/components/`, new schema, register in `App.js`.

**Add per-app rules** (currently global with exclusion list): would require restructuring rules so each carries a target-app filter, not the inverse. Big refactor — not done today.

**Migrate off `compile_error!`**: per `qol-architecture`, the macOS-only `compile_error!` should be replaced with stub `Platform` impls on Linux/Windows that return `Err("not supported on this OS")`. This unblocks cross-compilation in CI matrices.

## Gotchas

- **Accessibility permission required**. macOS requires explicit Accessibility grant for `CGEventTap` to receive events. The plugin doesn't prompt — user must grant in System Settings → Privacy & Security → Accessibility, then restart the daemon.
- **`compile_error!` blocks cross-OS dev**. Anyone working on this plugin from a Linux dev box must skip this crate in their workspace `members` or accept the build failure.
- **`Arc<TapState>` clones for callback ownership**. The CGEventTap C callback can't capture environment, so `TapState` is leaked-into-static via `Arc::into_raw` patterns. Be careful when refactoring — undefined behavior is a phone call away.
- **Rule diff warnings on reload**: `diff_key_rules` reports rules that changed semantics. These are stderr warnings, not errors — they help debug "I added a rule but it doesn't fire."
- **Excluded apps preloaded with IDEs and terminals**: this is intentional. JetBrains and VS Code do their own input handling; remapping there causes weirdness like keystrokes going through twice.

## Shared library usage

- `qol-plugin-api` for daemon helpers.
- `qol-config` for config + auto-config rendering.
- No `qol-platform` (macOS-only).

## Build / Dev

- `make dev`/`make build`/`make release` exist via standard plugin Makefile.
- `cargo test` validates the contract.
- The `proptest` dev-dep is unused — leftover from earlier remap-resolver experiments.
