'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { decide, targetSession } = require('../bin/deny-watched-round-wait.cjs');

const LANE = 'v1:kitty:k1:42';
const bridge = { tool_name: 'mcp__plugin_qol-sessions_qol-sessions__session_bridge', tool_input: { session: LANE } };
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });

test('a bridge or CLI wait on a watcher-owned round is denied', () => {
    const watched = () => ['watched'];
    for (const payload of [
        bridge,
        bash(`qol sessions resume ${LANE} --timeout-ms 86400000`),
        bash(`qol sessions wait ${LANE}`),
        bash(`qol sessions bridge ${LANE} -- next task`),
    ]) {
        const decision = decide(payload, watched);
        assert.equal(decision?.hookSpecificOutput?.permissionDecision, 'deny', JSON.stringify(payload));
        assert.match(decision.hookSpecificOutput.permissionDecisionReason, /End your turn now/);
    }
});

test('rounds the watcher does not own stay collectable', () => {
    for (const phase of ['waiting', 'collect', 'review', 'stalled', 'gone']) {
        assert.equal(decide(bridge, () => [phase]), null, phase);
    }
    assert.equal(decide(bridge, () => []), null);
});

test('unrelated tools and commands are never inspected', () => {
    let asked = false;
    const probe = () => {
        asked = true;
        return ['watched'];
    };
    assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: '/x' } }, probe), null);
    assert.equal(decide(bash('qol sessions next'), probe), null);
    assert.equal(decide(bash('cargo test'), probe), null);
    assert.equal(asked, false);
    assert.equal(targetSession(bash(`qol sessions resume ${LANE}`)), LANE);
});
