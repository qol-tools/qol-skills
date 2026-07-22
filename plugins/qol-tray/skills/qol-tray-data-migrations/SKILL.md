---
name: qol-tray-data-migrations
description: >-
  Use when a qol-tray release breaks the on-disk config layout or cloud-backed user data,
  when adding a new migration between releases, or when debugging missing, duplicated,
  or stomped user data after startup. Defines the two-phase sliding-window migration
  pattern in the monorepo qol-migrations crate: PreFlight runs synchronously before
  any feature reads config, PostAuth runs asynchronously after GitHub auth loads,
  and old migrations are pruned once they fall outside the supported upgrade window.
---

# qol-tray-data-migrations

## Where things live

- Crate: `libs/qol-migrations/` in the qol-monorepo.
- Root workspace dependency: `Cargo.toml` has `qol-migrations = { path = "libs/qol-migrations" }`.
- Host dependency: `apps/qol-tray/Cargo.toml` uses `qol-migrations.workspace = true`.
- Host boot orchestration: `apps/qol-tray/src/app/`.
- Host post-auth facade: `apps/qol-tray/src/migrations/`; auth/session owners call this facade after credentials become available.
- Standalone binary: `apps/qol-tray/src/migrate/main.rs`.

## Cargo dependency form (read this before touching Cargo.toml)

qol-tray consumes qol-migrations through the workspace dependency, always:

```toml
# Cargo.toml
[workspace.dependencies]
qol-migrations = { path = "libs/qol-migrations" }

# apps/qol-tray/Cargo.toml
[dependencies]
qol-migrations.workspace = true
```

Do not replace this with `git = "..."`, `branch = "..."`, or a stale sibling path such as `../qol-migrations`. In the monorepo layout, `libs/qol-migrations` is the source of truth and Cargo.lock should resolve it as a path workspace crate.

## Two-phase boot model

Two phases, two runtime contracts.

- **PreFlight** - sync, file-only. No network, no auth, no daemon. Runs BEFORE any feature module reads config. Used for on-disk format / layout changes.
- **PostAuth** - async, network-aware. Runs AFTER the GitHub auth token loads. Used for backend swaps (gist to repo) and recovery of cloud-stored data.

Call shape in qol-tray:

```rust
// pre-flight (sync, in app boot before housekeeping)
qol_migrations::run_pre_flight(&config_dir, env!("CARGO_PKG_VERSION"))?;

// post-auth (async, after github_auth loads)
qol_migrations::run_post_auth(&MigrationContext {
    config_dir,
    github_token,
    http,
    host_version: env!("CARGO_PKG_VERSION"),
}).await?;
```

Both phases share the same journal, lock, and registry machinery. A migration declares its phase via the `Phase` enum on its trait impl; each runner only invokes migrations whose phase matches.

## Sliding-window release migrations

- One migration per breaking release. Folder-per-migration.
- The supported window is owned by `OLDEST_SUPPORTED` and the registered chain. Installs below it refuse to start with an upgrade-first error; never copy the window length into prose.
- Aged-out migrations are deleted in the same commit that introduces a new one. No amassing.

## Pitfall guards (encoded in the crate, do not bypass)

- **Strict in-order chain.** Apply in registry order, period. Flyway / goose lesson: out-of-order = "sometimes works" = production bugs.
- **`OLDEST_SUPPORTED` const refuses old installs** instead of fake-stamping the journal. Alembic / Django squash trap: silently marking missing migrations as applied leaves data in an indeterminate state nothing downstream can detect.
- **Per-step `.done` journal via rename-into-place** at `config_dir/migrations/applied/<name>.done`. Filesystem has no transactions; crash recovery consults the journal, not the filesystem shape. Half-migrated layouts can look "almost right" to a naive `applies()`.
- **fs4 exclusive lock on `config_dir/.migration-lock` for both phases.** Flyway dual-instance race; a tray app the user double-launches during an update is the local equivalent.
- **Install-id sentinel on remotes.** `MarkerFile { install_id, profile_id, schema_version }` written and verified before reading or writing any cloud-stored data. Aborts if marker disagrees. Mastodon "stomped someone else's bucket" class.
- **Backend abstraction (`trait GistStore`).** `MemoryGistStore` for tests, `GitHubGistStore` for production. Never mock at the HTTP layer; swap the backend. HTTP-layer mocks let bugs in JSON shape, pagination and error mapping leak past tests.
- **Cross-OS portability helpers.** NFC profile-name normalize, `.gitattributes` LF enforcement, path separator normalisation. Without these, the same name encoded two ways on two OSes produces two profiles, and a CRLF auto-convert on Windows produces a sync loop.

## Folder ownership

The crate root owns traits, phase registries, runners, and the support gate.
Shared journal/lock/sentinel/portability helpers live in named capability
modules. Each registered migration owns a versioned feature directory; discover
the maintained migration set from the registries rather than a tree copied into
this skill. Large migrations may own paired before/after fixtures under the
fixture root.

## Adding a new migration

1. **Pick the trait.** `FileMigration` for on-disk changes (sync, PreFlight). `CloudMigration` for anything touching a remote (async, PostAuth, gets `MigrationContext`). A release needing both ships two migrations.
2. **Folder-per-migration default.** `mkdir src/vN_to_vNplus1_<short_name>/` and create `mod.rs`. Aux files (transforms, schema converters, split tests) live in the same folder so pruning is a single `rm -rf`.
3. **Register it.** Append to `PreFlightRegistry::current()` or `PostAuthRegistry::current()` in `src/lib.rs`. Registry order is application order; never reorder.
4. **Tests.** Cover both `applies()` paths (true AND false) and a full `migrate()` round trip asserting archive contents and resulting config-dir or remote state. Cloud migrations use `MemoryGistStore`. Inline tests in `mod.rs` until ~150 lines, then split into `tests.rs`.
5. **Prune.** If this release pushes a migration outside the supported window, `rm -rf src/vN_oldest/ fixtures/vN_oldest/` in the same commit. Drop the entry from the registry. Bump `qol-migrations` minor version.

## Recovery branches narrow to the bug signature, not its effect

When the gate (`OLDEST_SUPPORTED` reject) needs a recovery branch for an in-flight bug - some installs already shipped with a broken version stamp and the gate now refuses to let them upgrade - the branch must match the **signature** of that bug, not the **effect**.

The motivating incident: a bug in qol-migrations wrote `env!(CARGO_PKG_VERSION)` from the lib crate itself (`0.1.0`) instead of the host's version. On the next boot, the gate saw `0.1.0`, decided it was below `OLDEST_SUPPORTED`, and refused to start.

The first recovery branch was too wide: it accepted **any** install below `OLDEST_SUPPORTED` if the host version was current. That silently auto-upgraded real legacy installs (`major >= 1`, below `OLDEST_SUPPORTED`) past the gate they were meant to hit. The gate became a no-op.

The narrow form matches only `parse_semver(installed).0 == 0`, the signature of the env-macro bug. Real legacy installs with `major >= 1` still hit the gate's reject branch and get the upgrade-first message.

```rust
fn reject_if_below_oldest_supported(config_dir: &Path, host_version: &str) -> Result<()> {
    let installed = read_installed_version(config_dir)?;
    if compare_semver(&installed, OLDEST_SUPPORTED) >= 0 {
        return Ok(());
    }
    let installed_major = parse_semver(&installed).0;
    if installed_major == 0 && compare_semver(host_version, OLDEST_SUPPORTED) >= 0 {
        log::warn!("[qol-migrations] version.txt contains {installed} (major == 0, the buggy lib stamp); host {host_version} is current. Treating as the env!CARGO_PKG_VERSION bug and overwriting with host version after this run.");
        return Ok(());
    }
    Err(anyhow!(
        "install version {installed} is older than the oldest supported version {OLDEST_SUPPORTED}; upgrade to {OLDEST_SUPPORTED} first"
    ))
}
```

Test the boundary in both directions. The same recovery condition has to round-trip through both PreFlight and PostAuth runners (both consult the same gate).

- Every signature-matching stamp is auto-recovered: any `0.x.y` value the env-macro could have produced.
- Every signature-not-matching legacy install (`major >= 1`, version below `OLDEST_SUPPORTED`) is still rejected with the right diagnostic. The error message must include the installed version and the `OLDEST_SUPPORTED` constant value.

A reviewer who asks "why isn't this a one-line check on `installed < OLDEST_SUPPORTED`?" wants the wider form. The answer is the major-greater-than-or-equal-to-one rejection test, which would fail under their proposal. Point them at the test.

When the in-flight bug is fully aged out of the install base (no `major == 0` stamps left in the wild), delete this recovery branch in the same commit that prunes the migration that introduced it. Do not let recovery branches accumulate.

## Why a separate crate, not an HTTP service

PreFlight has no daemon to talk to: it runs before the daemon boots. The new daemon cannot start until the layout matches, the old daemon has exited. Nothing to bind, nothing to call.

PostAuth could be a service (daemon is up by then) but the lifecycle penalty - extra process, extra socket, extra failure surface - outweighs an in-process async call.

Both paths (library from the daemon, `qol-tray-migrate` CLI) share the same registries and implementations.

## Why not put migrations into every feature module

Interweaved per-feature checks rot the codebase: every feature gradually accumulates "if old format do X, if new format do Y" branches, removing the legacy branch becomes scary because callers everywhere depend on it. The isolated crate stays bounded - migration code is deleted on a schedule.
