'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin');
const OUTSIDE = '/home/u/Git/Economy';

const CASES = [
    ['commit-skill-context.cjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: "git commit -m 'fix: x'" } }],
    ['branch-deny-agent-checkout.cjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: ['git', 'switch', '-c', 'feat/x'].join(' ') } }],
    ['pr-watch-context.cjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: "gh pr create --title 'fix: x' --body x" } }],
    ['pr-watch-park-guard.cjs', { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'node bin/pr-watch.cjs 1' } }],
];

for (const [script, payload] of CASES) {
    test(`${script} stays silent outside a qol-* tree`, () => {
        const r = spawnSync('node', [path.join(BIN, script)], {
            input: JSON.stringify({ ...payload, cwd: OUTSIDE }),
            encoding: 'utf8',
        });
        assert.equal(r.status, 0);
        assert.equal(r.stdout, '');
    });
}
