---
name: qol-tray-feature-profile
description: Use when working on qol-tray's Profile feature, including profile export/import, sync providers, backups, profile UI, and plugin config or lock reconciliation.
---

# qol-tray-feature-profile

Use this when the task is specifically about the Profile feature in `qol-tray`, not general plugin-store work.

## Main Files

- `src/features/profile/core/mod.rs` handles profile export/import bundles, plugin config projection, and `plugins.lock.json`.
- `src/features/profile/sync/service.rs` builds and applies the synced profile document, manages remote state, and writes backups.
- `src/features/profile/startup.rs` migrates old config layout into `profile/` on startup.
- `src/features/profile/http/import_export.rs` exposes profile export/import HTTP endpoints.
- `src/features/profile/http/sync.rs` exposes connect, pull, push, disconnect, and backup actions.
- `src/features/profile/http/mod.rs` owns the profile HTTP state and route slice mounted into plugin-store settings.
- `src/features/plugin_store/server/settings/plugin_config_handlers/form.rs` validates plugin configs against config contracts.
- `ui/views/profile/view.js` is the Profile page.
- `ui/views/profile/actions.js` is the browser-side API layer for export, import, sync, and backups.
- `ui/views/profile/use-sync-form.js`, `ui/views/profile/use-sync-actions.js`, `ui/views/profile/use-backups.js`, `ui/views/profile/use-surface-nav.js`, and `ui/views/profile/key-router.js` split the profile UI by concrete responsibility.
- `ui/views/profile/summary.js` holds profile import/status/backup summaries used by the UI.

## Working Rules

- Keep profile behavior aligned across export, import, pull, push, and backup flows.
- Treat `profile/plugin-configs/` as the profile cache and `plugins/*/config.json` as live installed state. Export must reconcile both.
- A profile override should win for the same plugin, but unrelated installed plugin configs must still be exported.
- If an imported bundle explicitly provides `plugin_configs`, remove stale live plugin configs that are missing from that imported set.
- Startup cleanup should backfill live `plugins/*/config.json` into `profile/plugin-configs/` when the cached profile copy is missing.
- Preserve unsupported plugins in `plugins.lock.json` during import and sync so one machine does not delete another machine's platform-specific plugins.
- Preserve existing repo URLs for surviving installed plugins when the imported profile does not mention them.
- Reject wrong-typed plugin config values at validation time. Do not silently accept them just because defaults can be resolved.

## Plugin config storage trichotomy and the resolver

A plugin's persisted config is split across three scope-aware locations under `<profile>/`:

```
core/plugin-configs/<uid>.json         # shared across machines, synced
os/<bucket>/plugin-configs/<uid>.json  # OS-specific, synced cross-machine
device/plugin-configs/<uid>.json       # local-only, gitignored (*/device/)
```

Two declarations in `plugin.toml` drive routing:

- `[config.scope]` is the per-field map (`field_x = "core" | "os" | "device"`). The legacy value `"any"` parses as Core via serde alias.
- `[config] default_scope = "..."` is the plugin-level fallback for fields that have no per-field entry.

`scope_for(field)` is layered: per-field → `default_scope` → `Default::Core`.

Resolution priority chain (used by reads, writes, and the migration; do not vary):

1. **P0**: manifest declares `config.default_scope = "core" | "os" | "device"` → route the whole plugin to that scope. `Os` resolves the OS bucket via the chain below; `Core` and `Device` go to their respective dirs.
2. **P1**: `plugins.lock.json` entry has `platforms.len() == 1` → route to `os/<that>/`. Lock wins over manifest because the lock is the cross-machine truth.
3. **P2**: installed manifest has `platforms.len() == 1` → route to `os/<that>/`.
4. **P3**: no signals → stay in `core/`.

For a single-platform plugin, the OS bucket is the **declared** platform, never `current_os`. A Linux machine writing a Mac-only plugin's config still lands in `os/macos/`. This is the cross-machine recovery property.

Read semantics (`load_plugin_config_merged`): the loader reads every scope
defined by `ConfigScope` and merges according to the precedence function, with
later scopes winning on key collision. A `Device` field therefore overrides the
same key in a lower-precedence slice. An empty slice file is skipped, not
treated as an empty overlay.

Write semantics (`save_plugin_config_split`): split via declarations and write
each non-empty slice to the path resolved for that plugin/scope. Remove an empty
slice file so storage stays tidy. The write never touches another plugin's slice
path.

## Sync clone must promote an allowlist, never wipe

`SyncService::connect` never wipes the profile directory before cloning the remote. The wipe pattern deleted gitignored per-machine data (`device/`, `sync/state.json`, `sync/toggles.json`, the active marker, any unrelated local file) in one swing, which is the incident that motivated this section.

Clone the remote into a sibling staging directory, then promote only paths
accepted by `features/profile/sync/promote.rs`. Move repository metadata through
its explicit branch so subsequent git operations use the fresh remote. The
allowlist implementation and its tests own the accepted path set; do not copy
that inventory into this skill.

The promote contract has two halves:

- **Default-skip for local paths**: anything in the live profile that does NOT match an allowlist pattern is left untouched. `device/`, `sync/state.json`, `sync/toggles.json`, the active marker, and any local untracked file all survive a remote pull. There is no "delete unknown locals" branch and adding one is wrong; recover-on-conflict beats truth-from-remote here.
- **Default-skip for unknown staging files**: anything the staging clone carries that does NOT match the allowlist is silently dropped, not promoted. Defense in depth - a remote that somehow contains `malicious.sh`, `.bashrc`, a stray `device/` subtree, or a stale `sync/state.json` cannot reach the live profile.

When you extend sync to new file kinds, add them to the allowlist explicitly. Treat any "all unknown files copied through" change as a regression of the wipe-then-clone disaster this section was added to prevent.

## Migration collision policy: same-content drop, different-content `.legacy`

When a file migration moves `src` to `dst` and `dst` already exists, never silently delete `src`. Apply this three-branch rule:

- **`dst` is not a regular file**: error (something is wrong; refuse to proceed).
- **`dst` exists and is bit-identical to `src`**: remove `src` as redundant. No `.legacy` sidecar - the data is preserved at `dst` and a sidecar would be clutter.
- **`dst` exists and differs from `src`**: rename `src` to `<src_name>.legacy`. Leave `dst` untouched. A stale `<src_name>.legacy` from an interrupted prior run is replaced (renaming over it is intentional, not a bug).

This policy applies to every file migration that moves existing user data; see the migrations registered in `PreFlightRegistry::current()` for live examples. Future migrations of that shape MUST follow it. The `MigrationReport.archived` list contains only fresh src-to-dst moves; collision archives do not appear there - downstream consumers count `archived.len()` as the number of files newly placed, not the number of files touched.

## Sync conflict backups are cross-machine recovery, not local-only

Conflict backups are intentionally tracked by the synced profile repository so
a different machine can recover them through normal sync. `ensure_gitignore`
and its tests own the exact ignore patterns: device-local state, active markers,
and sync runtime state stay untracked, while backup artifacts remain eligible
for sync. If you move backups into a device-local path or ignore them, you
remove the cross-machine recovery property.

Two concerns that DO exist and that this design knowingly accepts:

- Unbounded growth: every conflict produces a new snapshot. A retention policy (`keep last N`, prune by age, or compress old) is a legitimate future change. The fix is at the producer side, not by gitignoring.
- Sensitive data: a backup may contain values the user would rather not see on another machine. Same producer-side fix - sanitize at write time, do not change the storage location.

A reviewer who flags "these backups can be committed and pushed" as a P1 is misreading the design. Direct them here.

## Review Checklist

- Does export round-trip the same effective local profile?
- Does import change both the cached profile state and the live installed state?
- Does sync output describe the shared profile without pruning unsupported remote entries?
- Does backup content match what push would upload?
- Does a reload after import or pull leave `plugins.lock.json` and sync output consistent?
- Does config validation fail clearly for schema drift that changes value types?

## Tests

- Start with targeted Rust tests in `src/features/profile/core/tests.rs`, `src/features/profile/startup.rs`, and `src/features/plugin_store/server/settings/plugin_config_handlers/form.rs`.
- Add or extend end-to-end flow coverage in `tests/profile_feature.rs` for export/import/sync/backups.
- Prefer flow tests that prove the end state of export/import/sync over tiny helper-only tests.
- Run targeted checks during iteration, then the full `qol-tray` verification stack before declaring success.

Targeted commands:

```bash
cargo test profile -- --nocapture
cargo test --test profile_feature -- --nocapture
cargo test migrate_live_plugin_configs_into_profile_dir -- --nocapture
cargo test validate_plugin_config_rejects_wrong_typed_values -- --nocapture
```

Required final verification starts with the repo-native commands:

```bash
qol build
qol check
cargo build --features dev
```

Then run the direct Rust verification stack:

```bash
cargo fmt --all --check
cargo clippy --all-targets --all-features -- -D warnings
cargo build
cargo test
```

- If the change touches `ui/views/profile/`, run `node --check` on the edited files too, but do not substitute that for the Rust verification stack.
- If a user says profile work still broke the repo, rerun the exact failing repo-native command first.
