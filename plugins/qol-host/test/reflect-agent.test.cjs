'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    isCliTruncation,
    isCliError,
    extractBullets,
    normalizeForDedup,
    isParaphraseOfExisting,
    filterAgainstExisting,
    truncateToLastN,
    buildPrompt,
    readTranscriptTail,
    ELIGIBLE_AGENTS,
} = require('../bin/reflect-agent.cjs');

test('ELIGIBLE_AGENTS lists qol-tray frontend/backend in both bare and namespaced form', () => {
    assert.ok(ELIGIBLE_AGENTS.has('qol-tray-frontend'));
    assert.ok(ELIGIBLE_AGENTS.has('qol-tray-backend'));
    assert.ok(ELIGIBLE_AGENTS.has('qol-host:qol-tray-frontend'));
    assert.ok(ELIGIBLE_AGENTS.has('qol-host:qol-tray-backend'));
    assert.ok(!ELIGIBLE_AGENTS.has('plugin-alt-tab'));
});

test('isCliTruncation matches known truncation messages', () => {
    assert.ok(isCliTruncation('Prompt is too long'));
    assert.ok(isCliTruncation('Error: prompt is too long for max tokens'));
    assert.ok(isCliTruncation('Exceeds maximum context length of 200000'));
    assert.ok(!isCliTruncation('All good'));
    assert.ok(!isCliTruncation('NONE'));
    assert.ok(!isCliTruncation(''));
});

test('isCliError matches typical CLI errors', () => {
    assert.ok(isCliError('Error: bad request'));
    assert.ok(isCliError('error: invalid token'));
    assert.ok(isCliError('Invalid model'));
    assert.ok(isCliError('API Error: 502'));
    assert.ok(!isCliError('- a real bullet'));
    assert.ok(!isCliError('NONE'));
});

test('extractBullets keeps only bulleted lines', () => {
    const input = `Sure, here are the lessons:
- always test the panic hook
- never sleep for hard waits
random trailing prose`;
    const out = extractBullets(input);
    assert.equal(out, '- always test the panic hook\n- never sleep for hard waits');
});

test('extractBullets returns empty when no bullets present', () => {
    assert.equal(extractBullets('Just prose, no bullets.'), '');
});

test('normalizeForDedup lowercases and strips punctuation', () => {
    assert.equal(normalizeForDedup('Hello, World! 123'), 'hello world 123');
    assert.equal(normalizeForDedup('  multi   spaces  '), 'multi spaces');
});

test('isParaphraseOfExisting flags overlap above 60% of distinctive words', () => {
    const memory = normalizeForDedup('always route launcher commands through ToggleSwitch');
    const para = 'route through ToggleSwitch when invoking launcher commands';
    assert.ok(isParaphraseOfExisting(para, memory));
});

test('isParaphraseOfExisting passes a genuinely new lesson', () => {
    const memory = normalizeForDedup('always route launcher commands through ToggleSwitch');
    const novel = 'inotify watch on /dev/input requires the input group on Linux';
    assert.ok(!isParaphraseOfExisting(novel, memory));
});

test('isParaphraseOfExisting requires at least 4 distinctive words to fire', () => {
    const memory = normalizeForDedup('one two');
    const candidate = 'short';
    assert.ok(!isParaphraseOfExisting(candidate, memory));
});

test('filterAgainstExisting drops paraphrases and keeps novel bullets', () => {
    const memory = '- always route launcher commands through ToggleSwitch';
    const bullets = `- route through ToggleSwitch when invoking launcher commands
- inotify watch on /dev/input requires the input group on Linux`;
    const filtered = filterAgainstExisting(bullets, memory);
    assert.match(filtered, /inotify watch/);
    assert.doesNotMatch(filtered, /toggleswitch/i);
});

test('truncateToLastN preserves all when content is shorter', () => {
    assert.equal(truncateToLastN('a\nb\nc', 5), 'a\nb\nc');
});

test('truncateToLastN drops oldest lines when content is longer', () => {
    const content = ['l1', 'l2', 'l3', 'l4', 'l5'].join('\n');
    assert.equal(truncateToLastN(content, 3), 'l3\nl4\nl5');
});

test('buildPrompt assembles header, agent, memory, transcript, rules', () => {
    const out = buildPrompt({
        agentType: 'qol-tray-frontend',
        existingMemory: 'prior memory',
        transcript: 'foo bar',
    });
    assert.match(out, /qol-tray-frontend/);
    assert.match(out, /<existing_memory>\nprior memory\n<\/existing_memory>/);
    assert.match(out, /<transcript_tail>\nfoo bar\n<\/transcript_tail>/);
});

test('buildPrompt substitutes (empty) when memory is blank', () => {
    const out = buildPrompt({ agentType: 'a', existingMemory: '', transcript: 't' });
    assert.match(out, /<existing_memory>\n\(empty\)\n<\/existing_memory>/);
});

test('readTranscriptTail returns last byteCap bytes of file', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'reflect-tail-'));
    const file = path.join(tmp, 'transcript.log');
    fs.writeFileSync(file, 'a'.repeat(300));
    try {
        assert.equal(readTranscriptTail(file, 100).length, 100);
        assert.equal(readTranscriptTail(file, 1000).length, 300);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('readTranscriptTail returns empty string when file is missing', () => {
    assert.equal(readTranscriptTail('/nonexistent/path', 100), '');
    assert.equal(readTranscriptTail('', 100), '');
});
