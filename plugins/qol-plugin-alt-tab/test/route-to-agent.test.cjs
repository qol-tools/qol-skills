'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'route-to-agent.cjs');
const { inScope, AGENT } = require('../bin/route-to-agent.cjs');

function run(payload) {
    const r = spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
    return { exitCode: r.status, stderr: r.stderr };
}

test('inScope catches plugin-alt-tab src/, ui/, tests/, plugin.toml, Cargo.toml', () => {
    assert.ok(inScope('/x/plugin-alt-tab/src/main.rs'));
    assert.ok(inScope('/x/plugin-alt-tab/ui/foo.html'));
    assert.ok(inScope('/x/plugin-alt-tab/tests/integration.rs'));
    assert.ok(inScope('/x/plugin-alt-tab/plugin.toml'));
    assert.ok(inScope('/x/plugin-alt-tab/Cargo.toml'));
});

test('inScope excludes other repos', () => {
    assert.ok(!inScope('/x/some-other/src/main.rs'));
    assert.ok(!inScope('/x/plugin-launcher/src/main.rs'));
});

test('AGENT is the specialist subagent name', () => {
    assert.equal(AGENT, 'qol-plugin-alt-tab:plugin-alt-tab');
});

test('blocks main-Claude Edit on src/', () => {
    const r = run({
        tool_name: 'Edit',
        tool_input: { file_path: '/x/plugin-alt-tab/src/main.rs', new_string: 'foo' },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /qol-plugin-alt-tab:plugin-alt-tab/);
});

test('passes when run inside the agent', () => {
    const r = run({
        tool_name: 'Edit',
        agent_type: 'qol-plugin-alt-tab:plugin-alt-tab',
        tool_input: { file_path: '/x/plugin-alt-tab/src/main.rs', new_string: 'foo' },
    });
    assert.equal(r.exitCode, 0);
});

test('passes hook-owned files (MEMORY/log/README/CHANGELOG)', () => {
    for (const f of [
        '/x/plugin-alt-tab/MEMORY.md',
        '/x/plugin-alt-tab/.reflect-last.log',
        '/x/plugin-alt-tab/README.md',
        '/x/plugin-alt-tab/CHANGELOG.md',
    ]) {
        const r = run({
            tool_name: 'Edit',
            tool_input: { file_path: f, new_string: 'x' },
        });
        assert.equal(r.exitCode, 0, `expected pass for ${f}`);
    }
});

test('bypass marker consumes', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-tab-bypass-'));
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.claude', 'bypass-agent-routing'), '');
    try {
        const r = run({
            tool_name: 'Edit',
            cwd,
            tool_input: { file_path: '/x/plugin-alt-tab/src/main.rs', new_string: 'x' },
        });
        assert.equal(r.exitCode, 0);
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});
