#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PR_START = /(^|[\s;&|`(])gh\s+pr\s+(create|ready)(\s|$)/;
const PR_AUTO_MERGE = /(^|[\s;&|`(])gh\s+pr\s+merge\s[^;&|\n]*--auto(\s|$)/;
const GIT_PUSH = /(^|[\s;&|`(])git\s+(-C\s+\S+\s+)?push(\s|$)/;
const WATCHER_RUN = /pr-watch\.cjs/;
const DEFAULT_BRANCHES = new Set(['main', 'master', 'HEAD']);
const BLOCK = /<!-- inject:pr-watch:start -->\s*([\s\S]*?)\s*<!-- inject:pr-watch:end -->/;
const FLAG = '.qol-pr-watch-reminder-off';
const GH_TIMEOUT_MS = 4000;

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function pluginRoot() {
    return process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
}

function silenced(env = process.env, home = os.homedir()) {
    const dirs = [env.CLAUDE_CONFIG_DIR, path.join(home, '.claude')].filter(Boolean);
    return dirs.some((dir) => fs.existsSync(path.join(dir, FLAG)));
}

function reminderText(root) {
    try {
        const skill = fs.readFileSync(path.join(root, 'skills', 'qol-monorepo-rules', 'SKILL.md'), 'utf8');
        return BLOCK.exec(skill)?.[1] ?? '';
    } catch {
        return '';
    }
}

function pushDir(command, cwd) {
    const gitDir = /git\s+-C\s+(\S+)\s+push/.exec(command);
    if (gitDir) return path.resolve(cwd, gitDir[1]);
    const cdDir = /^\s*cd\s+(\S+)\s*&&/.exec(command);
    if (cdDir) return path.resolve(cwd, cdDir[1]);
    return cwd;
}

function run(cmd, args, cwd) {
    const result = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: GH_TIMEOUT_MS });
    return result.status === 0 ? result.stdout.trim() : null;
}

function openPullRequestUrl(dir, exec = run) {
    const branch = exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], dir);
    if (!branch || DEFAULT_BRANCHES.has(branch)) return null;
    const view = exec('gh', ['pr', 'view', branch, '--json', 'url,state'], dir);
    if (!view) return null;
    try {
        const pr = JSON.parse(view);
        return pr.state === 'OPEN' ? pr.url : null;
    } catch {
        return null;
    }
}

function trigger(command, cwd, exec = run) {
    if (!command || WATCHER_RUN.test(command)) return null;
    if (PR_START.test(command) || PR_AUTO_MERGE.test(command)) return { url: null };
    if (GIT_PUSH.test(command)) {
        const url = openPullRequestUrl(pushDir(command, cwd), exec);
        return url ? { url } : null;
    }
    return null;
}

function parkBinary(env = process.env, home = os.homedir(), exists = fs.existsSync) {
    const config = env.XDG_CONFIG_HOME || path.join(home, '.config');
    const plugin = path.join(config, 'qol-tray', 'plugins', 'qol-cli-sessions', process.platform === 'win32' ? 'qol-cli-sessions.exe' : 'qol-cli-sessions');
    return exists(plugin) ? plugin : 'qol-cli-sessions';
}

function render(text, root, url, park = parkBinary()) {
    const filled = text.replace('<qol-workflow>', root).replace('<qol-cli-sessions>', park);
    return url ? filled.replace('<pr-url>', url) : filled;
}

function main() {
    let payload;
    try {
        payload = JSON.parse(readStdin());
    } catch {
        return 0;
    }
    if ((payload.tool_name || payload.tool) !== 'Bash') return 0;
    if (silenced()) return 0;

    const command = payload.tool_input?.command ?? '';
    const hit = trigger(command, payload.cwd || process.cwd());
    if (!hit) return 0;

    const root = pluginRoot();
    const text = reminderText(root);
    if (!text) return 0;

    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: render(text, root, hit.url),
        },
    }));
    return 0;
}

module.exports = { trigger, render, parkBinary, reminderText, silenced, pushDir, openPullRequestUrl };

if (require.main === module) {
    process.exit(main());
}
