'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'inject-qol-cli-context.cjs');

function run(cwd) {
    return spawnSync('node', [HOOK], { input: JSON.stringify({ hook_event_name: 'SessionStart', cwd }), encoding: 'utf8' });
}

test('injects the qol CLI context inside a qol-* tree', () => {
    const r = run('/home/u/Git/qol-monorepo');
    assert.equal(r.status, 0);
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.additionalContext, /qol CLI live command context/);
});

test('stays silent outside a qol-* tree', () => {
    const r = run('/home/u/Git/Economy');
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
});
