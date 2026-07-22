---
name: qol-plugin-template
description: Use when bootstrapping a new qol-tray plugin from plugins/plugin-template or updating the template. Covers source-driven customization, contract identity, architecture growth, shared settings, platform adapters, and verification.
---

# qol-plugin-template

`plugins/plugin-template/` is the canonical scaffold. Its checked-out files are the source of truth for baseline layout, dependencies, workflows, Make targets, contract syntax, and validation; this skill must not duplicate that inventory.

## Bootstrap procedure

1. Copy the maintained template directory to `plugins/<plugin-id>/` without copying build output.
2. Mint a UUID only if the manifest schema uses a persistent UID. Once published, that UID is immutable.
3. Search the copied tree for template identity/placeholders and replace every occurrence deliberately. Do not rely on a remembered filename list.
4. Keep `Cargo.toml` package/binary identity, `plugin.toml` runtime command/artifact metadata, build scripts, Make targets, workflow filters, README identity, and ignore rules coherent.
5. Replace example behavior with a thin entrypoint plus ownership modules appropriate to the plugin.
6. Declare only platforms with real runtime behavior; compile unsupported adapters as typed errors where shared code requires them.
7. Add settings/daemon/runtime contracts only when the behavior needs them.
8. Run format, build, Clippy with warnings denied, plugin tests, and `cargo run -q -p qol -- check` before considering the scaffold customized.

Use `rg` over the copied directory to prove that template identity is gone and the new identity appears at every expected boundary.

## Contract rules

- `plugin.toml` owns plugin identity, runtime commands/actions, daemon metadata, capabilities, platform availability, menu, and release artifacts.
- `Cargo.toml` owns crate identity and dependencies. Versions shared with the plugin manifest must remain synchronized through repository automation.
- `qol-config.toml` exists only when editable settings exist.
- `qol-runtime.toml` exists only when config references named actions, queries, or streams, or another consumer needs the runnable contract.
- Public action IDs are compatibility boundaries; menu/config references must resolve to declared actions.
- Commands are binary basenames, never absolute paths, shell scripts, or traversal.
- The plugin test uses the shared contract-validation API selected by the workspace; copy the live template test rather than a prose snippet.

## Source growth

Keep `main.rs` limited to argument/process setup and delegation. Organize implementation by app orchestration, config, UI, named feature capabilities, and feature-owned platform adapters according to `qol-arch-code`.

Do not preserve the template's tiny flat shape after real behavior appears. Conversely, do not create placeholder directories before a capability exists.

## Optional capabilities

**Daemon:** add only for resident state, expensive initialization, or background behavior. Use the shared daemon lifecycle library, declare endpoints in the manifest, and test second-process forwarding plus shutdown cleanup.

**Settings:** prefer the host-owned contract renderer. Add `[capabilities] gpui` only when the native hosted surface is supported; mapped settings remain the fallback. Do not build a bespoke plugin-local settings window.

**Platform behavior:** put target selection in one `platform/mod.rs` per capability, scope dependencies in `Cargo.toml`, and return typed errors on unsupported targets.

**Shared functionality:** inspect workspace members under `libs/` before adding a plugin-local implementation or dependency. Follow `qol-shared-libs`.

## Updating the template

A template change is a policy change for every later plugin. Encode the standard in its owning skill first, modify the scaffold, test a freshly copied/renamed fixture, and verify the monorepo.

Do not describe propagation with a fixed list of existing plugins. Discover consumers from `plugins/*/plugin.toml` and migrate only when the user scopes that fleet change.

Nested workflow files may be scaffold artifacts while monorepo automation owns live CI/release behavior. Determine authority from repository workflow configuration and `qol-arch-cicd`; never trust the mere presence or absence of a nested workflow.

## Related skills

- `qol-arch-code` for source layout and platform compartmentalization.
- `qol-arch-cross-platform` for symbol/import hygiene.
- `qol-arch-cicd` for workspace CI/release contracts.
- `qol-plugin-gpui-surfaces` for hosted settings ownership.
- `qol-shared-libs` for dependency/capability placement.
- `qol-tray-release-flow` for release units and tags.
