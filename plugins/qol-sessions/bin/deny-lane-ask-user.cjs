'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LIST_TIMEOUT_MS = 5000;
const KEY_PATTERN = /^(?!\.+$)[A-Za-z0-9._-]+$/;

function readPayload() {
    try {
        return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    } catch {
        return {};
    }
}

function ancestors(pid = process.pid) {
    const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: LIST_TIMEOUT_MS });
    if (result.status !== 0) return new Set();
    const parents = new Map();
    for (const line of result.stdout.split('\n')) {
        const [child, parent] = line.trim().split(/\s+/).map(Number);
        if (child) parents.set(child, parent);
    }
    const chain = new Set();
    for (let current = pid; current > 1 && !chain.has(current); current = parents.get(current)) chain.add(current);
    return chain;
}

function liveRows() {
    const result = spawnSync('qol', ['--json', 'sessions', 'list'], { encoding: 'utf8', timeout: LIST_TIMEOUT_MS });
    if (result.status !== 0) return [];
    try {
        return JSON.parse(result.stdout);
    } catch {
        return [];
    }
}

function dataDir(env = process.env, home = os.homedir(), platform = process.platform) {
    if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
    if (platform === 'win32') return env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    return env.XDG_DATA_HOME || path.join(home, '.local', 'share');
}

function recordedParent(key, base = dataDir()) {
    if (!KEY_PATTERN.test(key)) return null;
    try {
        const record = JSON.parse(fs.readFileSync(path.join(base, 'qol-tray', 'sessions', 'lineage', `${key}.json`), 'utf8'));
        return typeof record.parent === 'string' && record.parent !== '' ? record.parent : null;
    } catch {
        return null;
    }
}

function callerLane({ rows = liveRows(), chain = ancestors(), parentOf = recordedParent } = {}) {
    const row = rows.find((candidate) => chain.has(candidate?.root_pid));
    if (!row || row.master || typeof row.key !== 'string') return null;
    const parent = parentOf(row.key);
    return parent ? { key: row.key, parent } : null;
}

function denial({ key, parent }) {
    return {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: [
                `${key} is a lane of ${parent}, so a question for the user goes through its parent, not this terminal.`,
                `[deny-lane-ask-user] send the question to ${parent} with session_send kind ask; the answer comes back as a message.`,
            ].join('\n'),
        },
    };
}

function decide(payload, lane = callerLane) {
    if (payload?.tool_name !== 'AskUserQuestion') return null;
    const caller = lane();
    return caller ? denial(caller) : null;
}

function main() {
    const decision = decide(readPayload());
    if (decision) process.stdout.write(JSON.stringify(decision));
    process.exit(0);
}

if (require.main === module) main();

module.exports = { callerLane, dataDir, decide, recordedParent };
