#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { trigger, armsPullRequest, parkBinary, isSwitchboard, watchedPullRequests } = require('./pr-watch-context.cjs');

const QOL_PATH_COMPONENT = /(^|[\\/])qol-[^\\/]+([\\/]|$)/;

const HOOK_NAME = 'pr-watch-park-guard';
const WATCHER_RUN = /(^|[\s;&|`(])node\s+\S*pr-watch\.cjs(\s|$)/;
const PARKED_RUN = /(^|[\s;&|`(])\S*qol-cli-sessions(?:\.exe)?\s+park\b[^;&|\n]*\s--\s+node\s+\S*pr-watch\.cjs(\s|$)/;
const WATCHER_HELP = /pr-watch\.cjs\s+(-h|--help)(\s|$)/;
const HOLD = /(^|[\s;&|`(])gh\s+pr\s+merge\s[^;&|\n]*--disable-auto(\s|$)/;
const TAIL_BYTES = 4 * 1024 * 1024;
const TOOL_USE_ID = /^[\w-]+$/;

function parkCommand(url) {
    const root = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
    return `${parkBinary()} park -- node ${path.join(root, 'bin', 'pr-watch.cjs')} ${url ?? '<pr-url>'} --pretty`;
}

function readTranscript(file, tail) {
    if (!tail) return fs.readFileSync(file, 'utf8');
    const fd = fs.openSync(file, 'r');
    try {
        const size = fs.fstatSync(fd).size;
        const length = Math.min(size, tail);
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, size - length);
        return buffer.toString('utf8');
    } finally {
        fs.closeSync(fd);
    }
}

function settledArmings(dir = path.join(os.tmpdir(), HOOK_NAME)) {
    const marker = (id) => (TOOL_USE_ID.test(id ?? '') ? path.join(dir, id) : null);
    return {
        has: (id) => Boolean(marker(id)) && fs.existsSync(marker(id)),
        add: (id) => {
            if (!marker(id)) return false;
            try {
                fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(marker(id), '');
                return true;
            } catch {
                return false;
            }
        },
    };
}

function readPayload() {
    try {
        return JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
        return null;
    }
}

function unparkedWatcher(command) {
    if (!command || !WATCHER_RUN.test(command) || WATCHER_HELP.test(command)) return false;
    return !PARKED_RUN.test(command);
}

function denyUnparked() {
    return {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
                'The pull request watcher runs only under a parked session, so no terminal stays open while it waits.\n' +
                `[${HOOK_NAME}] run \`${parkCommand()}\` and end your turn; qol resumes this conversation when the watcher exits`,
        },
    };
}

function bashCalls(transcript) {
    const results = new Map();
    const calls = [];
    for (const line of transcript.split('\n')) {
        if (!line.includes('"tool_')) continue;
        let entry;
        try {
            entry = JSON.parse(line);
        } catch {
            continue;
        }
        const content = entry?.message?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
            if (block?.type === 'tool_use' && block.name === 'Bash' && typeof block.input?.command === 'string') {
                calls.push({ id: block.id, command: block.input.command, cwd: entry.cwd });
            } else if (block?.type === 'tool_result') {
                results.set(block.tool_use_id, block.is_error !== true);
            }
        }
    }
    return calls.map((call) => ({ ...call, ok: results.get(call.id) === true }));
}

function unparkedPullRequest(calls, cwd, exec) {
    let watched;
    for (let index = calls.length - 1; index >= 0; index -= 1) {
        const call = calls[index];
        if (!call.ok) continue;
        if (PARKED_RUN.test(call.command) || HOLD.test(call.command)) return null;
        const hit = trigger(call.command, call.cwd || cwd, exec);
        if (!hit) continue;
        watched ??= watchedPullRequests(exec);
        if (!hit.url || !watched.has(hit.url)) return hit;
    }
    return null;
}

function unparkedArming(calls, cwd, exec, settled) {
    let watched;
    for (let index = calls.length - 1; index >= 0; index -= 1) {
        const call = calls[index];
        if (PARKED_RUN.test(call.command)) return null;
        if (!call.ok) continue;
        if (HOLD.test(call.command)) return null;
        if (!armsPullRequest(call.command) || settled.has(call.id)) continue;
        const hit = trigger(call.command, call.cwd || cwd, exec);
        if (hit && !hit.url) return hit;
        if (hit) {
            watched ??= watchedPullRequests(exec);
            if (!watched.has(hit.url)) return hit;
        }
        settled.add(call.id);
    }
    return null;
}

function letsThrough(payload) {
    if ((payload.tool_name || payload.tool) !== 'Bash') return false;
    const command = payload.tool_input?.command ?? '';
    return PARKED_RUN.test(command) || HOLD.test(command) || armsPullRequest(command) === 'arm';
}

function denyUntilParked(hit) {
    return {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
                'A pull request you opened or armed has no watcher, so a failed check or review would reach no one. Park on it before anything else.\n' +
                `[${HOOK_NAME}] run \`${parkCommand(hit.url)}\`, or \`gh pr merge --disable-auto <number>\` if the user is testing or holding it`,
        },
    };
}

function blockStop(hit) {
    return {
        decision: 'block',
        reason:
            `A pull request you opened or pushed is not being watched yet. Park this session on its watcher before ending the turn: \`${parkCommand(hit.url)}\`. ` +
            `If the user said they are testing or holding it, run \`gh pr merge --disable-auto <number>\` instead. [${HOOK_NAME}]`,
    };
}

function decide(payload, read = readTranscript, exec, env = process.env, settled = settledArmings()) {
    if (!QOL_PATH_COMPONENT.test(payload?.cwd || process.cwd())) return null;
    const event = payload?.hook_event_name;
    if (event === 'PreToolUse') {
        const bash = (payload.tool_name || payload.tool) === 'Bash';
        if (bash && unparkedWatcher(payload.tool_input?.command ?? '')) return denyUnparked();
        if (!payload.transcript_path || letsThrough(payload)) return null;
        let transcript;
        try {
            transcript = read(payload.transcript_path, TAIL_BYTES);
        } catch {
            return null;
        }
        const hit = unparkedArming(bashCalls(transcript), payload.cwd || process.cwd(), exec, settled);
        return hit && !isSwitchboard(env, exec) ? denyUntilParked(hit) : null;
    }
    if (event === 'Stop') {
        if (payload.stop_hook_active || !payload.transcript_path) return null;
        let transcript;
        try {
            transcript = read(payload.transcript_path);
        } catch {
            return null;
        }
        const hit = unparkedPullRequest(bashCalls(transcript), payload.cwd || process.cwd(), exec);
        return hit && !isSwitchboard(env, exec) ? blockStop(hit) : null;
    }
    return null;
}

function main() {
    const decision = decide(readPayload());
    if (decision) process.stdout.write(JSON.stringify(decision));
    return 0;
}

module.exports = { decide, unparkedWatcher, bashCalls, unparkedPullRequest, unparkedArming, settledArmings };

if (require.main === module) {
    try {
        process.exit(main());
    } catch {
        process.exit(0);
    }
}
