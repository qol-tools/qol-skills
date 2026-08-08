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

function runHook(entries, overrides = {}) {
    const { root, transcript } = writeTranscript(entries);
    try {
        return spawnSync('node', [HOOK], {
            input: JSON.stringify({
                hook_event_name: 'Stop',
                transcript_path: transcript,
                ...overrides,
            }),
            encoding: 'utf8',
        });
    } finally {
        fs.rmSync(root, { recursive: true });
    }
}

test('a completed bridge arms review until whole-feature acceptance', () => {
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
});

test('a successful loop-close receipt requires the canonical final report', () => {
    const entries = [
        bridgeCall('call', null),
        bridgeResult('result', 'call', '{"completed":true,"completion_marker":"QOL_BRIDGE_DONE_123"}'),
        loopCloseCall('close', 'result'),
        loopCloseResult(
            'closed',
            'close',
            JSON.stringify({ loop_closed: true, outcome: 'accepted', final_report: FINAL_REPORT }),
        ),
    ];
    assert.equal(featureLoopPhase(entries), 'closing');
    const result = runHook(entries);
    assert.equal(result.status, 0);
    const output = JSON.parse(result.stdout);
    assert.match(output.reason, /Return this exact canonical final report/);
    assert.match(output.reason, /## What landed/);

    const finalized = [...entries, assistant('final', 'closed', FINAL_REPORT)];
    assert.equal(featureLoopPhase(finalized), 'idle');
    assert.equal(runHook(finalized).stdout, '');
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

test('direct Stop payload recognizes the canonical report before transcript flush', () => {
    const entries = [
        bridgeCall('call', null),
        bridgeResult('result', 'call', '{"completed":true,"completion_marker":"QOL_BRIDGE_DONE_123"}'),
        loopCloseCall('close', 'result'),
        loopCloseResult(
            'closed',
            'close',
            JSON.stringify({ loop_closed: true, outcome: 'accepted', final_report: FINAL_REPORT }),
        ),
    ];
    const result = runHook(entries, {
        last_assistant_message: [{ type: 'text', text: FINAL_REPORT }],
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
});

test('an explicit paused receipt can end the loop', () => {
    const entries = [
        bridgeCall('call', null),
        bridgeResult('result', 'call', '{"completed":true,"completion_marker":"QOL_BRIDGE_DONE_123"}'),
        loopCloseCall('close', 'result'),
        loopCloseResult(
            'closed',
            'close',
            JSON.stringify({ loop_closed: true, outcome: 'paused', final_report: FINAL_REPORT }),
        ),
        assistant('final', 'closed', FINAL_REPORT),
    ];
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
});

test('a background bridge keeps the architect session open without resubmission', () => {
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
    const output = JSON.parse(result.stdout);
    assert.match(output.reason, /single blocking continuation/);
    assert.match(output.reason, /Do not resubmit/);
});

test('completed false and bridge errors pause automatic continuation', () => {
    const timedOut = [
        bridgeCall('call', null),
        bridgeResult('result', 'call', '{"completed":false,"completion_marker":"QOL_BRIDGE_DONE_123"}'),
    ];
    assert.equal(featureLoopPhase(timedOut), 'paused');
    assert.equal(runHook(timedOut).stdout, '');

    const failed = [
        bridgeCall('call', null),
        bridgeResult('result', 'call', 'transport failed', { isError: true }),
    ];
    assert.equal(featureLoopPhase(failed), 'paused');
    assert.equal(runHook(failed).stdout, '');
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
    const entries = [
        bridgeCall('call-1', null, 'bridge-1'),
        bridgeResult(
            'result-1',
            'call-1',
            '{"completed":true,"completion_marker":"QOL_BRIDGE_DONE_123"}',
            { id: 'bridge-1' },
        ),
        loopCloseCall('close', 'result-1'),
        loopCloseResult(
            'closed',
            'close',
            JSON.stringify({ loop_closed: true, outcome: 'accepted', final_report: FINAL_REPORT }),
        ),
        assistant('final', 'closed', FINAL_REPORT),
        bridgeCall('call-2', 'final', 'bridge-2'),
        bridgeResult(
            'result-2',
            'call-2',
            '{"completed":true,"completion_marker":"QOL_BRIDGE_DONE_456"}',
            { id: 'bridge-2' },
        ),
    ];
    assert.equal(featureLoopPhase(entries), 'review');
});

test('malformed or unrelated Stop payloads fail open', () => {
    const malformed = spawnSync('node', [HOOK], { input: 'not-json', encoding: 'utf8' });
    assert.equal(malformed.status, 0);
    assert.equal(malformed.stdout, '');
    const wrongEvent = runHook([], { hook_event_name: 'UserPromptSubmit' });
    assert.equal(wrongEvent.status, 0);
    assert.equal(wrongEvent.stdout, '');
    assert.match(blockReason('review'), /session_loop_close with the final response session and completion_marker/);
    assert.match(blockReason('review'), /session_loop_close with outcome paused/);
});
