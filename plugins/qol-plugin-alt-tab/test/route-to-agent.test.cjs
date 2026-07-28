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

function plugin(t, directory, pluginId) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-tab-scope-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, 'plugins', directory);
    for (const sub of ['src', 'ui', 'tests']) {
        fs.mkdirSync(path.join(dir, sub), { recursive: true });
    }
    fs.writeFileSync(path.join(dir, 'plugin.toml'), `[plugin]\nid = "${pluginId}"\nname = "X"\n`);
    return dir;
}

const SCOPED_RELATIVE_PATHS = [
    'src/main.rs',
    'ui/foo.html',
    'tests/integration.rs',
    'plugin.toml',
    'Cargo.toml',
];

test('scope follows the declared id, not the directory name', (t) => {
    const cases = ['alt-tab', 'plugin-alt-tab', 'renamed-later'];
    for (const directory of cases) {
        const dir = plugin(t, directory, 'plugin-alt-tab');
        for (const rel of SCOPED_RELATIVE_PATHS) {
            assert.ok(inScope(path.join(dir, rel)), `expected in scope: ${directory}/${rel}`);
        }
    }
});

test('inScope excludes unscoped paths', (t) => {
    const other = plugin(t, 'alt-tab', 'plugin-launcher');
    assert.ok(!inScope(path.join(other, 'src', 'main.rs')), 'other plugin id');

    const mine = plugin(t, 'alt-tab', 'plugin-alt-tab');
    assert.ok(!inScope(path.join(mine, 'docs', 'notes.md')), 'unscoped subdirectory');

    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-tab-nomanifest-'));
    t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
    assert.ok(!inScope(path.join(bare, 'src', 'main.rs')), 'no owning manifest');
});

test('AGENT is the specialist subagent name', () => {
    assert.equal(AGENT, 'qol-plugin-alt-tab:plugin-alt-tab');
});

test('blocks main-Claude Edit on src/', (t) => {
    const dir = plugin(t, 'alt-tab', 'plugin-alt-tab');
    const r = run({
        tool_name: 'Edit',
        tool_input: { file_path: path.join(dir, 'src', 'main.rs'), new_string: 'foo' },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /qol-plugin-alt-tab:plugin-alt-tab/);
});

test('passes when run inside the agent', (t) => {
    const dir = plugin(t, 'alt-tab', 'plugin-alt-tab');
    const r = run({
        tool_name: 'Edit',
        agent_type: 'qol-plugin-alt-tab:plugin-alt-tab',
        tool_input: { file_path: path.join(dir, 'src', 'main.rs'), new_string: 'foo' },
    });
    assert.equal(r.exitCode, 0);
});

test('passes hook-owned files (MEMORY/log/README/CHANGELOG)', (t) => {
    const dir = plugin(t, 'alt-tab', 'plugin-alt-tab');
    for (const f of ['MEMORY.md', '.reflect-last.log', 'README.md', 'CHANGELOG.md']) {
        const r = run({
            tool_name: 'Edit',
            tool_input: { file_path: path.join(dir, f), new_string: 'x' },
        });
        assert.equal(r.exitCode, 0, `expected pass for ${f}`);
    }
});

test('bypass marker consumes', (t) => {
    const dir = plugin(t, 'alt-tab', 'plugin-alt-tab');
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'alt-tab-bypass-'));
    t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(cwd, '.claude', 'bypass-agent-routing'), '');
    const r = run({
        tool_name: 'Edit',
        cwd,
        tool_input: { file_path: path.join(dir, 'src', 'main.rs'), new_string: 'x' },
    });
    assert.equal(r.exitCode, 0);
});
