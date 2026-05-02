#!/usr/bin/env node
/*
 * SessionStart hook: inject the qol-tray dev-recompile context so the agent
 * never gets confused about whether daemons are stale, whether qol-tray is
 * the freshly-built binary, or whether to run pkill manually.
 *
 * Output is consumed by Claude Code as additionalContext via the documented
 * hookSpecificOutput JSON format.
 */

'use strict';

const CONTEXT = `qol-tray dev-restart cheat sheet (load before any qol-tray daemon analysis):
- qol-tray has a Recompile button in the world-cog settings panel (bottom-left).
- One click = full teardown: kill_all_plugin_processes -> stop_plugin_daemons (SIGTERM via terminate_daemon) -> manager.plugins.clear -> clear_all_pids -> kill_orphan_daemons -> exec_restart(new qol-tray binary) -> exit.
- Net effect: every plugin daemon (plugin-lights, plugin-alt-tab, plugin-launcher, ...) dies, qol-tray execs the freshly-built binary in place, and daemons get respawned fresh.
- DO NOT speculate about stale daemons or run pkill -f plugin-* if the user said they recompiled. The Recompile button already handled it.
- Recompile does NOT touch plugin config files, the dongle, sync state, or rebuild plugin binaries — only the qol-tray binary is rebuilt.
- Full skill: qol-host/qol-tray-dev-recompile.`;

const out = {
    hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: CONTEXT,
    },
};

process.stdout.write(JSON.stringify(out) + '\n');
process.exit(0);
