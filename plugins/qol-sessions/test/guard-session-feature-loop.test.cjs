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
    featureLoopPhase,
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
