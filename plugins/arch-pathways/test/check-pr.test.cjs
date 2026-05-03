'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const checkPr = require('../bin/check-pr.cjs');
const HOOK = path.join(__dirname, '..', 'bin', 'check-pr.cjs');

function runHook(payload, env = {}) {
    const result = spawnSync('node', [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, ...env },
    });
    return { code: result.status, stderr: result.stderr };
}

const WORKSPACE = '/ws';

test('valid gh pr create title passes', () => {
    const v = checkPr.inspectCommand('gh pr create --draft --title "TRAY-42 Fold Installs Into Config Dir" --body x', WORKSPACE);
    assert.deepStrictEqual(v, []);
});

test('invalid gh pr create title fails', () => {
    const cases = [
        'gh pr create --title "fix the bug"',
        'gh pr create --title "TRAY42 Foo"',
        'gh pr create --title "tray-42 foo"',
        'gh pr create --title "[TRAY-42] Foo"',
        'gh pr edit --title "fix bug"',
    ];
    for (const cmd of cases) {
        const v = checkPr.inspectCommand(cmd, WORKSPACE);
        assert.strictEqual(v.length > 0, true, `expected violation for: ${cmd}`);
    }
});

test('gh pr without --title is not blocked (interactive case)', () => {
    const v = checkPr.inspectCommand('gh pr create --draft --body x', WORKSPACE);
    assert.deepStrictEqual(v, []);
});

test('gh pr non-create/edit subcommands ignored', () => {
    const cases = [
        'gh pr list',
        'gh pr view 42',
        'gh pr merge 42',
    ];
    for (const cmd of cases) {
        assert.deepStrictEqual(checkPr.inspectCommand(cmd, WORKSPACE), [], `should pass: ${cmd}`);
    }
});

test('git checkout/switch -b/-c with valid branch passes', () => {
    const cases = [
        'git checkout -b tray-42-fold-installs',
        'git switch -c lights-7-add-zigbee-adapter',
    ];
    for (const cmd of cases) {
        assert.deepStrictEqual(checkPr.inspectCommand(cmd, WORKSPACE), [], `should pass: ${cmd}`);
    }
});

test('git checkout/switch -b/-c with invalid branch fails', () => {
    const cases = [
        'git checkout -b feature/foo',
        'git switch -c TRAY-42-foo',
        'git checkout -b tray-foo',
        'git switch -c main',
    ];
    for (const cmd of cases) {
        const v = checkPr.inspectCommand(cmd, WORKSPACE);
        assert.strictEqual(v.length > 0, true, `expected violation for: ${cmd}`);
    }
});

test('git checkout/switch without -b/-c is ignored', () => {
    const cases = [
        'git checkout main',
        'git switch develop',
        'git checkout -- file.txt',
    ];
    for (const cmd of cases) {
        assert.deepStrictEqual(checkPr.inspectCommand(cmd, WORKSPACE), [], `should pass: ${cmd}`);
    }
});

test('git worktree add with valid branch + central pool path passes', () => {
    const cmd = 'git worktree add -b tray-42-fold-installs /ws/worktrees/qol-tray/tray-42-fold-installs origin/main';
    assert.deepStrictEqual(checkPr.inspectCommand(cmd, WORKSPACE), []);
});

test('git worktree add with bad branch fails', () => {
    const cmd = 'git worktree add -b feature/x /ws/worktrees/qol-tray/feature-x';
    const v = checkPr.inspectCommand(cmd, WORKSPACE);
    assert.strictEqual(v.some(s => /branch/.test(s)), true);
});

test('git worktree add outside central pool fails', () => {
    const cmd = 'git worktree add -b tray-42-foo /tmp/somewhere/tray-42-foo';
    const v = checkPr.inspectCommand(cmd, WORKSPACE);
    assert.strictEqual(v.some(s => /central pool/.test(s)), true);
});

test('git worktree non-add subcommands ignored', () => {
    const cases = [
        'git worktree list',
        'git worktree remove /tmp/x',
        'git worktree prune',
    ];
    for (const cmd of cases) {
        assert.deepStrictEqual(checkPr.inspectCommand(cmd, WORKSPACE), [], `should pass: ${cmd}`);
    }
});

test('chained commands inspect each subcommand', () => {
    const cmd = 'cd /tmp && git checkout -b feature/x && echo done';
    const v = checkPr.inspectCommand(cmd, WORKSPACE);
    assert.strictEqual(v.length > 0, true);
});

test('non-git/gh commands pass through', () => {
    const cases = [
        'ls -la',
        'echo "TRAY-42 wat"',
        'cargo build',
        'bun install',
    ];
    for (const cmd of cases) {
        assert.deepStrictEqual(checkPr.inspectCommand(cmd, WORKSPACE), [], `should pass: ${cmd}`);
    }
});

test('hook exit code 0 for non-Bash tools', () => {
    const r = runHook({ tool_name: 'Edit', tool_input: { file_path: '/x', new_string: 'foo' } });
    assert.strictEqual(r.code, 0);
});

test('hook exit code 0 for valid Bash command', () => {
    const r = runHook({
        tool_name: 'Bash',
        tool_input: { command: 'gh pr create --draft --title "TRAY-42 Fold Installs Into Config Dir" --body x' },
        cwd: '/tmp',
    });
    assert.strictEqual(r.code, 0);
});

test('hook exit code 2 for malformed PR title', () => {
    const r = runHook({
        tool_name: 'Bash',
        tool_input: { command: 'gh pr create --title "fix bug"' },
        cwd: '/tmp',
    });
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /does not match/);
});

test('hook exit code 0 for empty stdin', () => {
    const result = spawnSync('node', [HOOK], { input: '', encoding: 'utf8' });
    assert.strictEqual(result.status, 0);
});

test('hook exit code 0 for malformed JSON stdin', () => {
    const result = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf8' });
    assert.strictEqual(result.status, 0);
});
