'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'branch-deny-checkout-in-main-clone.cjs');
const { CHECKOUT_OR_SWITCH, classify, isMainClone } = require('../bin/branch-deny-checkout-in-main-clone.cjs');

function withRepo(kind, fn) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-tools-'));
    const repo = path.join(root, 'qol-tools', 'qol-tray');
    fs.mkdirSync(repo, { recursive: true });
    if (kind === 'main') {
        fs.mkdirSync(path.join(repo, '.git'));
    } else if (kind === 'worktree') {
        const treesParent = path.join(root, 'qol-tools', 'worktrees', 'feat-x');
        const wt = path.join(treesParent, 'qol-tray');
        fs.mkdirSync(wt, { recursive: true });
        fs.writeFileSync(path.join(wt, '.git'), 'gitdir: /tmp/x\n');
        fn(wt);
        fs.rmSync(root, { recursive: true, force: true });
        return;
    }
    fn(repo);
    fs.rmSync(root, { recursive: true, force: true });
}

function run(cmd, cwd) {
    const r = spawnSync('node', [HOOK], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command: cmd, cwd } }),
        encoding: 'utf8',
    });
    return { exitCode: r.status, stderr: r.stderr };
}

test('classify recognises -b create flag', () => {
    assert.strictEqual(classify('-b foo').kind, 'create');
    assert.strictEqual(classify('-c foo').kind, 'create');
    assert.strictEqual(classify('-B foo').kind, 'create');
});

test('classify recognises path-checkout (-- separator)', () => {
    assert.strictEqual(classify('-- file.rs').kind, 'path');
    // `git checkout HEAD -- file.rs` is also a path-form (revert file at HEAD); both safe.
    assert.strictEqual(classify('HEAD -- file.rs').kind, 'path');
});

test('classify recognises revision specs', () => {
    assert.strictEqual(classify('HEAD').kind, 'revision');
    assert.strictEqual(classify('abc1234').kind, 'revision');
    assert.strictEqual(classify('HEAD~1').kind, 'revision');
    assert.strictEqual(classify('main^').kind, 'revision');
});

test('classify allows main / master', () => {
    assert.strictEqual(classify('main').kind, 'allowed-branch');
    assert.strictEqual(classify('master').kind, 'allowed-branch');
});

test('classify flags branch switch to feature branch', () => {
    const r = classify('feat-x');
    assert.strictEqual(r.kind, 'branch');
    assert.strictEqual(r.target, 'feat-x');
});

test('hook blocks `git checkout -b` in qol-* main clone', () => {
    withRepo('main', (cwd) => {
        const r = run('git checkout -b feat-x', cwd);
        assert.strictEqual(r.exitCode, 2);
        assert.match(r.stderr, /branch switch BLOCKED/);
    });
});

test('hook blocks `git switch -c` in qol-* main clone', () => {
    withRepo('main', (cwd) => {
        const r = run('git switch -c feat-x', cwd);
        assert.strictEqual(r.exitCode, 2);
    });
});

test('hook blocks `git checkout <other-branch>` in main clone', () => {
    withRepo('main', (cwd) => {
        const r = run('git checkout some-feature', cwd);
        assert.strictEqual(r.exitCode, 2);
    });
});

test('hook allows `git checkout main` in main clone', () => {
    withRepo('main', (cwd) => {
        const r = run('git checkout main', cwd);
        assert.strictEqual(r.exitCode, 0);
    });
});

test('hook allows `git checkout -- <path>` in main clone', () => {
    withRepo('main', (cwd) => {
        const r = run('git checkout -- Cargo.lock', cwd);
        assert.strictEqual(r.exitCode, 0);
    });
});

test('hook allows revision checkout in main clone', () => {
    withRepo('main', (cwd) => {
        const r = run('git checkout HEAD~2', cwd);
        assert.strictEqual(r.exitCode, 0);
    });
});

test('hook allows branch creation inside a worktree', () => {
    withRepo('worktree', (cwd) => {
        const r = run('git checkout -b feat-x', cwd);
        assert.strictEqual(r.exitCode, 0);
    });
});

test('hook honours `# intentional` bypass', () => {
    withRepo('main', (cwd) => {
        const r = run('git checkout -b emergency # intentional', cwd);
        assert.strictEqual(r.exitCode, 0);
    });
});

test('hook ignores non-Bash tools', () => {
    const r = spawnSync('node', [HOOK], {
        input: JSON.stringify({ tool_name: 'Read', tool_input: { file_path: '/x' } }),
        encoding: 'utf8',
    });
    assert.strictEqual(r.status, 0);
});

test('hook ignores non-checkout commands', () => {
    withRepo('main', (cwd) => {
        const r = run('git status', cwd);
        assert.strictEqual(r.exitCode, 0);
    });
});

test('hook ignores commands outside qol-tools tree', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'other-'));
    fs.mkdirSync(path.join(root, '.git'));
    const r = run('git checkout -b feat-x', root);
    assert.strictEqual(r.exitCode, 0);
    fs.rmSync(root, { recursive: true, force: true });
});
