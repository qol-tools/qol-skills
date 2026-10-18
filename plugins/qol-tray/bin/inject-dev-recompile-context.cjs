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

const fs = require('node:fs');

const QOL_PATH_COMPONENT = /(^|[\\/])qol-[^\\/]+([\\/]|$)/;

function sessionCwd() {
    try {
        return JSON.parse(fs.readFileSync(0, 'utf8')).cwd || process.cwd();
    } catch {
        return process.cwd();
    }
}

if (!QOL_PATH_COMPONENT.test(sessionCwd())) process.exit(0);

const CONTEXT = `qol-tray dev-restart cheat sheet (load before any qol-tray daemon analysis):
- Recompile is triggered from the qol dev dashboard (ctrl+r, or Enter on the Tray row), which POSTs /api/dev/recompile-self. No in-app Recompile button exists.
- One recompile = full teardown: kill_all_plugin_processes -> stop_plugin_daemons (daemon_lifecycle begin_stop/finish_stops) -> manager.plugins.clear -> daemon_tracker registry::clear_all -> kill_orphan_daemons -> exec_restart(staged qol-tray binary).
- Net effect: every plugin daemon (plugin-lights, plugin-alt-tab, plugin-launcher, ...) dies, qol-tray execs the freshly-built binary in place, and daemons get respawned fresh.
- DO NOT speculate about stale daemons or run pkill -f plugin-* if the user said they recompiled. The recompile already handled it.
- Recompile does NOT touch plugin config files, the dongle, sync state, or rebuild plugin binaries; only the qol-tray binary is rebuilt.
- Full skill: qol-tray:qol-tray-dev-recompile.`;

const out = {
    hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: CONTEXT,
    },
};

process.stdout.write(JSON.stringify(out) + '\n');
process.exit(0);
