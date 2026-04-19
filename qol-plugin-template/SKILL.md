---
name: qol-plugin-template
description: Use when bootstrapping a new qol-tray plugin from plugin-template, or when updating the template itself. Documents the baseline structure, atomic install flow, customize checklist, and CI/CD wiring that every new plugin starts from.
---

# qol-plugin-template

`plugin-template` is the canonical starting point for new qol-tray plugins. It ships a binary-first runtime entrypoint, contract-validation test, atomic install flow, and `qol-cicd`-wired GitHub Actions. Forking this repo (or copying its files into a new repo) is the recommended way to start a new plugin.

## Plugin Contract

`plugin.toml`:

- `name = "My Plugin"` (placeholder)
- `runtime.command = "plugin-template"`
- `runtime.actions = { run = ["run"], settings = ["settings"] }`
- Menu: `Run` + `Settings`
- Platforms: `linux`, `macos`
- `[[dependencies.binaries]]` points at `qol-tools/plugin-template`

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

1. **Names**: rename `plugin-template` in `Cargo.toml`, `plugin.toml`, `.gitignore`, `Makefile`, and workflow artifact names. Keep a single source of truth — the binary name in `Cargo.toml`'s `[package].name` and the runtime command in `plugin.toml` must match.
2. **Manifest metadata**: update `plugin.toml`'s `name`, `description`, `author`, `platforms`, and `[[dependencies.binaries]]` block.
3. **Plugin behavior**: replace the `run` action body in `src/main.rs` with real logic. Move logic into modules as it grows — keep `main.rs` thin.
4. **Platform support**: trim `src/platform/` if your plugin's settings action doesn't differ by OS. Add stubs (returning typed `Err`) for any OS you don't support — see the `qol-architecture` skill.
5. **Versioning**: keep `Cargo.toml` and `plugin.toml` versions in sync. `qol-cicd`'s plugin-version workflow validates this.
6. **Daemon**: not in the template. Add `[daemon]` to `plugin.toml` and a daemon socket loop only if the plugin needs a long-running process.
7. **Settings**: add `qol-config.toml` when you need editable settings. Auto-config in qol-tray will render them. If your contract references actions/queries by name, also add `qol-runtime.toml`.

## Contract Notes

- Commands stay binary basenames only — no `.sh`, no absolute paths, no traversal.
- If `runtime.actions` is present, every executable menu action must have a mapping. Strict coverage is enforced by qol-tray on load.
- Add `[daemon]` only when the plugin actually needs a long-running process (eats memory + delays startup otherwise).
- Keep platform-specific behavior behind `src/platform/` or feature-owned platform modules — never sprinkle `#[cfg(target_os)]` through business logic. See `qol-architecture`.

## CI/CD

Three reusable workflows live in `.github/workflows/`:

- **`ci.yml`** — runs on PRs. `cargo check` + `cargo test`. Calls into `qol-cicd`'s reusable plugin-ci workflow when present.
- **`version.yml`** — wired to `qol-tools/qol-cicd`'s `plugin-version.yml`. Bumps semver from commit history, validates manifest version consistency, commits `chore(release): vX.Y.Z`, pushes the tag.
- **`release.yml`** — fires on `v*` tag push. Builds Linux + macOS binaries, attaches to the GitHub release.

The plugin-template ships with these wired correctly — don't strip them when forking. If the user forks to a private repo, they may need to update workflow permissions, but the workflow YAMLs themselves stay as-is.

## Atomic Install Flow

The Makefile's install flow uses `plugin-template.new` as a staging path so install never half-fails. After build, the new binary is moved into place atomically — no time when qol-tray sees a partial binary.

This pattern is worth preserving when customizing — keep the `*.new` rename step.

## Common Tasks

**Bootstrap a new plugin from the template**: copy the template repo (or fork it on GitHub), run through the Customize Checklist, then `make build` and `cargo test` to validate.

**Update the template**: changes here propagate by-hand to existing plugins. Be conservative — every change is a future merge cost across the plugin fleet. Prefer adding optional patterns over enforcing new requirements.

**Add a daemon to a forked plugin**: see `qol-plugin-pointz`, `qol-plugin-alt-tab`, or `qol-plugin-keyremap` for daemon patterns. The minimum is `[daemon]` in `plugin.toml`, a socket listener (use `qol_plugin_api::daemon`), and a parse_command function.

## Gotchas

- **README's "License: MIT"** is wrong — the actual `LICENSE` file is PolyForm-Noncommercial-1.0.0 to match the rest of the org. Fix when you fork (or update the template).
- **`Cargo.toml` declares `qol-tray` as git dep**, not path. That's intentional for the template (it has no fixed sibling layout). When forking into the qol-tools workspace, you may want to switch to `path = "../qol-tray"` for dev iteration speed.
- **No `qol-config` dep** in the template — adding it is part of customization. Don't be surprised if a fresh fork has no config-reading code.
- **`anyhow = "1"`** is the only runtime dep. Keep it minimal — every dep is a transitive cost.
- **`make release`** runs lint, test, version bump, commit, tag, push in one command. Read the Makefile before running it on a real plugin — it's destructive on purpose.

## Shared library usage

None at template baseline. Add `qol-plugin-api`, `qol-config`, etc. as the customized plugin needs them. Use the `qol-shared-libs` skill to decide what belongs where before adding a new direct dependency.

## Related skills

- `qol-architecture` — strategy-pattern compartmentalization for platform code (mandatory once you add multi-OS behavior).
- `qol-cicd` — the reusable workflows the template's `version.yml` and `release.yml` call into.
- `plugin-<name>-release-flow` — once your forked plugin has a release process, write a per-plugin release-flow skill. See `plugin-launcher-release-flow` and `plugin-alt-tab-release-flow` as templates.
- `qol-shared-libs` — what belongs in shared libs vs the plugin itself.
- `coding-general` — universal guidelines that apply to plugin code.
