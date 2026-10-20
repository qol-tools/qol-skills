#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const QOL_PATH_COMPONENT = /(^|[\\/])qol-[^\\/]+([\\/]|$)/;

const PR_CREATE = /(^|[\s;&|`(])gh\s+pr\s+create(\s|$)/;
const PR_READY = /(^|[\s;&|`(])gh\s+pr\s+ready(\s|$)/;
const PR_AUTO_MERGE = /(^|[\s;&|`(])gh\s+pr\s+merge\s[^;&|\n]*--auto(\s|$)/;
const PR_REF = /gh\s+pr\s+(?:merge|ready)\s(?:[^;&|\n]*?\s)?(https:\/\/\S+\/pull\/\d+|\d+)(?=\s|$)/;
const PR_REPO = /gh\s+pr\s+(?:merge|ready)\s[^;&|\n]*?(?:-R|--repo)[\s=](\S+)/;
const PULL_URL = /https:\/\/\S+\/pull\/\d+/;
const SWITCHBOARD_KEY = 'switchboard';
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

function queuedPullRequest(command, cwd, exec) {
    const ref = PR_REF.exec(command)?.[1];
    if (!ref) return { url: null };
    const repo = PR_REPO.exec(command)?.[1];
    const view = exec('gh', ['pr', 'view', ref, ...(repo ? ['--repo', repo] : []), '--json', 'url,state'], cwd);
    if (!view) return { url: null };
    try {
        const pr = JSON.parse(view);
        return pr.state === 'OPEN' ? { url: pr.url } : null;
    } catch {
        return { url: null };
    }
}

function withoutHeredocs(command) {
    return command.replace(/<<-?\s*(['"]?)(\w+)\1([^\n]*)\n[\s\S]*?\n\s*\2(?=\n|$)/g, '$3');
}

function trigger(rawCommand, cwd, exec = run) {
    const command = rawCommand && withoutHeredocs(rawCommand);
    if (!command || WATCHER_RUN.test(command)) return null;
    if (PR_CREATE.test(command)) return { url: null };
    if (PR_READY.test(command) || PR_AUTO_MERGE.test(command)) return queuedPullRequest(command, cwd, exec);
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

function isSwitchboard(env = process.env, exec = run) {
    const window = env.KITTY_WINDOW_ID;
    if (!window) return false;
    const out = exec('kitten', ['@', 'ls', '--match', `id:${window}`], process.cwd());
    try {
        const windows = JSON.parse(out).flatMap((os) => os.tabs.flatMap((tab) => tab.windows));
        return windows.some((win) => String(win.id) === window && win.user_vars?.qol_session_key === SWITCHBOARD_KEY);
    } catch {
        return false;
    }
}

function watchedPullRequests(exec = run) {
    const rows = exec(parkBinary(), ['parked'], process.cwd()) ?? '';
    return new Set(rows.split('\n').map((row) => row.split('\t')).filter((cells) => cells[1] === 'waiting').map((cells) => PULL_URL.exec(cells[4] ?? '')?.[0]).filter(Boolean));
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
    if (!QOL_PATH_COMPONENT.test(payload.cwd || process.cwd())) return 0;
    if (silenced()) return 0;

    const command = payload.tool_input?.command ?? '';
    const hit = trigger(command, payload.cwd || process.cwd());
    if (!hit || isSwitchboard() || (hit.url && watchedPullRequests().has(hit.url))) return 0;

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

module.exports = { trigger, render, parkBinary, reminderText, silenced, pushDir, openPullRequestUrl, isSwitchboard, watchedPullRequests };

if (require.main === module) {
    process.exit(main());
}
