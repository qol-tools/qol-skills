'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
    isCliTruncation,
    extractBullets,
    isParaphraseOfExisting,
    normalizeForDedup,
    truncateToLastN,
    buildPrompt,
    ELIGIBLE_AGENTS,
} = require('../bin/reflect-agent.cjs');

test('ELIGIBLE_AGENTS only matches plugin-lights variants', () => {
    assert.ok(ELIGIBLE_AGENTS.has('plugin-lights'));
    assert.ok(ELIGIBLE_AGENTS.has('qol-plugin-lights:plugin-lights'));
    assert.ok(!ELIGIBLE_AGENTS.has('plugin-alt-tab'));
});

test('isCliTruncation detects "prompt is too long"', () => {
    assert.ok(isCliTruncation('Prompt is too long'));
    assert.ok(!isCliTruncation('NONE'));
});

test('extractBullets keeps bulleted lines only', () => {
    assert.equal(extractBullets('Header\n- a\n- b'), '- a\n- b');
});

test('isParaphraseOfExisting catches reword', () => {
    const memory = normalizeForDedup('always pair MQTT broker URL with the host network namespace');
    assert.ok(isParaphraseOfExisting('pair MQTT broker URL with the host network namespace correctly', memory));
});

test('truncateToLastN keeps last N lines', () => {
    assert.equal(truncateToLastN('a\nb\nc\nd', 2), 'c\nd');
});

test('buildPrompt embeds (empty) when memory is blank', () => {
    const out = buildPrompt({ agentType: 'plugin-lights', existingMemory: '', transcript: 't' });
    assert.match(out, /<existing_memory>\n\(empty\)\n<\/existing_memory>/);
});
