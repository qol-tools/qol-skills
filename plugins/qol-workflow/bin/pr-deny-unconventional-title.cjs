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

function blankHeredocBodies(command, start, terminators, shape) {
    let index = start;
    for (const word of terminators) {
        while (index < command.length) {
            const newline = command.indexOf('\n', index);
            const end = newline === -1 ? command.length : newline;
            const line = command.slice(index, end);
            for (let at = index; at < end; at += 1) shape[at] = ' ';
            index = end + 1;
            if (line.trim() === word) break;
        }
    }
    terminators.length = 0;
    return index;
}

function skeleton(command) {
    const shape = command.split('');
    const terminators = [];
    let quote = null;
    for (let index = 0; index < command.length; index += 1) {
        const char = command[index];
        if (quote) {
            if (char === quote) quote = null;
            else {
                if (char === '\\' && quote === '"' && index + 1 < command.length) shape[index++] = ' ';
                shape[index] = ' ';
            }
            continue;
        }
        if (char === "'" || char === '"') {
            quote = char;
        } else if (char === '\\') {
            index += 1;
        } else if (char === '\n' && terminators.length) {
            index = blankHeredocBodies(command, index + 1, terminators, shape) - 1;
        } else {
            const heredoc = command.slice(index).match(/^<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
            if (heredoc) {
                terminators.push(heredoc[2]);
                index += heredoc[0].length - 1;
            }
        }
    }
    return shape.join('');
}

function segment(command, shape, start) {
    const end = shape.slice(start).search(/\n|;|&&|\|/);
    return command.slice(start, end === -1 ? command.length : start + end);
}

function cdTarget(command, shape, before) {
    let target = null;
    for (const match of shape.slice(0, before).matchAll(/(^|[\s;&|(])cd\s+/g)) {
        target = words(segment(command, shape, match.index + match[0].length))[0] ?? null;
    }
    return target;
}

function prTitle(command) {
    const shape = skeleton(command);
    const match = shape.match(PR_INVOCATION);
    if (!match) return null;
    const verb = match[2];
    const dir = cdTarget(command, shape, match.index);
    const args = words(segment(command, shape, match.index + match[0].length));
    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index];
        if (arg === '--title' || arg === '-t') return { verb, title: args[index + 1] ?? '', dir };
        if (arg.startsWith('--title=')) return { verb, title: arg.slice('--title='.length), dir };
    }
    return { verb, title: null, dir };
}

function workingDir(base, dir) {
    if (!dir) return base;
    const expanded = dir === '~' || dir.startsWith('~/') ? path.join(os.homedir(), dir.slice(1)) : dir;
    const resolved = path.resolve(base, expanded);
    try {
        return fs.statSync(resolved).isDirectory() ? resolved : base;
    } catch {
        return base;
    }
}

function repoRoot(cwd) {
    const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
}

function commonDir(cwd) {
    const result = spawnSync('git', ['-C', cwd, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' });
    if (result.status !== 0) return null;
    try {
        return fs.realpathSync.native(path.resolve(cwd, result.stdout.trim()));
    } catch {
        return null;
    }
}

function gateDir(base, dir) {
    const target = workingDir(base, dir);
    if (target === base) return base;
    const own = commonDir(base);
    return own && commonDir(target) === own ? target : base;
}

function refusal(root, title) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-pr-title-'));
    const file = path.join(dir, 'subject');
    fs.writeFileSync(file, `${title}\n`);
    const result = spawnSync('bash', [path.join(root, '.githooks', 'commit-msg'), file], { cwd: root, encoding: 'utf8' });
    fs.rmSync(dir, { recursive: true, force: true });
    return result.status === 0 ? null : (result.stderr || 'commit-msg refused the title').trim();
}

const TAG = '[pr-deny-unconventional-title]';
const TITLE_SHAPE = '<type>(scope): imperative summary';

function nearestScopes(scope, allowed) {
    const parts = scope.split('-');
    return allowed.filter((candidate) => candidate.split('-').some((part) => parts.includes(part)));
}

function gateReason(gateOutput) {
    return ((gateOutput.match(/commit-msg rejected:\s*(.+)/) || [])[1] || gateOutput.split('\n')[0]).trim();
}

function hint(gateOutput) {
    const reason = gateReason(gateOutput);
    const allowed = ((gateOutput.match(/^\s*scopes\s*:\s*(.+)$/m) || [])[1] || '').trim().split(/\s+/).filter(Boolean);
    const long = reason.match(/subject too long \((\d+) > (\d+)/);
    if (long) return `the title is ${long[1]} characters and the cap is ${long[2]}: shorten the summary and keep the type and scope.`;
    const scope = reason.match(/unknown scope '([^']*)'/);
    if (scope && allowed.length) {
        const nearest = nearestScopes(scope[1], allowed);
        const lead = nearest.length ? `nearest: ${nearest.join(', ')}. ` : '';
        return `scope '${scope[1]}' is not a workspace member or umbrella; ${lead}All scopes: ${allowed.join(' ')}`;
    }
    return `title it ${TITLE_SHAPE}, at most 72 characters (qol-workflow:commit, "Pull request titles").`;
}

function refusalLine(title, gateOutput) {
    return `Pull request title "${title}" was refused by .githooks/commit-msg (${gateReason(gateOutput)}); the merge queue squashes the pull request into one commit with this subject, and versioning reads it.`;
}

const MISSING_TITLE = 'gh pr create needs an explicit --title here: the merge queue squashes the pull request into one commit with that title, and versioning reads it.';

function emitDeny(line1, line2) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: `${line1}\n${TAG} ${line2}`,
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
    const base = (payload.tool_input && payload.tool_input.cwd) || payload.cwd || process.cwd();
    const root = repoRoot(gateDir(base, found.dir));
    if (!root || !fs.existsSync(path.join(root, '.githooks', 'commit-msg'))) return 0;
    if (found.title === null) {
        if (found.verb === 'create') emitDeny(MISSING_TITLE, `pass --title "${TITLE_SHAPE}" (at most 72 characters, scope from the workspace members); --fill is refused.`);
        return 0;
    }
    if (found.title.includes('$')) return 0;
    const reason = refusal(root, found.title);
    if (reason) emitDeny(refusalLine(found.title, reason), hint(reason));
    return 0;
}

module.exports = { prTitle, words, skeleton, hint, nearestScopes };

if (require.main === module) {
    try {
        process.exit(main());
    } catch {
        process.exit(0);
    }
}
