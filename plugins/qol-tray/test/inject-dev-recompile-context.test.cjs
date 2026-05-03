'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'inject-dev-recompile-context.cjs');

test('emits valid SessionStart additionalContext envelope', () => {
    const r = spawnSync('node', [HOOK], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    const payload = JSON.parse(r.stdout);
    assert.equal(payload.hookSpecificOutput.hookEventName, 'SessionStart');
    assert.match(payload.hookSpecificOutput.additionalContext, /Recompile button/);
    assert.match(payload.hookSpecificOutput.additionalContext, /qol-tray-dev-recompile/);
});
