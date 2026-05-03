---
name: qol-tray-dev-recompile
description: Use when debugging "did my change actually load" / "is the running daemon stale" / "is qol-tray the freshly-built binary" — documents the in-app Recompile button as the canonical full-restart path that kills all plugin daemons AND replaces the qol-tray process in-place.
---

# qol-tray-dev-recompile

## The TL;DR you need to remember

**qol-tray has a built-in Recompile button. It is the canonical "fresh slate" action.** When the user is iterating on qol-tray or any plugin in dev mode, do NOT manually `pkill -f plugin-...` or speculate about which daemon is stale. The Recompile button performs a full, ordered teardown + rebuild + exec. If they say "I just rebuilt qol-tray," they almost certainly hit this button.

## Where it lives

In the qol-tray UI, the world-cog (settings) panel at the bottom-left contains a `Recompile` button alongside the running version label (`v3.7.1 DEV`). Frontend code: `ui/app/dev-flows.js`, button wired through `ui/app/useSidebarActions.js` posting `/api/dev/recompile-self`.

## What it actually does (verified in source, not guessed)

`src/features/plugin_store/server/dev_services/recompile/start.rs` → `restart_schedule.rs::exec_restart_after_cleanup` → `src/plugins/manager/runtime.rs::shutdown` → `stop_all_plugins`:

1. **`kill_all_plugin_processes()`** — kills every short-lived plugin runtime invocation.
2. **`stop_plugin_daemons(manager)`** — calls `plugin.stop_daemon()` on every plugin (graceful SIGTERM via `daemon_lifecycle::readiness::terminate_daemon`).
3. **`manager.plugins.clear()`** — empties the live plugin map.
4. **`daemon_tracker::clear_all_pids()`** — wipes the on-disk PID registry under `runtime_pids_dir`.
5. **`daemon_tracker::kill_orphan_daemons()`** — sweeps any tracked PIDs the manager lost track of.
6. **`restart.exec_restart(restart_binary)`** — `execv` the freshly-built `qol-tray` binary in place (same PID, fresh image).
7. **`std::process::exit(0)`** — only reached if exec fails; normally the exec already replaced the process.

Net effect after one click:
- Old `qol-tray` process is gone, replaced by the new binary at the same PID.
- Every plugin daemon (`plugin-lights`, `plugin-alt-tab`, `plugin-launcher`, …) is killed.
- The new `qol-tray` re-spawns daemons fresh on its next plugin load pass.

## How this should change your behavior

- **Don't ask "which daemon is running?"** when the user says "I just recompiled." All daemons died. The new ones are children of the new qol-tray.
- **Don't run `pkill -f plugin-foo`** as a debugging step. It races qol-tray's daemon supervisor and produces inconsistent state. Ask the user to hit Recompile instead, or accept that the Recompile they already did handled it.
- **A "stale binary" hypothesis is wrong** if the user clicked Recompile after their edit. The exec in step 6 swapped the binary atomically.
- **A "stale daemon" hypothesis is wrong** for the same reason. Steps 1-5 killed everything before the exec.
- **However:** if the user did NOT click Recompile after editing plugin source, the daemon IS stale — qol-tray supervises daemons but doesn't recompile their source. Plugin source edits + a Recompile of qol-tray *will* respawn fresh plugin daemons (because step 2 kills them and the new qol-tray starts them again), so Recompile fixes plugin staleness *transitively*, but only if the plugin's binary on disk has been rebuilt. For dev-linked plugins this means the plugin's own `cargo build` ran first.

## What it does NOT do

- It does NOT touch plugin config files (`config.json`, `qol-config.toml`).
- It does NOT touch the dongle, serial port state, or any external hardware.
- It does NOT clear the GitHub sync / Profile state — sync state on disk is preserved across restarts.
- It does NOT rebuild plugin binaries. Only the qol-tray binary is rebuilt.

## When to suggest it vs. when to skip

- **Suggest it** when the user reports "my code change isn't showing up" or "the daemon seems stuck on old behavior."
- **Skip it** for pure UI changes (frontend-only), where qol-tray's auto-reload already covers it (`fs change` log line in dev mode).
- **Skip it** for plugin source changes that have not yet been rebuilt — Recompile won't help if `target/debug/plugin-foo` is itself stale.
