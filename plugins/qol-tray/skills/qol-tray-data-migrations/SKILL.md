---
name: qol-tray-data-migrations
description: Use when a qol-tray release breaks the on-disk config layout or the cloud backend that stores user data, when adding a new migration between releases, or when debugging "the daemon starts but my data is missing / duplicated / stomped on". Defines the two-phase sliding-window migration pattern: each breaking release ships exactly one migration in the qol-migrations sibling crate, PreFlight runs sync before any feature reads config, PostAuth runs async after GitHub auth loads, and old migrations are deleted once they fall outside the supported upgrade window.
---

# qol-tray-data-migrations

## Where things live

- Crate: sibling repo of qol-tray inside the qol-tools workspace (`<workspace>/qol-migrations/` on the main clone, `<workspace>/worktrees/<feat>/qol-migrations/` inside a feature lane).

## Cargo dependency form (read this before touching qol-tray's Cargo.toml)

qol-tray declares qol-migrations as a **path dep**, always:

```toml
qol-migrations = { path = "../qol-migrations" }
```

NEVER as `git = "..." branch = "..."`. Rationale:

- `../qol-migrations` is sibling-relative, so it resolves correctly from both the main clone (`qol-tools/qol-tray/` -> `qol-tools/qol-migrations/`) AND from any feature worktree (`worktrees/<feat>/qol-tray/` -> `worktrees/<feat>/qol-migrations/`). Worktree-aware for free.
- A `git + branch` dep forces a push every time qol-migrations changes during local iteration, pins to a SHA in `Cargo.lock` (so `cargo update -p qol-migrations` is needed each cycle), and breaks the symmetry above.
- "Until pushed to GitHub" is misleading shorthand from earlier docs. There is no flip to a git dep on release - the path dep stays. Each repo ships from its own `main`, independently versioned; qol-tray consumers (CI, distros, end-user installs) build from qol-tray's source tree, which checks out the matching qol-migrations sibling. No release-time substitution is needed.

If you find a `git = "https://github.com/qol-tools/qol-migrations"` form in `qol-tray/Cargo.toml`, treat it as drift to revert, not as a deliberate choice.

- qol-tray PreFlight call site: `qol-tray/src/main.rs`, near `run_startup_cleanup` (PreFlight runs immediately BEFORE housekeeping; housekeeping populates whatever the migration left behind).
- qol-tray PostAuth call site: after GitHub auth loads. TBD: exact file path; the assembly agent introducing the first cloud migration picks where in the boot flow this lands. Search for `qol_migrations::run_post_auth` once the assembly agent's branch is merged.
- Standalone binary: `qol-tray-migrate` at `qol-tray/src/migrate/main.rs`. Thin wrapper for `--dry-run` debugging or running against a custom config dir. Shares the same registries as the daemon path.

## Two-phase boot model

Two phases, two runtime contracts.

- **PreFlight** - sync, file-only. No network, no auth, no daemon. Runs BEFORE any feature module reads config. Used for on-disk format / layout changes.
- **PostAuth** - async, network-aware. Runs AFTER the GitHub auth token loads. Used for backend swaps (gist to repo) and recovery of cloud-stored data.

Call shape in qol-tray:

```rust
// pre-flight (sync, in main.rs before housekeeping)
qol_migrations::run_pre_flight(&config_dir)?;

// post-auth (async, after github_auth loads)
qol_migrations::run_post_auth(&MigrationContext {
    config_dir,
    github_token,
    http,
}).await?;
```

Both phases share the same journal, lock, and registry machinery. A migration declares its phase via the `Phase` enum on its trait impl; each runner only invokes migrations whose phase matches.

## Sliding-window release migrations

- One migration per breaking release. Folder-per-migration.
- Supported window: previous N releases (default 3). Older = refuse-to-start with "upgrade to vX first".
- Aged-out migrations are deleted in the same commit that introduces a new one. No amassing.

## Pitfall guards (encoded in the crate, do not bypass)

- **Strict in-order chain.** Apply in registry order, period. Flyway / goose lesson: out-of-order = "sometimes works" = production bugs.
- **`OLDEST_SUPPORTED` const refuses old installs** instead of fake-stamping the journal. Alembic / Django squash trap: silently marking missing migrations as applied leaves data in an indeterminate state nothing downstream can detect.
- **Per-step `.done` journal via rename-into-place** at `config_dir/migrations/applied/<name>.done`. Filesystem has no transactions; crash recovery consults the journal, not the filesystem shape. Half-migrated layouts can look "almost right" to a naive `applies()`.
- **fs4 exclusive lock on `config_dir/.migration-lock` for both phases.** Flyway dual-instance race; a tray app the user double-launches during an update is the local equivalent.
- **Install-id sentinel on remotes.** `MarkerFile { install_id, profile_id, schema_version }` written and verified before reading or writing any cloud-stored data. Aborts if marker disagrees. Mastodon "stomped someone else's bucket" class.
- **Backend abstraction (`trait GistStore`).** `MemoryGistStore` for tests, `GitHubGistStore` for production. Never mock at the HTTP layer; swap the backend. HTTP-layer mocks let bugs in JSON shape, pagination and error mapping leak past tests.
- **Cross-OS portability helpers.** NFC profile-name normalize, `.gitattributes` LF enforcement, path separator normalisation. Without these, the same name encoded two ways on two OSes produces two profiles, and a CRLF auto-convert on Windows produces a sync loop.

## Folder layout (current)

```
src/
  lib.rs                         trait + Phase + Registries + runners + OLDEST_SUPPORTED
  fs_util.rs                     archive helpers
  journal.rs                     .done markers
  lock.rs                        fs4 wrapper
  sentinel.rs                    install-id MarkerFile
  cloud/gist_store/              {mod,memory,github}.rs - GistStore trait + impls
  transforms/gist_v1_to_layout.rs  pure gist JSON -> {path -> bytes} map
  portability/                   unicode.rs, paths.rs, gitattributes.rs
  v3_15_to_v3_16/                file migration (PreFlight)
  v3_15_to_v3_16_gist_to_repo/   cloud migration (PostAuth) - added by parallel assembly agent
fixtures/<future migration>/before/, after/  (recommended for big migrations)
```

## Adding a new migration

1. **Pick the trait.** `FileMigration` for on-disk changes (sync, PreFlight). `CloudMigration` for anything touching a remote (async, PostAuth, gets `MigrationContext`). A release needing both ships two migrations.
2. **Folder-per-migration default.** `mkdir src/vN_to_vNplus1_<short_name>/` and create `mod.rs`. Aux files (transforms, schema converters, split tests) live in the same folder so pruning is a single `rm -rf`.
3. **Register it.** Append to `file_registry()` or `cloud_registry()` in `src/lib.rs`. Registry order is application order; never reorder.
4. **Tests.** Cover both `applies()` paths (true AND false) and a full `migrate()` round trip asserting archive contents and resulting config-dir or remote state. Cloud migrations use `MemoryGistStore`. Inline tests in `mod.rs` until ~150 lines, then split into `tests.rs`.
5. **Prune.** If this release pushes a migration outside the supported window, `rm -rf src/vN_oldest/ fixtures/vN_oldest/` in the same commit. Drop the entry from the registry. Bump `qol-migrations` minor version.

## Why a separate crate, not an HTTP service

PreFlight has no daemon to talk to: it runs before the daemon boots. The new daemon cannot start until the layout matches, the old daemon has exited. Nothing to bind, nothing to call.

PostAuth could be a service (daemon is up by then) but the lifecycle penalty - extra process, extra socket, extra failure surface - outweighs an in-process async call.

Both paths (library from the daemon, `qol-tray-migrate` CLI) share the same registries and implementations.

## Why not put migrations into every feature module

Interweaved per-feature checks rot the codebase: every feature gradually accumulates "if old format do X, if new format do Y" branches, removing the legacy branch becomes scary because callers everywhere depend on it. The isolated crate stays bounded - migration code is deleted on a schedule.
