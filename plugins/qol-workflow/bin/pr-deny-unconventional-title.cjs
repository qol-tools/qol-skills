#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PR_INVOCATION = /(^|[\s;&|`(])gh\s+pr\s+(create|edit)(\s|$)/;

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function words(command) {
    const out = [];
    let current = null;
    let quote = null;
    for (let index = 0; index < command.length; index += 1) {
        const char = command[index];
        if (quote) {
            if (char === quote) quote = null;
            else if (char === '\\' && quote === '"' && index + 1 < command.length) current += command[++index];
            else current += char;
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
            current = current ?? '';
        } else if (/\s/.test(char)) {
            if (current !== null) out.push(current);
            current = null;
        } else if (char === '\\' && index + 1 < command.length) {
            current = (current ?? '') + command[++index];
        } else {
            current = (current ?? '') + char;
        }
    }
    if (current !== null) out.push(current);
    return out;
}

function prTitle(command) {
    const match = command.match(PR_INVOCATION);
    if (!match) return null;
    const verb = match[2];
    const rest = command.slice(match.index + match[0].length).split(/\n|;|&&|\|\|/)[0];
    const args = words(rest);
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--title' || arg === '-t') return { verb, title: args[index + 1] ?? '' };
        if (arg.startsWith('--title=')) return { verb, title: arg.slice('--title='.length) };
    }
    return { verb, title: null };
}

function repoRoot(cwd) {
    const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
}

function refusal(root, title) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-pr-title-'));
    const file = path.join(dir, 'subject');
    fs.writeFileSync(file, `${title}\n`);
    const result = spawnSync('bash', [path.join(root, '.githooks', 'commit-msg'), file], { cwd: root, encoding: 'utf8' });
    fs.rmSync(dir, { recursive: true, force: true });
    return result.status === 0 ? null : (result.stderr || 'commit-msg refused the title').trim();
}

function emitDeny(reason) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `${reason}

The merge queue squashes the pull request into one commit titled by the pull request, and versioning reads that subject: feat bumps minor, fix and perf bump patch, anything else releases nothing. Title it <type>(scope): summary (qol-workflow:commit skill, "Pull request titles").`,
        },
    }));
}

function main() {
    let payload;
    try {
        payload = JSON.parse(readStdin().trim() || '{}');
    } catch {
        return 0;
    }
    if ((payload.tool_name || payload.tool || '') !== 'Bash') return 0;
    const command = (payload.tool_input && payload.tool_input.command) || '';
    const found = prTitle(command);
    if (!found) return 0;
    const root = repoRoot((payload.tool_input && payload.tool_input.cwd) || payload.cwd || process.cwd());
    if (!root || !fs.existsSync(path.join(root, '.githooks', 'commit-msg'))) return 0;
    if (found.title === null) {
        if (found.verb === 'create') emitDeny('gh pr create needs an explicit --title in this repository.');
        return 0;
    }
    if (found.title.includes('$')) return 0;
    const reason = refusal(root, found.title);
    if (reason) emitDeny(`Pull request title refused by .githooks/commit-msg:\n${reason}`);
    return 0;
}

module.exports = { prTitle, words };

if (require.main === module) {
    try {
        process.exit(main());
    } catch {
        process.exit(0);
    }
}
