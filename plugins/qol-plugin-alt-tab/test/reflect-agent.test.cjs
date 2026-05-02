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

test('ELIGIBLE_AGENTS only matches plugin-alt-tab variants', () => {
    assert.ok(ELIGIBLE_AGENTS.has('plugin-alt-tab'));
    assert.ok(ELIGIBLE_AGENTS.has('qol-plugin-alt-tab:plugin-alt-tab'));
    assert.ok(!ELIGIBLE_AGENTS.has('qol-tray-frontend'));
    assert.ok(!ELIGIBLE_AGENTS.has('plugin-lights'));
});

test('isCliTruncation detects "prompt is too long"', () => {
    assert.ok(isCliTruncation('Prompt is too long for max tokens'));
    assert.ok(!isCliTruncation('NONE'));
});

test('extractBullets keeps bulleted lines only', () => {
    const out = extractBullets('Header\n- one\n- two\nfooter');
    assert.equal(out, '- one\n- two');
});

test('isParaphraseOfExisting detects rewording', () => {
    const memory = normalizeForDedup('always route launcher commands through ToggleSwitch');
    assert.ok(isParaphraseOfExisting('route through ToggleSwitch when invoking launcher commands', memory));
});

test('truncateToLastN keeps last N lines', () => {
    assert.equal(truncateToLastN('a\nb\nc\nd\ne', 2), 'd\ne');
});

test('buildPrompt embeds (empty) when memory is blank', () => {
    const out = buildPrompt({ agentType: 'plugin-alt-tab', existingMemory: '', transcript: 't' });
    assert.match(out, /<existing_memory>\n\(empty\)\n<\/existing_memory>/);
});
