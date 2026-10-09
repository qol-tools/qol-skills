#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { trigger, parkBinary } = require('./pr-watch-context.cjs');

const HOOK_NAME = 'pr-watch-park-guard';
const WATCHER_RUN = /(^|[\s;&|`(])node\s+\S*pr-watch\.cjs(\s|$)/;
const PARKED_RUN = /(^|[\s;&|`(])\S*qol-cli-sessions(?:\.exe)?\s+park\b[^;&|\n]*\s--\s+node\s+\S*pr-watch\.cjs(\s|$)/;
const WATCHER_HELP = /pr-watch\.cjs\s+(-h|--help)(\s|$)/;
const HOLD = /(^|[\s;&|`(])gh\s+pr\s+merge\s[^;&|\n]*--disable-auto(\s|$)/;
function parkCommand(url) {
    const root = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
    return `${parkBinary()} park -- node ${path.join(root, 'bin', 'pr-watch.cjs')} ${url ?? '<pr-url>'} --pretty`;
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
    for (let index = calls.length - 1; index >= 0; index -= 1) {
        const call = calls[index];
        if (!call.ok) continue;
        if (PARKED_RUN.test(call.command) || HOLD.test(call.command)) return null;
        const hit = trigger(call.command, call.cwd || cwd, exec);
        if (hit) return hit;
    }
    return null;
}

function blockStop(hit) {
    return {
        decision: 'block',
        reason:
            `A pull request you opened or pushed is not being watched yet. Park this session on its watcher before ending the turn: \`${parkCommand(hit.url)}\`. ` +
            `If the user said they are testing or holding it, run \`gh pr merge --disable-auto <number>\` instead. [${HOOK_NAME}]`,
    };
}

function decide(payload, readTranscript = (path) => fs.readFileSync(path, 'utf8'), exec) {
    const event = payload?.hook_event_name;
    if (event === 'PreToolUse') {
        if ((payload.tool_name || payload.tool) !== 'Bash') return null;
        return unparkedWatcher(payload.tool_input?.command ?? '') ? denyUnparked() : null;
    }
    if (event === 'Stop') {
        if (payload.stop_hook_active || !payload.transcript_path) return null;
        let transcript;
        try {
            transcript = readTranscript(payload.transcript_path);
        } catch {
            return null;
        }
        const hit = unparkedPullRequest(bashCalls(transcript), payload.cwd || process.cwd(), exec);
        return hit ? blockStop(hit) : null;
    }
    return null;
}

function main() {
    const decision = decide(readPayload());
    if (decision) process.stdout.write(JSON.stringify(decision));
    return 0;
}

module.exports = { decide, unparkedWatcher, bashCalls, unparkedPullRequest };

if (require.main === module) {
    try {
        process.exit(main());
    } catch {
        process.exit(0);
    }
}
