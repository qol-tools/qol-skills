---
name: qol-plugin-template
description: Use when bootstrapping a new qol-tray plugin from plugin-template, or when updating the template itself. Documents the baseline structure, atomic install flow, customize checklist, and CI/CD wiring that every new plugin starts from.
---

# qol-plugin-template

`plugin-template` is the canonical starting point for new qol-tray plugins. It ships a binary-first runtime entrypoint, contract-validation test, and atomic install flow. Copying `plugins/plugin-template/` to a new `plugins/<id>/` directory is the recommended way to start a new plugin.

## Plugin Contract

`plugin.toml`:

- `uid = "<uuid-v4>"` - frozen identity; mint a fresh one when forking, never reuse the template's, never change it after publishing
- `name = "My Plugin"` (placeholder)
- `runtime.command = "plugin-template"`
- `runtime.actions = { run = ["run"], settings = ["settings"] }`
- Menu: `Run` + `Settings`
- Platforms: `linux`, `macos`
- `[[dependencies.binaries]]` declares where the built binary downloads from; see the template's `plugin.toml`

No `qol-config.toml` — the template ships without editable settings. Add one when your plugin needs them.

No `qol-runtime.toml` either — only required when `qol-config.toml` references named action/query tables.

## Baseline Structure

```
plugin-template/
  Cargo.toml         # cargo crate "plugin-template"
  Makefile           # standard install/dev/release/test/check/lint targets
  plugin.toml        # qol-tray manifest
  README.md
  LICENSE            # PolyForm-Noncommercial-1.0.0
  src/main.rs        # entry: parses action arg, dispatches to platform module
  src/platform/      # platform-specific settings launchers
  .github/workflows/ # ci.yml, release.yml, version.yml — see CI/CD section
```

`src/main.rs` is small (40 lines). Action handling:
- No arg or `run` → prints "Hello from My Plugin"
- `settings` → calls `platform::open_settings()`
- Anything else → eprint + exit 1

The standard `validate_plugin_contract` test sits in `#[cfg(test)] mod tests`.

## Customize Checklist

When forking the template into a new plugin, change:

1. **Identity**: mint a fresh uuid v4 into `plugin.toml`'s `[plugin] uid` and never change it after publishing. `id`, `name`, the binary name, and `runtime.command` are mutable labels. Rename `plugin-template` across `Cargo.toml`, `plugin.toml`, `.gitignore`, `Makefile`, and workflow artifact names, keeping the `Cargo.toml` `[package].name` and the `plugin.toml` runtime command in sync.
2. **Manifest metadata**: update `plugin.toml`'s `name`, `description`, `author`, `platforms`, and `[[dependencies.binaries]]` block.
3. **Plugin behavior**: replace the `run` action body in `src/main.rs` with real logic. Move logic into modules as it grows — keep `main.rs` thin.
4. **Platform support**: trim `src/platform/` if your plugin's settings action doesn't differ by OS. Add stubs (returning typed `Err`) for any OS you don't support — see the `qol-arch-code` skill.
5. **Versioning**: keep `Cargo.toml` and `plugin.toml` versions in sync. The monorepo version workflow validates this.
6. **Daemon**: not in the template. Add `[daemon]` to `plugin.toml` and a daemon socket loop only if the plugin needs a long-running process.
7. **Settings**: add `qol-config.toml` when you need editable settings. The web
   auto-config renderer will render it. To opt the settings action into the
   tray-owned native GPUI panel on supported platforms, add
   `[capabilities] gpui = true`; do not build a second plugin-local settings
   renderer. Keep the mapped platform/browser settings target as fallback. If
   the contract references actions or queries by name, also add
   `qol-runtime.toml`. See `qol-plugin-gpui-surfaces`.

## Contract Notes

- Commands stay binary basenames only — no `.sh`, no absolute paths, no traversal.
- If `runtime.actions` is present, every executable menu action must have a mapping. Strict coverage is enforced by qol-tray on load.
- Add `[daemon]` only when the plugin actually needs a long-running process (eats memory + delays startup otherwise).
- Keep platform-specific behavior behind `src/platform/` or feature-owned platform modules — never sprinkle `#[cfg(target_os)]` through business logic. See `qol-arch-code`. For symbol/import hygiene that prevents dead_code-on-other-platform errors under `-D warnings`, see `qol-arch-cross-platform`. For CI matrix and `RUSTFLAGS=-D warnings` enforcement, see `qol-arch-cicd`.

## CI/CD

The template is a workspace member of the monorepo; there are no per-plugin workflows.

- The monorepo `ci.yml` covers it via affected-crate planning (fmt, clippy `-D warnings`, tests, ubuntu + macos).
- Releases are tag-driven release units (`<plugin-id>-vX.Y.Z`); see `qol-tray-release-flow`.

## Atomic Install Flow

The Makefile's install flow uses `plugin-template.new` as a staging path so install never half-fails. After build, the new binary is moved into place atomically — no time when qol-tray sees a partial binary.

This pattern is worth preserving when customizing — keep the `*.new` rename step.

## Common Tasks

**Bootstrap a new plugin from the template**: copy the template repo (or fork it on GitHub), run through the Customize Checklist, then `make build` and `cargo test` to validate.

**Update the template**: changes here propagate by-hand to existing plugins. Be conservative — every change is a future merge cost across the plugin fleet. Prefer adding optional patterns over enforcing new requirements.

**Add a daemon to a forked plugin**: see `qol-plugin-pointz`, `qol-plugin-alt-tab`, or `qol-plugin-keyremap` for daemon patterns. The minimum is `[daemon]` in `plugin.toml`, a socket listener (use `qol_plugin_api::daemon`), and a parse_command function.

## Gotchas

- **Shared crates come in as workspace deps** (`qol-plugin-api.workspace = true`); no git or path dep juggling.
- **No `qol-config` dep** in the template — adding it is part of customization. Don't be surprised if a fresh fork has no config-reading code.
- **`anyhow = "1"`** is the only runtime dep. Keep it minimal — every dep is a transitive cost.
- **`make release`** just runs `cargo build --release`; versioning and tagging are owned by the monorepo release pipeline.

## Shared library usage

None at template baseline. Add `qol-plugin-api`, `qol-config`, etc. as the customized plugin needs them. Use the `qol-shared-libs` skill to decide what belongs where before adding a new direct dependency.

## Related skills

- `qol-arch-code` — strategy-pattern compartmentalization for platform code (mandatory once you add multi-OS behavior).
- `qol-arch-cross-platform` — symbol/import hygiene preventing dead_code-on-other-platform under `-D warnings`.
- `qol-arch-cicd` — CI/release workflow contract: matrix builds derived from `plugin.toml` `platforms`, `RUSTFLAGS=-D warnings` everywhere, sibling-checkout parity for path-deps.
- Releases: every plugin under `plugins/*` with a `plugin.toml` is a release unit covered by `qol-tray-release-flow`; no per-plugin release skill is needed.
- `qol-shared-libs` — what belongs in shared libs vs the plugin itself.
- `qol-plugin-gpui-surfaces` — contract-driven native settings ownership,
  capability routing, shared components, and fallbacks.
- `coding-general` — universal guidelines that apply to plugin code.
