'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const cleanup = require('../bin/cleanup-worktree.cjs');

function makeRunner(responses) {
    const calls = [];
    function runner(opts) {
        calls.push({ cmd: opts.cmd, args: opts.args.slice(), cwd: opts.cwd });
        for (const r of responses) {
            if (r.match(opts)) return r.result;
        }
        return { stdout: '', stderr: '', code: 0 };
    }
    runner.calls = calls;
    return runner;
}

function captureLogs() {
    const out = [], err = [];
    return {
        log: s => out.push(s),
        warn: s => err.push(s),
        out, err,
    };
}

function makeFakeFs(existingPaths) {
    const set = new Set(existingPaths);
    return {
        existsSync: p => set.has(p),
        statSync: () => ({ isFile: () => false }),
    };
}

test('isMergeCommand identifies gh pr merge', () => {
    const cases = [
        ['gh pr merge', true],
        ['gh pr merge 42', true],
        ['gh pr merge 42 --squash', true],
        ['gh pr merge --auto', true],
        ['cd x && gh pr merge 42', true],
        ['gh pr create', false],
        ['gh pr view 42', false],
        ['git merge', false],
        ['echo gh pr merge', false],
    ];
    for (const [cmd, expected] of cases) {
        assert.strictEqual(cleanup.isMergeCommand(cmd), expected, `cmd: ${cmd}`);
    }
});

test('classifyWorktreePath extracts workspace/repo/branch', () => {
    const cases = [
        ['/ws/worktrees/qol-tray/tray-42-foo', { workspace: '/ws', repo: 'qol-tray', branch: 'tray-42-foo' }],
        ['/a/b/c/worktrees/plugin-lights/lights-7-zigbee', { workspace: '/a/b/c', repo: 'plugin-lights', branch: 'lights-7-zigbee' }],
        ['/ws/qol-tray', null],
        ['/random/path', null],
        ['/ws/worktrees/qol-tray', null],
    ];
    for (const [p, expected] of cases) {
        assert.deepStrictEqual(cleanup.classifyWorktreePath(p), expected, `path: ${p}`);
    }
});

test('isToolSuccess returns true for missing/positive responses', () => {
    const cases = [
        [{}, true],
        [{ tool_response: {} }, true],
        [{ tool_response: { success: true } }, true],
        [{ tool_response: { success: false } }, false],
        [{ tool_response: { exit_code: 0 } }, true],
        [{ tool_response: { exit_code: 1 } }, false],
        [{ tool_response: { code: 0 } }, true],
    ];
    for (const [payload, expected] of cases) {
        assert.strictEqual(cleanup.isToolSuccess(payload), expected, `payload: ${JSON.stringify(payload)}`);
    }
});

test('run does nothing for non-Bash tool', () => {
    const runner = makeRunner([]);
    const logs = captureLogs();
    cleanup.run({
        payload: { tool_name: 'Edit', tool_input: {} },
        runner, fs: makeFakeFs([]), log: logs.log, warn: logs.warn,
    });
    assert.deepStrictEqual(runner.calls, []);
});

test('run does nothing for non-merge Bash command', () => {
    const runner = makeRunner([]);
    const logs = captureLogs();
    cleanup.run({
        payload: { tool_name: 'Bash', tool_input: { command: 'gh pr create --draft' } },
        runner, fs: makeFakeFs([]), log: logs.log, warn: logs.warn,
    });
    assert.deepStrictEqual(runner.calls, []);
});

test('run does nothing if tool response indicates failure', () => {
    const runner = makeRunner([]);
    const logs = captureLogs();
    cleanup.run({
        payload: {
            tool_name: 'Bash',
            tool_input: { command: 'gh pr merge 42' },
            tool_response: { exit_code: 1 },
        },
        runner, fs: makeFakeFs([]), log: logs.log, warn: logs.warn,
    });
    assert.deepStrictEqual(runner.calls, []);
});

test('run removes worktree on successful merge in central pool', { skip: process.platform === 'win32' && 'uses POSIX paths' }, () => {
    const worktreePath = '/ws/worktrees/qol-tray/tray-42-fold-installs';
    const mainRepo = '/ws/qol-tray';
    const runner = makeRunner([
        {
            match: o => o.cmd === 'git' && o.args[0] === 'rev-parse',
            result: { stdout: worktreePath + '\n', stderr: '', code: 0 },
        },
        {
            match: o => o.cmd === 'git' && o.args.includes('worktree') && o.args.includes('remove'),
            result: { stdout: '', stderr: '', code: 0 },
        },
    ]);
    const logs = captureLogs();
    cleanup.run({
        payload: {
            tool_name: 'Bash',
            tool_input: { command: 'gh pr merge 42 --squash' },
            cwd: worktreePath,
        },
        runner,
        fs: makeFakeFs([path.join(mainRepo, '.git')]),
        log: logs.log,
        warn: logs.warn,
    });
    const removeCall = runner.calls.find(c => c.args.includes('remove'));
    assert.ok(removeCall, 'should call git worktree remove');
    assert.deepStrictEqual(removeCall.args, ['-C', mainRepo, 'worktree', 'remove', worktreePath]);
    assert.strictEqual(logs.out.length, 1);
    assert.match(logs.out[0], /removed worktree/);
});

test('run warns and skips if worktree path is not in central pool', () => {
    const runner = makeRunner([
        {
            match: o => o.cmd === 'git' && o.args[0] === 'rev-parse',
            result: { stdout: '/random/path\n', stderr: '', code: 0 },
        },
    ]);
    const logs = captureLogs();
    cleanup.run({
        payload: {
            tool_name: 'Bash',
            tool_input: { command: 'gh pr merge' },
            cwd: '/random/path',
        },
        runner, fs: makeFakeFs([]), log: logs.log, warn: logs.warn,
    });
    assert.strictEqual(logs.out.length, 0);
    assert.strictEqual(logs.err.length, 1);
    assert.match(logs.err[0], /not under/);
    assert.strictEqual(runner.calls.filter(c => c.args.includes('remove')).length, 0);
});

test('run warns and skips if branch does not match convention', () => {
    const worktreePath = '/ws/worktrees/qol-tray/some-random-branch';
    const runner = makeRunner([
        {
            match: o => o.cmd === 'git' && o.args[0] === 'rev-parse',
            result: { stdout: worktreePath + '\n', stderr: '', code: 0 },
        },
    ]);
    const logs = captureLogs();
    cleanup.run({
        payload: {
            tool_name: 'Bash',
            tool_input: { command: 'gh pr merge' },
            cwd: worktreePath,
        },
        runner, fs: makeFakeFs([]), log: logs.log, warn: logs.warn,
    });
    assert.strictEqual(logs.out.length, 0);
    assert.match(logs.err[0], /doesn't match arch-pathways convention/);
});

test('run warns when git worktree remove fails', () => {
    const worktreePath = '/ws/worktrees/qol-tray/tray-42-foo';
    const mainRepo = '/ws/qol-tray';
    const runner = makeRunner([
        {
            match: o => o.cmd === 'git' && o.args[0] === 'rev-parse',
            result: { stdout: worktreePath + '\n', stderr: '', code: 0 },
        },
        {
            match: o => o.cmd === 'git' && o.args.includes('remove'),
            result: { stdout: '', stderr: 'uncommitted changes\n', code: 1 },
        },
    ]);
    const logs = captureLogs();
    cleanup.run({
        payload: {
            tool_name: 'Bash',
            tool_input: { command: 'gh pr merge 42' },
            cwd: worktreePath,
        },
        runner,
        fs: makeFakeFs([path.join(mainRepo, '.git')]),
        log: logs.log,
        warn: logs.warn,
    });
    assert.match(logs.err[0], /git worktree remove failed/);
    assert.match(logs.err[0], /uncommitted changes/);
});
