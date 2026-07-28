---
name: qol-plugin-removeapp
description: Use when working on the qol-tray Remove App plugin. Covers installed-app inventory, leftover discovery and attribution, package-manager guards, the identity-snapshot recheck that makes deletion safe, trash-versus-delete disposal, and the gpui removal UI. Triggers on "plugin-removeapp", "removeapp", uninstall, leftovers, app removal, protected apps, or package-managed applications.
---

# qol-plugin-removeapp

Remove App uninstalls an application and its leftovers. It is a destructive plugin, so most of its design is about proving that a path is safe to remove before removing it.

## Contract sources

- `plugin.toml` owns actions, exported launcher shortcuts, declared capabilities, platform availability, and release artifacts.
- `Cargo.toml` owns target-scoped dependencies.

Installed-app inventory comes from the shared apps library, not from a plugin-local scanner.

## Source ownership

| Path | Responsibility |
|---|---|
| `src/cli/` | Headless command surface and doctor registration. |
| `src/core/` | Removal domain: leftover kinds, plan, outcome, disposal, and the identity snapshot. |
| `src/core/classify.rs` | Attribution of a leftover to an owning bundle id and the resulting disposal. |
| `src/core/guards.rs` | Package-manager facts: manager, scope, status, index, and the guards derived from them. |
| `src/core/platform/` | Target-selected inventory, trash, and package-manager operations. |
| `src/daemon/` | Daemon lifecycle and action dispatch. |
| `src/ui/` | gpui selection and confirmation surface. |
| `src/doctor/` | Read-only checks with target-selected probes. |

## Safety model

Three independent mechanisms keep removal safe. Weakening any one of them is a correctness regression, not a simplification.

**Attribution.** A leftover is only in the plan if it can be attributed to the app being removed. Entries owned by another installed bundle id are excluded, so removing one app cannot delete a sibling's data.

**Package-manager guards.** An app installed through a package manager must be uninstalled through that manager. The package index answers who owns the app and at what scope; the guards derived from it gate what the plan may touch directly. Deleting a managed app's files behind its manager's back leaves the manager believing the app is still installed.

**Identity recheck.** The plan captures an identity snapshot per path - existence, file kind, length, modification time, device and inode, file name, canonical parent, and whether any ancestor is a symlink - and re-verifies it immediately before disposal. If anything moved, changed, or was replaced between planning and confirmation, that path is no longer the thing the user approved. This is the time-of-check-to-time-of-use guard; a plan is not a licence to delete later.

Protected apps and running apps are separate concerns from all three: protection excludes an app entirely, and a running app is quit and awaited before its files are touched.

## Common changes

**Add a leftover kind:** add the kind, teach discovery where it lives on each supported target, and make sure attribution can decide who owns it. A kind with no attribution rule is a deletion waiting to hit the wrong app.

**Add package-manager support:** extend the manager and scope facts and the index that resolves them, then let the guards fall out of that. Do not special-case a manager inside the removal path.

**Change disposal:** prefer recoverable disposal. Choosing permanent deletion needs a reason that survives the user asking "where did it go" - and it still goes through the identity recheck.

**Change the UI:** keep it keyboard-first, and keep the confirmation surface honest about total size and what will be removed.

## Invariants

- Nothing is removed without passing attribution, guards, and a matching identity snapshot.
- The inventory comes from the shared apps library; the plugin does not maintain a parallel scanner.
- A package-managed app is uninstalled through its manager.
- Protected apps are never planned for removal.
- A running app is quit and awaited before removal proceeds.
- Per-path failures are collected and reported; one failure does not abort the outcome or hide what was already removed.
- Doctor is read-only and never plans or performs a removal.

## Verification

Run format, build, Clippy with warnings denied, and tests, plus `cargo run -q -p qol -- check`. Compile every manifest-declared target. Attribution, guards, and identity-snapshot logic must be covered against temporary fixtures rather than real applications. When a test recreates a path to prove the recheck rejects it, force a genuinely distinct inode - a filesystem that reuses inodes after remove-and-recreate will otherwise make the recheck look like it passed.
