'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'branch-deny-agent-checkout.cjs');

function run(cmd) {
    const r = spawnSync('node', [HOOK], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd } }),
        encoding: 'utf8',
    });
    return { exitCode: r.status, stderr: r.stderr };
}

const blocked = [
    'git checkout main',
    'git checkout master',
    'git checkout feature-branch',
    'git checkout -b new-branch',
    'git checkout -B new-branch',
    'git switch main',
    'git switch -c new-branch',
    'git switch -C new-branch',
    'git checkout abc1234',
    'git checkout HEAD~2',
    'git checkout main^',
    'cd /tmp/foo && git checkout other',
    'git -C /tmp/foo checkout other',
    'git checkout main # intentional',
];

const allowed = [
    'git checkout -- file.txt',
    'git checkout -- src/foo.rs',
    'git checkout HEAD -- file.txt',
    'git checkout HEAD~1 -- file.txt',
    'git status',
    'git log --oneline',
    'git worktree add -b feature /tmp/wt',
    'git fetch origin main',
    'git rebase main',
    'ls',
    'echo hello',
];

test('blocks branch switches and detached-HEAD checkouts', () => {
    for (const cmd of blocked) {
        const r = run(cmd);
        assert.strictEqual(r.exitCode, 2, `expected block for: ${cmd}\nstderr: ${r.stderr}`);
        assert.match(r.stderr, /BLOCKED/, `stderr should contain BLOCKED for: ${cmd}`);
    }
});

test('allows file reverts, worktree add, and unrelated commands', () => {
    for (const cmd of allowed) {
        const r = run(cmd);
        assert.strictEqual(r.exitCode, 0, `expected allow for: ${cmd}\nstderr: ${r.stderr}`);
    }
});

test('handles empty payload (returns 0)', () => {
    const r = spawnSync('node', [HOOK], { input: '', encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
});

test('handles non-Bash tool payload (returns 0)', () => {
    const r = spawnSync('node', [HOOK], {
        input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' } }),
        encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0);
});

test('handles malformed JSON payload (returns 0)', () => {
    const r = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
});
