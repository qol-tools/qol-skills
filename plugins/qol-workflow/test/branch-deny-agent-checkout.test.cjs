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
    return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

function parseDecision(stdout) {
    if (!stdout.trim()) return null;
    const obj = JSON.parse(stdout);
    return obj.hookSpecificOutput && obj.hookSpecificOutput.permissionDecision;
}

const askedFor = [
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

const allowedSilently = [
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

test('asks for approval on branch switches and detached-HEAD checkouts', () => {
    for (const cmd of askedFor) {
        const r = run(cmd);
        assert.strictEqual(r.exitCode, 0, `expected exit 0 (ask) for: ${cmd}\nstderr: ${r.stderr}`);
        const decision = parseDecision(r.stdout);
        assert.strictEqual(decision, 'ask', `expected permissionDecision=ask for: ${cmd}\nstdout: ${r.stdout}`);
    }
});

test('allows silently for file reverts, worktree add, and unrelated commands', () => {
    for (const cmd of allowedSilently) {
        const r = run(cmd);
        assert.strictEqual(r.exitCode, 0, `expected exit 0 for: ${cmd}\nstderr: ${r.stderr}`);
        assert.strictEqual(r.stdout.trim(), '', `expected empty stdout for: ${cmd}\nstdout: ${r.stdout}`);
    }
});

test('handles empty payload (returns 0, no output)', () => {
    const r = spawnSync('node', [HOOK], { input: '', encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
});

test('handles non-Bash tool payload (returns 0, no output)', () => {
    const r = spawnSync('node', [HOOK], {
        input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/tmp/x' } }),
        encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
});

test('handles malformed JSON payload (returns 0, no output)', () => {
    const r = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf8' });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout.trim(), '');
});
