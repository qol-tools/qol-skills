'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'inject-session-bridge-context.cjs');
const SKILL = path.join(__dirname, '..', 'skills', 'qol-sessions', 'SKILL.md');
const {
    BRIDGE_CONTEXT,
    BRIDGE_TOPIC_PATTERN,
    shouldInject,
} = require('../bin/inject-session-bridge-context.cjs');

function run(payload) {
    return spawnSync('node', [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
    });
}

test('bridge topics are role-based and model-invariant', () => {
    assert.ok(BRIDGE_TOPIC_PATTERN.test('delegate this to an implementation agent'));
    assert.ok(BRIDGE_TOPIC_PATTERN.test('bridge two terminals'));
    assert.ok(BRIDGE_TOPIC_PATTERN.test('the architect should review the handoff'));
    assert.doesNotMatch(BRIDGE_CONTEXT, /gpt|claude|codex|kimi|deepseek|fable/i);
});

test('unrelated prompts stay silent', () => {
    assert.ok(!shouldInject({ prompt: 'fix the settings panel padding' }));
    const result = run({ hook_event_name: 'UserPromptSubmit', prompt: 'fix padding' });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
});

test('matching prompts receive the event-driven feature loop', () => {
    for (const prompt of [
        'hand off implementation to another agent terminal',
        'send it to the agent',
        'await the agent response',
    ]) {
        const result = run({ hook_event_name: 'UserPromptSubmit', prompt });
        assert.equal(result.status, 0);
        const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
        assert.match(context, /sessions_list/);
        assert.match(context, /session_bridge/);
        assert.match(context, /one bounded implementation round at a time/);
        assert.match(context, /completion hook wake you/);
        assert.match(context, /Never wake the reasoning loop to poll/);
        assert.match(context, /background completion waiter/);
        assert.match(context, /ready for review, not feature acceptance/);
        assert.match(context, /another bounded correction round unless the feature meets/);
        assert.match(context, /Continue until the architect accepts the feature/);
    }
});

test('the skill requires an event-driven review loop through feature acceptance', () => {
    const skill = fs.readFileSync(SKILL, 'utf8');
    assert.match(skill, /one event-driven transaction per implementation round/);
    assert.match(skill, /Invoke `session_bridge` exactly once for the current round/);
    assert.match(skill, /register that handle exactly once/);
    assert.match(skill, /Never poll a process, continuation handle, screen, session, status, or clock/);
    assert.match(skill, /A round-complete event means ready for architect review; it never means the feature is accepted/);
    assert.match(skill, /return to step 3 with the same session/);
    assert.match(skill, /Finish only when the architect has accepted the feature/);
    assert.match(skill, /Do not use `read`, `send`, `wait`, or `focus` as an agent fallback/);
});

test('the implementation bridge envelope does not receive architect instructions', () => {
    const result = run({
        hook_event_name: 'UserPromptSubmit',
        prompt: '[qol session bridge]\nAct as the implementation agent. Do not delegate it.',
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
});

test('other hook events and malformed input stay silent', () => {
    const wrongEvent = run({ hook_event_name: 'PreToolUse', prompt: 'bridge agents' });
    assert.equal(wrongEvent.status, 0);
    assert.equal(wrongEvent.stdout, '');

    const malformed = spawnSync('node', [HOOK], { input: 'not-json', encoding: 'utf8' });
    assert.equal(malformed.status, 0);
    assert.equal(malformed.stdout, '');
});
