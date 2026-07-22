---
name: qol-shared-libs
description: Use when adding functionality, dependencies, native UI, runtime contracts, or platform-specific code to any qol plugin. Requires source-driven discovery of existing shared capability owners before adding plugin-local code.
---

# Shared library check

Before adding a capability to a plugin, prove whether the workspace already owns it and decide whether the new behavior is plugin-specific or reusable.

## Discover the maintained library set

The workspace `Cargo.toml` and `cargo metadata --no-deps` own Rust membership. Directories under `libs/` are candidates, not proof that a crate is active. JavaScript/shared-asset libraries are owned by their import graph and package metadata.

For the requested capability:

1. Search `libs/` and plugin consumers by behavior/type/function names.
2. Read candidate crate roots and public re-exports, not a prose module list.
3. Inspect `cargo metadata` plus consumer manifests to understand the dependency graph.
4. Read tests/examples to verify semantics rather than inferring them from a crate name.
5. Extend an existing owner when its abstraction and lifecycle match; do not create a near-duplicate helper.

Useful discovery commands:

```bash
cargo metadata --no-deps --format-version 1
find libs -maxdepth 2 -name Cargo.toml -print
rg -n '<capability|type|function>' libs plugins
```

## Placement decision

Put code in an existing shared library when it extends that library's established capability contract and does not introduce plugin-specific policy.

Create or expand a shared capability when independent consumers need the same semantics, lifecycle, error model, and platform behavior. Similar-looking call sites are insufficient; normalize the actual contract first.

Keep code plugin-local when it expresses one plugin's domain policy, transport protocol, UI composition, or lifecycle. A dependency used by one plugin also remains in that plugin unless the capability boundary itself belongs in shared code.

If no owner exists, name the capability and its expected consumers before creating a crate. Follow `standards-evolution` when the placement rule changes workspace policy.

## Dependency rules

- Add a crate to the narrowest owning manifest.
- Scope platform-only dependencies under target-specific Cargo tables.
- Reuse workspace dependency declarations when the root manifest owns a shared version.
- Do not add a dependency merely because another plugin happens to use it; confirm the same purpose and boundary.
- Remove unused dependencies rather than preserving future intent in prose.

Shared libraries and consumers land atomically in the monorepo. Do not invent a publish/push sequence for workspace path dependencies.

## Plugin contract ownership

- `plugin.toml` owns runtime identity, actions, daemon/capability/platform declarations, menus, and release artifacts.
- `qol-config.toml`, when present, owns renderer-neutral persistent settings.
- `qol-runtime.toml`, when present, owns named actions, queries, and streams referenced by config or consumers.
- `qol-config` source owns supported field kinds, normalization, validation, and cross-validation behavior. Inspect its contract modules instead of copying the enum inventory here.
- Daemon response types and host query dispatch own payload shape. Verify both sides in source and tests.

When contract files reference each other, change them with their runtime handlers and run the canonical validator. Do not document how many validation layers happen to call it.

## Native UI and process boundaries

Before creating plugin-local GPUI components, surfaces, settings rows, app discovery, hotkey parsing, process lifecycle, daemon transport, state protocol, search, color, or other infrastructure, search the shared library set by capability. Use the library's public boundary when it exists; extend it there when multiple consumers need the same semantics.

Follow `qol-plugin-gpui-surfaces` for native settings/surface ownership and `qol-arch-code` for feature-owned platform adapters.

## Verification

Run the shared library's full tests plus every affected consumer, Clippy with warnings denied, target checks implied by consumer manifests, and `cargo run -q -p qol -- check`. A new shared API is complete only when at least one real consumer uses it and duplicate plugin-local code is removed within the scoped change.
