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
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lights-scope-'));
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
    'qol-config.toml',
    'qol-runtime.toml',
    'Cargo.toml',
];

test('scope follows the declared id, not the directory name', (t) => {
    const cases = ['lights', 'plugin-lights', 'renamed-later'];
    for (const directory of cases) {
        const dir = plugin(t, directory, 'plugin-lights');
        for (const rel of SCOPED_RELATIVE_PATHS) {
            assert.ok(inScope(path.join(dir, rel)), `expected in scope: ${directory}/${rel}`);
        }
    }
});

test('inScope excludes unscoped paths', (t) => {
    const other = plugin(t, 'lights', 'plugin-alt-tab');
    assert.ok(!inScope(path.join(other, 'src', 'main.rs')), 'other plugin id');

    const mine = plugin(t, 'lights', 'plugin-lights');
    assert.ok(!inScope(path.join(mine, 'docs', 'notes.md')), 'unscoped subdirectory');

    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'lights-nomanifest-'));
    t.after(() => fs.rmSync(bare, { recursive: true, force: true }));
    assert.ok(!inScope(path.join(bare, 'src', 'main.rs')), 'no owning manifest');
});

test('AGENT name is correct', () => {
    assert.equal(AGENT, 'qol-plugin-lights:plugin-lights');
});

test('blocks main-Claude Edit on src/', (t) => {
    const dir = plugin(t, 'lights', 'plugin-lights');
    const r = run({
        tool_name: 'Edit',
        tool_input: { file_path: path.join(dir, 'src', 'main.rs'), new_string: 'foo' },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /qol-plugin-lights:plugin-lights/);
});

test('passes when run inside the plugin-lights agent', (t) => {
    const dir = plugin(t, 'lights', 'plugin-lights');
    const r = run({
        tool_name: 'Edit',
        agent_type: 'qol-plugin-lights:plugin-lights',
        tool_input: { file_path: path.join(dir, 'src', 'main.rs'), new_string: 'foo' },
    });
    assert.equal(r.exitCode, 0);
});

test('passes hook-owned files', (t) => {
    const dir = plugin(t, 'lights', 'plugin-lights');
    for (const f of ['MEMORY.md', '.reflect-last.log', 'README.md', 'CHANGELOG.md']) {
        const r = run({
            tool_name: 'Edit',
            tool_input: { file_path: path.join(dir, f), new_string: 'x' },
        });
        assert.equal(r.exitCode, 0, `expected pass for ${f}`);
    }
});
