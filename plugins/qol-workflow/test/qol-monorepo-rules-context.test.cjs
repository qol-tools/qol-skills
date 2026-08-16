'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'qol-monorepo-rules-context.cjs');
const { alreadyInContext, REMINDER_MARKER } = require('../bin/qol-monorepo-rules-context.cjs');

const QOL_CWD = '/home/kmrh47/git/qol-monorepo';

function run(payload) {
    return spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
}

function transcript(lines) {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qol-rules-')), 'transcript.jsonl');
    fs.writeFileSync(file, lines.map((entry) => JSON.stringify(entry)).join('\n'));
    return file;
}

const reminderEntry = { type: 'user', message: { role: 'user', content: `${REMINDER_MARKER} (plugin:qol-workflow:qol-monorepo-rules skill)` } };
const compactEntry = { type: 'summary', isCompactSummary: true, message: { role: 'user', content: 'summary of earlier work' } };
const plainEntry = { type: 'user', message: { role: 'user', content: 'fix the padding' } };

test('a first prompt in a qol workspace carries the full rules', () => {
    const result = run({ hook_event_name: 'UserPromptSubmit', prompt: 'fix padding', cwd: QOL_CWD });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /qol-tools delivery rules/);
    assert.match(result.stdout, new RegExp(REMINDER_MARKER.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('a prompt whose live context already carries the rules stays silent', () => {
    const file = transcript([plainEntry, reminderEntry, plainEntry]);
    assert.ok(alreadyInContext(file, REMINDER_MARKER));
    const result = run({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'fix padding',
        cwd: QOL_CWD,
        transcript_path: file,
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
});

test('compaction re-arms the rules even though the summary keeps the old branch', () => {
    const file = transcript([reminderEntry, compactEntry, plainEntry]);
    assert.ok(!alreadyInContext(file, REMINDER_MARKER));
    const result = run({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'fix padding',
        cwd: QOL_CWD,
        transcript_path: file,
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /qol-tools delivery rules/);
});

test('a reminder injected after the last compaction still counts as present', () => {
    const file = transcript([plainEntry, compactEntry, reminderEntry, plainEntry]);
    assert.ok(alreadyInContext(file, REMINDER_MARKER));
});

test('an unreadable or absent transcript falls back to injecting', () => {
    assert.ok(!alreadyInContext(undefined, REMINDER_MARKER));
    assert.ok(!alreadyInContext('/nonexistent/transcript.jsonl', REMINDER_MARKER));
});

test('prompts outside a qol workspace and other events stay silent', () => {
    assert.equal(run({ hook_event_name: 'UserPromptSubmit', prompt: 'fix padding', cwd: '/tmp/elsewhere' }).stdout, '');
    assert.equal(run({ hook_event_name: 'PreToolUse', prompt: 'fix padding', cwd: QOL_CWD }).stdout, '');
    assert.equal(spawnSync('node', [HOOK], { input: 'not-json', encoding: 'utf8' }).stdout, '');
});
