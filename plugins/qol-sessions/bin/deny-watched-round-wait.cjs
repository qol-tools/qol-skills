'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const BRIDGE_TOOL_PATTERN = /(?:^|__)session_bridge$/;
const CLI_WAIT_PATTERN = /\bqol\s+sessions\s+(?:resume|bridge|wait)\s+(v1:\S+)/;
const NEXT_TIMEOUT_MS = 5000;

function readPayload() {
    try {
        return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    } catch {
        return {};
    }
}

function targetSession(payload) {
    const tool = String(payload?.tool_name ?? '');
    const input = payload?.tool_input ?? {};
    if (BRIDGE_TOOL_PATTERN.test(tool)) return typeof input.session === 'string' ? input.session : null;
    if (tool === 'Bash') return String(input.command ?? '').match(CLI_WAIT_PATTERN)?.[1] ?? null;
    return null;
}

function roundPhases(session) {
    const result = spawnSync('qol', ['--json', 'sessions', 'next', session], {
        encoding: 'utf8',
        timeout: NEXT_TIMEOUT_MS,
    });
    if (result.status !== 0) return [];
    try {
        return JSON.parse(result.stdout).map((row) => row?.phase);
    } catch {
        return [];
    }
}

function denial(session) {
    return {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: [
                `The lane ${session} is still working and the qol sessions watcher will wake you with its report, so waiting on it only stalls this session.`,
                '[deny-watched-round-wait] End your turn now and review the report when the wake arrives.',
            ].join('\n'),
        },
    };
}

function decide(payload, phasesFor = roundPhases) {
    const session = targetSession(payload);
    if (!session) return null;
    return phasesFor(session).includes('watched') ? denial(session) : null;
}

function main() {
    const decision = decide(readPayload());
    if (decision) process.stdout.write(JSON.stringify(decision));
    process.exit(0);
}

if (require.main === module) main();

module.exports = { decide, targetSession };
