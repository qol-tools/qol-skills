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
make build
make test
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
