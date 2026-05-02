'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'route-to-agent.cjs');
const { inScope, AGENT } = require('../bin/route-to-agent.cjs');

function run(payload) {
    const r = spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
    return { exitCode: r.status, stderr: r.stderr };
}

test('inScope catches plugin-lights src/, ui/, tests/, and config tomls', () => {
    assert.ok(inScope('/x/plugin-lights/src/main.rs'));
    assert.ok(inScope('/x/plugin-lights/ui/foo.html'));
    assert.ok(inScope('/x/plugin-lights/tests/integration.rs'));
    assert.ok(inScope('/x/plugin-lights/plugin.toml'));
    assert.ok(inScope('/x/plugin-lights/qol-config.toml'));
    assert.ok(inScope('/x/plugin-lights/qol-runtime.toml'));
    assert.ok(inScope('/x/plugin-lights/Cargo.toml'));
});

test('inScope excludes other plugins', () => {
    assert.ok(!inScope('/x/plugin-alt-tab/src/main.rs'));
    assert.ok(!inScope('/x/qol-tray/src/main.rs'));
});

test('AGENT name is correct', () => {
    assert.equal(AGENT, 'qol-plugin-lights:plugin-lights');
});

test('blocks main-Claude Edit on src/', () => {
    const r = run({
        tool_name: 'Edit',
        tool_input: { file_path: '/x/plugin-lights/src/main.rs', new_string: 'foo' },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /qol-plugin-lights:plugin-lights/);
});

test('passes when run inside the plugin-lights agent', () => {
    const r = run({
        tool_name: 'Edit',
        agent_type: 'qol-plugin-lights:plugin-lights',
        tool_input: { file_path: '/x/plugin-lights/src/main.rs', new_string: 'foo' },
    });
    assert.equal(r.exitCode, 0);
});

test('passes hook-owned files', () => {
    for (const f of [
        '/x/plugin-lights/MEMORY.md',
        '/x/plugin-lights/.reflect-last.log',
        '/x/plugin-lights/README.md',
        '/x/plugin-lights/CHANGELOG.md',
    ]) {
        const r = run({
            tool_name: 'Edit',
            tool_input: { file_path: f, new_string: 'x' },
        });
        assert.equal(r.exitCode, 0, `expected pass for ${f}`);
    }
});
