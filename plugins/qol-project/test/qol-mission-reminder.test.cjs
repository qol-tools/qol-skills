'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'qol-mission-reminder.cjs');

function run(prompt, cwd) {
    const r = spawnSync('node', [HOOK], {
        input: JSON.stringify({ prompt, cwd }),
        encoding: 'utf8',
    });
    return { exit: r.status, stdout: r.stdout };
}

test('reminds on design-shaped prompts inside a qol-* repo', () => {
    const cases = [
        '/a/b/Git/qol-monorepo',
        '/a/b/Git/qol-monorepo/plugins/plugin-lights',
        '/a/b/Git/worktrees/wasm/qol-monorepo',
        '/a/b/Git/qol-skills',
    ];
    for (const cwd of cases) {
        const r = run('should we widen the scope of this feature?', cwd);
        assert.strictEqual(r.exit, 0, `cwd: ${cwd}`);
        assert.match(r.stdout, /qol-mission reminder/, `cwd: ${cwd}`);
    }
});

test('stays silent outside qol-* repos', () => {
    const r = run('should we widen the scope of this feature?', '/home/x/other-repo');
    assert.strictEqual(r.exit, 0);
    assert.strictEqual(r.stdout, '');
});

test('stays silent for non-design prompts in a qol-* repo', () => {
    const r = run('rename this variable please and thanks', '/a/b/Git/qol-monorepo');
    assert.strictEqual(r.exit, 0);
    assert.strictEqual(r.stdout, '');
});
