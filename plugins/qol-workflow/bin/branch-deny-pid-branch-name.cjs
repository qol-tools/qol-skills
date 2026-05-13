#!/usr/bin/env node
/*
 * PreToolUse hook (Bash matcher): block creation of a PID-prefixed git branch
 * name inside a qol-tools repo.
 *
 * Rule: coordinated work across qol-tray and one or more plugin repos must
 * share a single topic-led branch name (e.g. `wasm`, `theming`). qol-tray's
 * Active Worktree Branch picker (Settings -> dev) applies one branch name to
 * every dev-linked plugin repo at runtime, falling back to `main` when a
 * given plugin has no matching worktree. A PID-prefixed branch name
 * (`tray-32-foo`, `alttab-2-bar`) cannot serve this role because the PID is
 * qol-tray-specific and no plugin repo will ever carry a matching branch.
 *
 * Detected creation forms:
 *   - `git checkout -b/-B <NAME>`
 *   - `git switch -c/-C <NAME>`
 *   - `git worktree add ... -b <NAME>`
 *   - `git branch <NAME>` (positional creation form)
 *
 * Blocked when <NAME> matches /^[a-z][a-z0-9]*-\d+(-|$)/ and the effective
 * cwd is under /media/kmrh47/WD_SN850X/Git/qol-tools/.
 *
 * Bypass: append ` # intentional` for genuinely single-repo PID branches.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const QOL_TOOLS_ROOT = '/media/kmrh47/WD_SN850X/Git/qol-tools';
const PID_PATTERN = /^[a-z][a-z0-9]*-\d+(-|$)/;
const INTENTIONAL_SUFFIX = /#\s*intentional\b/;

const CREATE_PATTERNS = [
    /\bgit\s+checkout\s+-[bB]\s+(\S+)/,
    /\bgit\s+switch\s+-[cCB]\s+(\S+)/,
    /\bgit\s+worktree\s+add\s+(?:[^|;\n]*?\s)?-b\s+(\S+)/,
];

// `git branch <NAME>` creates a ref if <NAME> is positional (not a flag) and
// no destructive/admin flag (-d/-D/-m/-M/-c/-C/-v/-r/--list/--show-current)
// preceded it.
const BRANCH_ADMIN_FLAGS = /\bgit\s+branch\s+-[dDmMcCvrCu]|\bgit\s+branch\s+--/;
const BRANCH_CREATE = /\bgit\s+branch\s+(?!-|--)(\S+)/;

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function detectNewBranchName(cmd) {
    if (typeof cmd !== 'string') return null;
    for (const re of CREATE_PATTERNS) {
        const m = cmd.match(re);
        if (m && m[1]) return m[1];
    }
    if (BRANCH_ADMIN_FLAGS.test(cmd)) return null;
    const bm = cmd.match(BRANCH_CREATE);
    if (bm && bm[1]) return bm[1];
    return null;
}

function inQolToolsTree(cwd) {
    if (typeof cwd !== 'string' || !cwd) return false;
    if (cwd === QOL_TOOLS_ROOT) return true;
    return cwd.startsWith(QOL_TOOLS_ROOT + path.sep);
}

function emitDeny(name, command) {
    const reason = `Branch name "${name}" looks PID-prefixed; coordinated qol-tools work needs a shared topic name across repos so qol-tray's Active Worktree Branch picker can switch all dev-linked plugins together.

Command: ${command.trim()}

Pick a topic name instead (e.g. wasm, theming, sync-v2). See the qol-workflow:git-trees skill, section "Cross-repo dev recompile loop".

Bypass (rare, genuine single-repo work): append \` # intentional\` to the command.`;

    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
        },
    }));
}

function main() {
    const raw = readStdin().trim();
    if (!raw) return 0;

    let payload;
    try {
        payload = JSON.parse(raw);
    } catch {
        return 0;
    }

    if ((payload.tool_name || payload.tool || '') !== 'Bash') return 0;
    const cmd = (payload.tool_input && payload.tool_input.command) || '';
    if (!cmd) return 0;
    if (INTENTIONAL_SUFFIX.test(cmd)) return 0;

    const baseCwd =
        (payload.tool_input && payload.tool_input.cwd) ||
        payload.cwd ||
        process.cwd();
    if (!inQolToolsTree(baseCwd)) return 0;

    const name = detectNewBranchName(cmd);
    if (!name) return 0;
    if (!PID_PATTERN.test(name)) return 0;

    emitDeny(name, cmd);
    return 0;
}

module.exports = {
    detectNewBranchName,
    inQolToolsTree,
    PID_PATTERN,
};

if (require.main === module) {
    process.exit(main());
}
