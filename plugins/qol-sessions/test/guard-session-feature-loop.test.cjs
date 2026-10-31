'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'guard-session-feature-loop.cjs');
const FINAL_REPORT = '## What landed\n\nLoop fixed.\n\n## Before\n\nRounds stopped.\n\n## Now\n\nRounds continue.\n\n## Verification\n\nTests pass.\n\n## Remaining\n\nNone.';
const {
    blockReason,
    currentBranch,
    driverArmReceipt,
    driverCloseReceipt,
    runsDriverVerb,
    featureLoopPhase,
    featureLoopState,
    bashExit,
} = require('../bin/guard-session-feature-loop.cjs');

function assistant(uuid, parentUuid, content) {
    return {
        uuid,
        parentUuid,
        isSidechain: false,
        type: 'assistant',
        message: { role: 'assistant', content },
    };
}

function user(uuid, parentUuid, content) {
    return {
        uuid,
        parentUuid,
        isSidechain: false,
        type: 'user',
        message: { role: 'user', content },
    };
}

function bridgeCall(uuid, parentUuid, id = 'bridge-1') {
    return assistant(uuid, parentUuid, [{
        type: 'tool_use',
        id,
        name: 'mcp__plugin_qol-sessions_qol-sessions__session_bridge',
        input: {},
    }]);
}

function bridgeResult(uuid, parentUuid, text, options = {}) {
    return user(uuid, parentUuid, [{
        type: 'tool_result',
        tool_use_id: options.id ?? 'bridge-1',
        is_error: options.isError ?? false,
        content: [{ type: 'text', text }],
    }]);
}

function loopCloseCall(uuid, parentUuid, id = 'close-1') {
    return assistant(uuid, parentUuid, [{
        type: 'tool_use',
        id,
        name: 'mcp__plugin_qol-sessions_qol-sessions__session_loop_close',
        input: {
            outcome: 'accepted',
            landed: 'Loop fixed.',
            before: 'Rounds stopped.',
            now: 'Rounds continue.',
            verification: 'Tests pass.',
            remaining: 'None.',
        },
    }]);
}

function loopCloseResult(uuid, parentUuid, text, options = {}) {
    return user(uuid, parentUuid, [{
        type: 'tool_result',
        tool_use_id: options.id ?? 'close-1',
        is_error: options.isError ?? false,
        content: [{ type: 'text', text }],
    }]);
}

function writeTranscript(entries) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-sessions-stop-'));
    const transcript = path.join(root, 'transcript.jsonl');
    fs.writeFileSync(transcript, entries.map((entry) => JSON.stringify(entry)).join('\n'));
    return { root, transcript };
}

function writeCheckpoint(storeDir, name, record) {
    fs.mkdirSync(storeDir, { recursive: true });
    fs.writeFileSync(path.join(storeDir, name), JSON.stringify(record));
}

function runHook(entries, overrides = {}) {
    const { root, transcript } = writeTranscript(entries);
    const emptyStore = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-empty-store-'));
    try {
        return spawnSync('node', [HOOK], {
            input: JSON.stringify({
                hook_event_name: 'Stop',
                transcript_path: transcript,
                checkpoint_dir: emptyStore,
                ...overrides,
            }),
            encoding: 'utf8',
        });
    } finally {
        fs.rmSync(root, { recursive: true });
        fs.rmSync(emptyStore, { recursive: true });
    }
}

function bridgeAndClose(entries, outcome = 'accepted', id = 'close-1') {
    entries.push(bridgeCall('call', null));
    entries.push(bridgeResult('result', 'call', '{"completed":true,"completion_marker":"QOL_BRIDGE_DONE_123"}'));
    entries.push(loopCloseCall('close', 'result', id));
    entries.push(loopCloseResult(
        'closed',
        'close',
        JSON.stringify({ loop_closed: true, outcome, final_report: FINAL_REPORT }),
        { id },
    ));
}

test('an open loop blocks the stop until whole-feature acceptance', () => {
    const entries = [
        assistant('root', null, 'delegate the implementation'),
        bridgeCall('call', 'root'),
        bridgeResult('result', 'call', '{"completed":true,"completion_marker":"QOL_BRIDGE_DONE_123"}'),
        assistant('round', 'result', 'Round 1 accepted. Next round is gated on another decision.'),
    ];
    assert.equal(featureLoopPhase(entries), 'review');
    const result = runHook(entries);
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /Do not finish at a round boundary/);
    assert.match(output.reason, /The loop ends only when session_loop_close succeeds/);
});

test('a successful loop-close receipt closes the loop immediately', () => {
    const entries = [];
    bridgeAndClose(entries);
    assert.equal(featureLoopPhase(entries), 'idle');
    const result = runHook(entries);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
});

test('a close receipt persisted to a file still closes the loop', () => {
    const receipt = JSON.stringify({ loop_closed: true, outcome: 'accepted', final_report: FINAL_REPORT });
    const entries = [
        bridgeCall('call', null),
        bridgeResult('result', 'call', '{"completed":true,"completion_marker":"QOL_BRIDGE_DONE_123"}'),
        loopCloseCall('close', 'result'),
        loopCloseResult(
            'closed',
            'close',
            `<persisted-output>\nOutput too large (61.1KB). Full output saved to: /tmp/tool-results/x.json\n\nPreview (first 2KB):\n[\n  {\n    "type": "text",\n    "text": "${receipt.replace(/"/g, '\\"')}\n...\n</persisted-output>`,
        ),
    ];
    assert.equal(featureLoopPhase(entries), 'idle');
    const result = runHook(entries);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
});

test('close-then-summary passes the stop without re-emitting the report', () => {
    const entries = [];
    bridgeAndClose(entries);
    const summary = 'Landed: guard fix. Verified: tests pass. Remaining: none.';
    entries.push(assistant('final', 'closed', summary));
    assert.equal(featureLoopPhase(entries), 'idle');
    const flushed = runHook(entries);
    assert.equal(flushed.status, 0);
    assert.equal(flushed.stdout, '');
    const pending = runHook(entries, {
        last_assistant_message: [{ type: 'text', text: summary }],
    });
    assert.equal(pending.status, 0);
    assert.equal(pending.stdout, '');
});

test('legacy prose markers cannot bypass typed loop closure', () => {
    const entries = [
        bridgeCall('call', null),
        bridgeResult('result', 'call', '{"completed":true,"completion_marker":"QOL_BRIDGE_DONE_123"}'),
    ];
    const result = runHook(entries, {
        last_assistant_message: [{ type: 'text', text: 'Accepted.\n[qol-sessions:feature-accepted]' }],
    });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).decision, 'block');
});

test('an explicit paused receipt closes the loop without a verbatim report', () => {
    const entries = [];
    bridgeAndClose(entries, 'paused');
    entries.push(assistant('final', 'closed', 'Paused on a blocker; recorded under remaining.'));
    assert.equal(featureLoopPhase(entries), 'idle');
    assert.equal(runHook(entries).stdout, '');
});

test('failed, malformed, or unrelated close receipts cannot end the loop', () => {
    const base = [
        bridgeCall('call', null),
        bridgeResult('result', 'call', '{"completed":true,"completion_marker":"QOL_BRIDGE_DONE_123"}'),
    ];
    const failed = [
        ...base,
        loopCloseCall('close', 'result'),
        loopCloseResult('closed', 'close', 'invalid outcome', { isError: true }),
    ];
    const malformed = [
        ...base,
        loopCloseCall('close', 'result'),
        loopCloseResult('closed', 'close', '{"loop_closed":false,"final_report":"x"}'),
    ];
    const unrelated = [
        ...base,
        user('unrelated', 'result', [{
            type: 'tool_result',
            tool_use_id: 'different-tool',
            content: '{"loop_closed":true}',
        }]),
    ];
    assert.equal(featureLoopPhase(failed), 'review');
    assert.equal(featureLoopPhase(malformed), 'review');
    assert.equal(featureLoopPhase(unrelated), 'review');
    for (const entries of [failed, malformed, unrelated]) {
        const result = runHook(entries);
        assert.equal(result.status, 0);
        assert.equal(JSON.parse(result.stdout).decision, 'block');
    }
});

test('a pending background round permits the stop; the watcher owns the wake', () => {
    const entries = [
        bridgeCall('call', null),
        bridgeResult(
            'result',
            'call',
            'MCP tool is still running after 120s. It was moved to the background and keeps running.',
        ),
        assistant('stopped', 'result', 'Running in the background.'),
    ];
    assert.equal(featureLoopPhase(entries), 'waiting');
    const result = runHook(entries, { stop_hook_active: true });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
});

test('completed false and bridge errors leave the loop armed and unreviewed', () => {
    const timedOut = [
        bridgeCall('call', null),
        bridgeResult('result', 'call', '{"completed":false,"completion_marker":"QOL_BRIDGE_DONE_123"}'),
    ];
    assert.equal(featureLoopPhase(timedOut), 'paused');
    const timedResult = runHook(timedOut);
    assert.equal(timedResult.status, 0);
    assert.equal(JSON.parse(timedResult.stdout).decision, 'block');

    const failed = [
        bridgeCall('call', null),
        bridgeResult('result', 'call', 'transport failed', { isError: true }),
    ];
    assert.equal(featureLoopPhase(failed), 'paused');
    const failedResult = runHook(failed);
    assert.equal(failedResult.status, 0);
    assert.equal(JSON.parse(failedResult.stdout).decision, 'block');
});

test('a host continuation outcome advances a waiting bridge', () => {
    const entries = [
        bridgeCall('call', null),
        bridgeResult('background', 'call', 'still running; moved to the background'),
        assistant('wait-call', 'background', [{
            type: 'tool_use',
            id: 'wait-1',
            name: 'TaskOutput',
            input: {},
        }]),
        user('wait-result', 'wait-call', [{
            type: 'tool_result',
            tool_use_id: 'wait-1',
            content: '{"completed":true,"completion_marker":"QOL_BRIDGE_DONE_456"}',
        }]),
    ];
    assert.equal(featureLoopPhase(entries), 'review');
});

test('only the active transcript branch controls the loop', () => {
    const entries = [
        assistant('root', null, 'start'),
        bridgeCall('abandoned-call', 'root'),
        bridgeResult(
            'abandoned-result',
            'abandoned-call',
            '{"completed":true,"completion_marker":"QOL_BRIDGE_DONE_123"}',
        ),
        assistant('current', 'root', 'unrelated branch'),
    ];
    assert.deepEqual(currentBranch(entries).map((entry) => entry.uuid), ['root', 'current']);
    assert.equal(featureLoopPhase(entries), 'idle');
    assert.equal(runHook(entries).stdout, '');
});

test('a later bridge re-arms a previously accepted feature loop', () => {
    const entries = [];
    bridgeAndClose(entries);
    entries.push(assistant('final', 'closed', 'Landed. Remaining: none.'));
    entries.push(bridgeCall('call-2', 'final', 'bridge-2'));
    entries.push(bridgeResult(
        'result-2',
        'call-2',
        '{"completed":true,"completion_marker":"QOL_BRIDGE_DONE_456"}',
        { id: 'bridge-2' },
    ));
    assert.equal(featureLoopPhase(entries), 'review');
});

test('malformed or unrelated Stop payloads fail open', () => {
    const malformed = spawnSync('node', [HOOK], { input: 'not-json', encoding: 'utf8' });
    assert.equal(malformed.status, 0);
    assert.equal(malformed.stdout, '');
    const wrongEvent = runHook([], { hook_event_name: 'UserPromptSubmit' });
    assert.equal(wrongEvent.status, 0);
    assert.equal(wrongEvent.stdout, '');
    assert.match(blockReason(), /session_loop_close with the final response session and completion_marker/);
    assert.match(blockReason(), /session_loop_close with outcome paused/);
    assert.doesNotMatch(blockReason(), /qol sessions next/);
});

test('review-phase plus a pending sibling checkpoint permits the stop', () => {
    const entries = [
        bridgeCall('call', null),
        bridgeResult('result', 'call', '{"completed":true,"completion_marker":"QOL_BRIDGE_DONE_A"}'),
    ];
    assert.equal(featureLoopPhase(entries), 'review');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-sessions-store-'));
    try {
        const store = path.join(root, 'pending-bridge');
        writeCheckpoint(store, 'role-lane.json', { role: 'lane' });
        writeCheckpoint(store, 'sibling.json', {
            session: 'sib',
            driver: 'architect-1',
            completion_marker: 'QOL_BRIDGE_DONE_B',
            completed: false,
            closed: false,
        });
        const result = runHook(entries, { checkpoint_dir: store, initiator: 'architect-1' });
        assert.equal(result.status, 0);
        assert.equal(result.stdout, '');
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});

test('review-phase with no pending checkpoint still blocks', () => {
    const entries = [
        bridgeCall('call', null),
        bridgeResult('result', 'call', '{"completed":true,"completion_marker":"QOL_BRIDGE_DONE_A"}'),
    ];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-sessions-store-'));
    try {
        const store = path.join(root, 'pending-bridge');
        fs.mkdirSync(store, { recursive: true });
        writeCheckpoint(store, 'done.json', {
            session: 'a',
            driver: 'architect-1',
            completion_marker: 'QOL_BRIDGE_DONE_C',
            completed: true,
            closed: false,
        });
        const result = runHook(entries, { checkpoint_dir: store, initiator: 'architect-1' });
        assert.equal(result.status, 0);
        assert.equal(JSON.parse(result.stdout).decision, 'block');
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});

test('unreadable or missing checkpoint_dir falls back to blocking', () => {
    const entries = [
        bridgeCall('call', null),
        bridgeResult('result', 'call', '{"completed":true,"completion_marker":"QOL_BRIDGE_DONE_A"}'),
    ];
    const missing = runHook(entries, { checkpoint_dir: '/nonexistent/qol-pending-bridge', initiator: 'architect-1' });
    assert.equal(missing.status, 0);
    assert.equal(JSON.parse(missing.stdout).decision, 'block');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-sessions-store-'));
    try {
        const notADir = path.join(root, 'not-a-dir');
        fs.writeFileSync(notADir, 'x');
        const unreadable = runHook(entries, { checkpoint_dir: notADir, initiator: 'architect-1' });
        assert.equal(unreadable.status, 0);
        assert.equal(JSON.parse(unreadable.stdout).decision, 'block');
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});

test('a pending checkpoint with a different driver does not permit the stop', () => {
    const entries = [
        bridgeCall('call', null),
        bridgeResult('result', 'call', '{"completed":true,"completion_marker":"QOL_BRIDGE_DONE_A"}'),
    ];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-sessions-store-'));
    try {
        const store = path.join(root, 'pending-bridge');
        writeCheckpoint(store, 'foreign.json', {
            session: 'other',
            driver: 'other-architect',
            completion_marker: 'QOL_BRIDGE_DONE_D',
            completed: false,
            closed: false,
        });
        const result = runHook(entries, { checkpoint_dir: store, initiator: 'architect-1' });
        assert.equal(result.status, 0);
        assert.equal(JSON.parse(result.stdout).decision, 'block');
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});

test('all checkpoints closed by this initiator permits the stop even after a file-redirected receipt', () => {
    const entries = [
        bridgeCall('call', null),
        bridgeResult('result', 'call', '{"completed":true,"completion_marker":"QOL_BRIDGE_DONE_A"}'),
        loopCloseCall('close', 'result'),
        loopCloseResult(
            'closed',
            'close',
            '<persisted-output>\nOutput too large (600.2KB). Full output saved to: /tmp/tool-results/close.json\n\nPreview (first 2KB):\n[{"loop_closed":true...</persisted-output>',
        ),
    ];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-sessions-store-'));
    try {
        const store = path.join(root, 'pending-bridge');
        writeCheckpoint(store, 'named.json', {
            session: 'named',
            driver: 'architect-1',
            completion_marker: 'QOL_BRIDGE_DONE_A',
            completed: true,
            closed: true,
        });
        writeCheckpoint(store, 'sib-one.json', {
            session: 'sib-1',
            driver: 'architect-1',
            completion_marker: 'QOL_BRIDGE_DONE_B',
            completed: true,
            closed: true,
        });
        const result = runHook(entries, { checkpoint_dir: store, initiator: 'architect-1' });
        assert.equal(result.status, 0);
        assert.equal(result.stdout, '');
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});

test('a closed:false sibling without any pending round still blocks (no close evidence)', () => {
    const entries = [
        bridgeCall('call', null),
        bridgeResult('result', 'call', '{"completed":true,"completion_marker":"QOL_BRIDGE_DONE_A"}'),
    ];
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-sessions-store-'));
    try {
        const store = path.join(root, 'pending-bridge');
        writeCheckpoint(store, 'done.json', {
            session: 'a',
            driver: 'architect-1',
            completion_marker: 'QOL_BRIDGE_DONE_C',
            completed: true,
            closed: false,
        });
        const result = runHook(entries, { checkpoint_dir: store, initiator: 'architect-1' });
        assert.equal(result.status, 0);
        assert.equal(JSON.parse(result.stdout).decision, 'block');
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});

const ARMED_RECEIPT = JSON.stringify({ loop_armed: true, key: 'k1', base: 'abc123', spec_sha: 'def456' });
const CLOSED_RECEIPT = JSON.stringify({
    loop_closed: true,
    final_report: { outcome: 'accepted', key: 'k1', attempts: 1, gate: 'clean', remaining: '', worktree: '/tmp/wt' },
});

function bashCall(uuid, parentUuid, id, command, input = {}) {
    return assistant(uuid, parentUuid, [{
        type: 'tool_use',
        id,
        name: 'Bash',
        input: { command, ...input },
    }]);
}

function bashResult(uuid, parentUuid, id, text, isError = false) {
    return user(uuid, parentUuid, [{
        type: 'tool_result',
        tool_use_id: id,
        is_error: isError,
        content: [{ type: 'text', text }],
    }]);
}

function openedLoop(text = ARMED_RECEIPT) {
    return [
        bashCall('open-call', null, 'open-1', 'qols loop open k1 --spec spec.md'),
        bashResult('open-result', 'open-call', 'open-1', text),
    ];
}

test('a driver open receipt arms the loop and the Stop guard blocks', () => {
    const entries = openedLoop();
    assert.equal(featureLoopPhase(entries), 'review');
    const result = runHook(entries);
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /qols loop close/);
});

test('a driver open receipt among other output and in pretty form still arms', () => {
    const noisy = openedLoop(`baseline gate: clean\n${ARMED_RECEIPT}\n`);
    const pretty = openedLoop(JSON.stringify({ loop_armed: true, key: 'k1' }, null, 2));
    const escaped = openedLoop('<persisted-output>\nPreview: {\\"loop_armed\\": true, \\"key\\": \\"k1\\"}\n</persisted-output>');
    for (const entries of [noisy, pretty, escaped]) {
        assert.equal(featureLoopPhase(entries), 'review');
        assert.equal(JSON.parse(runHook(entries).stdout).decision, 'block');
    }
});

test('a backgrounded driver run lets the turn end and its task notification re-arms the block', () => {
    const entries = [
        ...openedLoop(),
        bashCall('run-call', 'open-result', 'run-1', 'qols loop run k1', { run_in_background: true }),
        bashResult('run-result', 'run-call', 'run-1', 'Command running in background with ID: bg-1.'),
        assistant('ended', 'run-result', 'Lane running; ending the turn.'),
    ];
    assert.equal(featureLoopPhase(entries), 'waiting');
    const waiting = runHook(entries);
    assert.equal(waiting.status, 0);
    assert.equal(waiting.stdout, '');

    const woken = [
        ...entries,
        user('notice', 'ended', '<task-notification>\n<task-id>bg-1</task-id>\n<status>completed</status>\n</task-notification>'),
    ];
    assert.equal(featureLoopPhase(woken), 'review');
    assert.equal(JSON.parse(runHook(woken).stdout).decision, 'block');

    const woken2 = [
        ...entries,
        user('notice', 'ended', [{ type: 'text', text: '<task-notification>\n<status>completed</status>\n</task-notification>' }]),
    ];
    assert.equal(featureLoopPhase(woken2), 'review');
});

test('a foreground driver run keeps the loop in review', () => {
    const entries = [
        ...openedLoop(),
        bashCall('gate-call', 'open-result', 'gate-1', 'qols loop run k1 --gate-only'),
        bashResult('gate-result', 'gate-call', 'gate-1', '{"gate":"clean"}'),
    ];
    assert.equal(featureLoopPhase(entries), 'review');
    assert.equal(JSON.parse(runHook(entries).stdout).decision, 'block');
});

test('the driver close receipt disarms the loop', () => {
    const entries = [
        ...openedLoop(),
        bashCall('close-call', 'open-result', 'close-1', 'qols loop close k1 --outcome accepted'),
        bashResult('close-result', 'close-call', 'close-1', CLOSED_RECEIPT),
    ];
    assert.equal(featureLoopPhase(entries), 'idle');
    const result = runHook(entries);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
    const summary = [...entries, assistant('final', 'close-result', 'Accepted; nothing remains.')];
    assert.equal(runHook(summary).stdout, '');
});

test('a driver close receipt with a string report or a persisted preview also disarms', () => {
    const stringReport = JSON.stringify({ loop_closed: true, final_report: FINAL_REPORT });
    const persisted = `<persisted-output>\nPreview: {\\"loop_closed\\": true, \\"final_report\\": {\\"outcome\\": \\"paused\\"}}\n</persisted-output>`;
    for (const receipt of [stringReport, persisted, `closing worktrees\n${CLOSED_RECEIPT}\n`]) {
        const entries = [
            ...openedLoop(),
            bashCall('close-call', 'open-result', 'close-1', 'qols loop close k1 --outcome paused'),
            bashResult('close-result', 'close-call', 'close-1', receipt),
        ];
        assert.equal(featureLoopPhase(entries), 'idle');
        assert.equal(runHook(entries).stdout, '');
    }
});

test('failed, partial, or unrelated Bash output cannot arm or disarm a driver loop', () => {
    const failedOpen = openedLoop();
    failedOpen[1] = bashResult('open-result', 'open-call', 'open-1', ARMED_RECEIPT, true);
    assert.equal(featureLoopPhase(failedOpen), 'idle');
    assert.equal(runHook(failedOpen).stdout, '');

    const falseArm = openedLoop('{"loop_armed":false,"key":"k1"}');
    assert.equal(featureLoopPhase(falseArm), 'idle');

    const unrelated = openedLoop('nothing to see here');
    assert.equal(featureLoopPhase(unrelated), 'idle');

    for (const receipt of [
        '{"loop_closed":false,"final_report":{"outcome":"accepted"}}',
        '{"loop_closed":true}',
        '{"loop_closed":true,"final_report":""}',
        'qols: unknown outcome',
    ]) {
        const entries = [
            ...openedLoop(),
            bashCall('close-call', 'open-result', 'close-1', 'qols loop close k1 --outcome accepted'),
            bashResult('close-result', 'close-call', 'close-1', receipt),
        ];
        assert.equal(featureLoopPhase(entries), 'review');
        assert.equal(JSON.parse(runHook(entries).stdout).decision, 'block');
    }

    const erroredClose = [
        ...openedLoop(),
        bashCall('close-call', 'open-result', 'close-1', 'qols loop close k1 --outcome accepted'),
        bashResult('close-result', 'close-call', 'close-1', CLOSED_RECEIPT, true),
    ];
    assert.equal(featureLoopPhase(erroredClose), 'review');
});

test('a receipt in a result that is not from a Bash call is ignored', () => {
    const entries = [
        user('stray', null, [{
            type: 'tool_result',
            tool_use_id: 'unknown-call',
            content: [{ type: 'text', text: ARMED_RECEIPT }],
        }]),
    ];
    assert.equal(featureLoopPhase(entries), 'idle');
});

test('a later open re-arms a closed driver loop', () => {
    const entries = [
        ...openedLoop(),
        bashCall('close-call', 'open-result', 'close-1', 'qols loop close k1 --outcome accepted'),
        bashResult('close-result', 'close-call', 'close-1', CLOSED_RECEIPT),
        bashCall('open2-call', 'close-result', 'open-2', 'qols loop open k1-v2 --spec spec.md'),
        bashResult('open2-result', 'open2-call', 'open-2', ARMED_RECEIPT.replace('k1', 'k1-v2')),
    ];
    assert.equal(featureLoopPhase(entries), 'review');
});

test('Bash output does not change an engine-armed loop', () => {
    const entries = [
        bridgeCall('call', null),
        bridgeResult('result', 'call', '{"completed":true,"completion_marker":"QOL_BRIDGE_DONE_123"}'),
        bashCall('bash-call', 'result', 'bash-1', 'qols loop run k1', { run_in_background: true }),
        bashResult('bash-result', 'bash-call', 'bash-1', 'Command running in background with ID: bg-1.'),
    ];
    assert.equal(featureLoopPhase(entries), 'review');
    const waiting = [
        bridgeCall('call', null),
        bridgeResult('result', 'call', 'still running; moved to the background'),
        user('notice', 'result', '<task-notification>done</task-notification>'),
    ];
    assert.equal(featureLoopPhase(waiting), 'waiting');
});

test('receipt helpers accept only complete driver receipts', () => {
    assert.ok(driverArmReceipt(ARMED_RECEIPT));
    assert.ok(!driverArmReceipt('{"loop_armed":false}'));
    assert.ok(driverCloseReceipt(CLOSED_RECEIPT));
    assert.ok(!driverCloseReceipt('{"loop_closed":true}'));
    assert.ok(!driverCloseReceipt('{"loop_closed":false,"final_report":{"a":1}}'));
});

test('a cat of a file containing a receipt does not arm or disarm a driver loop', () => {
    const catted = [
        bashCall('cat-call', null, 'cat-1', 'cat plugins/qol-sessions/test/guard-session-feature-loop.test.cjs'),
        bashResult('cat-result', 'cat-call', 'cat-1', `const R = '${ARMED_RECEIPT}';`),
    ];
    assert.equal(featureLoopPhase(catted), 'idle');
    assert.equal(runHook(catted).stdout, '');

    const echoed = [
        bashCall('echo-call', null, 'echo-1', 'echo "qols loop open k1"'),
        bashResult('echo-result', 'echo-call', 'echo-1', ARMED_RECEIPT),
    ];
    assert.equal(featureLoopPhase(echoed), 'idle');

    const closeCatted = [
        ...openedLoop(),
        bashCall('cat-call', 'open-result', 'cat-1', 'cat notes/close-receipt.json'),
        bashResult('cat-result', 'cat-call', 'cat-1', CLOSED_RECEIPT),
    ];
    assert.equal(featureLoopPhase(closeCatted), 'review');
    assert.equal(JSON.parse(runHook(closeCatted).stdout).decision, 'block');
});

test('the real qols loop and loop.mjs open and close commands arm and disarm', () => {
    const opens = [
        'qols loop open k1 --spec spec.md',
        'node plugins/qol-sessions/scripts/loop.mjs open k1 --spec spec.md',
        'cd /repo && qols loop open k1 --spec spec.md --pretty',
        'QOLS_HEADLESS_LANES=1 qols loop open k1 --spec spec.md',
    ];
    for (const command of opens) {
        const armed = [
            bashCall('open-call', null, 'open-1', command),
            bashResult('open-result', 'open-call', 'open-1', ARMED_RECEIPT),
        ];
        assert.equal(featureLoopPhase(armed), 'review', command);
        assert.equal(JSON.parse(runHook(armed).stdout).decision, 'block', command);
        const closed = [
            ...armed,
            bashCall('close-call', 'open-result', 'close-1', command.replace(' open ', ' close ')),
            bashResult('close-result', 'close-call', 'close-1', CLOSED_RECEIPT),
        ];
        assert.equal(featureLoopPhase(closed), 'idle', command);
        assert.equal(runHook(closed).stdout, '', command);
    }
});

test('runsDriverVerb matches only commands that run the driver verb', () => {
    assert.ok(runsDriverVerb('qols loop open k1', 'open'));
    assert.ok(runsDriverVerb('node scripts/loop.mjs close k1 --outcome accepted', 'close'));
    assert.ok(!runsDriverVerb('qols loop open k1', 'close'));
    assert.ok(!runsDriverVerb('cat loop.mjs', 'open'));
    assert.ok(!runsDriverVerb('rg "qols loop open" docs', 'open'));
    assert.ok(!runsDriverVerb(undefined, 'open'));
});

function runResult(exit, body) {
    return [
        bashCall('run-call', 'open-result', 'run-1', 'qols loop run k1'),
        bashResult('run-result', 'run-call', 'run-1', exit === 0 ? body : `Exit code ${exit}\n${body}`, exit !== 0),
    ];
}

test('driver run exits 11, 13 and 14 are user boundaries that allow the stop', () => {
    const bodies = {
        11: '{"result":{"state":"needs_trust","reason":"untrusted"}}',
        13: '{"result":{"state":"question","question":"which file?"}}',
        14: '{"result":{"state":"handover","briefs":["/tmp/brief.md"]}}',
    };
    for (const [exit, body] of Object.entries(bodies)) {
        const entries = [...openedLoop(), ...runResult(Number(exit), body)];
        assert.equal(featureLoopPhase(entries), 'user', exit);
        const result = runHook(entries);
        assert.equal(result.status, 0);
        assert.equal(result.stdout, '', exit);
    }
});

test('a driver run after a user boundary blocks the stop again', () => {
    const entries = [
        ...openedLoop(),
        ...runResult(14, '{"result":{"state":"handover"}}'),
        bashCall('gate-call', 'run-result', 'gate-1', 'qols loop run k1 --gate-only'),
        bashResult('gate-result', 'gate-call', 'gate-1', '{"result":{"state":"green"}}'),
    ];
    assert.equal(featureLoopPhase(entries), 'review');
    assert.equal(JSON.parse(runHook(entries).stdout).decision, 'block');
});

test('driver run exit 12 blocks the stop and the text names qols loop verdict', () => {
    const entries = [...openedLoop(), ...runResult(12, '{"result":{"state":"escalation"}}')];
    assert.equal(featureLoopState(entries).escalated, true);
    const output = JSON.parse(runHook(entries).stdout);
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /qols loop verdict k1 --blame/);
    assert.match(output.reason, /exit 12/);
});

test('driver run exits 0 and 10 keep the plain block text', () => {
    for (const exit of [0, 10]) {
        const entries = [...openedLoop(), ...runResult(exit, '{"result":{"state":"green"}}')];
        const output = JSON.parse(runHook(entries).stdout);
        assert.equal(output.decision, 'block');
        assert.doesNotMatch(output.reason, /qols loop verdict/);
    }
});

test('a run result without the exit prefix still maps its state to a user boundary', () => {
    assert.equal(bashExit('{"result":{"state":"handover"}}'), 14);
    assert.equal(bashExit('{"state":"needs_trust"}'), 11);
    assert.equal(bashExit('{"result":{"state":"question"}}'), 13);
    assert.equal(bashExit('{"result":{"state":"escalation"}}'), 12);
    assert.equal(bashExit('Exit code 10\n{}'), 10);
    assert.equal(bashExit('{"result":{"state":"green"}}'), null);
    const entries = [
        ...openedLoop(),
        bashCall('run-call', 'open-result', 'run-1', 'qols loop run k1'),
        bashResult('run-result', 'run-call', 'run-1', '{"result":{"state":"handover"}}'),
    ];
    assert.equal(featureLoopPhase(entries), 'user');
});

test('a foreign pending checkpoint without an initiator cannot release a driver loop', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-foreign-store-'));
    try {
        const store = path.join(root, 'pending-bridge');
        writeCheckpoint(store, 'foreign.json', {
            session: 'other',
            driver: 'someone-else',
            completion_marker: 'QOL_BRIDGE_DONE_X',
            completed: false,
            closed: false,
        });
        const pending = runHook(openedLoop(), { checkpoint_dir: store });
        assert.equal(JSON.parse(pending.stdout).decision, 'block');

        fs.rmSync(store, { recursive: true });
        writeCheckpoint(store, 'closed.json', {
            session: 'other',
            driver: 'someone-else',
            completion_marker: 'QOL_BRIDGE_DONE_Y',
            completed: true,
            closed: true,
        });
        const closedStore = runHook(openedLoop(), { checkpoint_dir: store });
        assert.equal(JSON.parse(closedStore.stdout).decision, 'block');
    } finally {
        fs.rmSync(root, { recursive: true });
    }
});

test('a pretty close line disarms the driver loop', () => {
    const entries = [
        ...openedLoop(),
        bashCall('close-call', 'open-result', 'close-1', 'qols loop close k1 --outcome accepted --pretty'),
        bashResult('close-result', 'close-call', 'close-1', 'loop k1 closed accepted: 2 attempts, gate clean\nkept worktree /tmp/wt\nremaining: None.'),
    ];
    assert.equal(featureLoopPhase(entries), 'idle');
    assert.equal(runHook(entries).stdout, '');
});

test('a pretty open line arms the driver loop', () => {
    const entries = openedLoop('loop k1 armed on abcdef123456 via handover\n  worktree 1: /tmp/wt (loop-k1)');
    assert.equal(featureLoopPhase(entries), 'review');
});

test('closing one of two driver loops keeps the stop blocked until the other closes', () => {
    const closeOf = (key) => JSON.stringify({
        loop_closed: true,
        final_report: { outcome: 'accepted', key, attempts: 1, gate: 'clean', remaining: 'None.', worktree: '/tmp/wt' },
    });
    const entries = [
        ...openedLoop(),
        bashCall('open2-call', 'open-result', 'open-2', 'qols loop open k2 --spec spec.md'),
        bashResult('open2-result', 'open2-call', 'open-2', JSON.stringify({ loop_armed: true, key: 'k2' })),
        bashCall('close-call', 'open2-result', 'close-1', 'qols loop close k1 --outcome accepted'),
        bashResult('close-result', 'close-call', 'close-1', closeOf('k1')),
    ];
    assert.equal(featureLoopPhase(entries), 'review');
    assert.deepEqual(featureLoopState(entries).keys, ['k2']);
    assert.equal(JSON.parse(runHook(entries).stdout).decision, 'block');

    const both = [
        ...entries,
        bashCall('close2-call', 'close-result', 'close-2', 'qols loop close k2 --outcome accepted'),
        bashResult('close2-result', 'close2-call', 'close-2', closeOf('k2')),
    ];
    assert.equal(featureLoopPhase(both), 'idle');
    assert.equal(runHook(both).stdout, '');
});
