'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'route-to-agent.cjs');
const { classifyScope } = require('../bin/route-to-agent.cjs');

function run(payload) {
    const r = spawnSync('node', [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
    });
    return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('classifyScope recognizes ui/ as frontend', () => {
    assert.equal(classifyScope('/x/qol-tray/ui/components/App.js'), 'frontend');
    assert.equal(classifyScope('/x/qol-tray/ui/lib/foo.js'), 'frontend');
    assert.equal(classifyScope('/x/qol-tray/ui/styles/bar.css'), 'frontend');
});

test('classifyScope recognizes src/ as backend', () => {
    assert.equal(classifyScope('/x/qol-tray/src/main.rs'), 'backend');
    assert.equal(classifyScope('/x/qol-tray/src/plugins/manager.rs'), 'backend');
});

test('classifyScope ignores files outside qol-tray scope', () => {
    assert.equal(classifyScope('/x/some-other/src/foo.rs'), null);
    assert.equal(classifyScope('/x/qol-tray/Cargo.toml'), null);
});

test('exits 0 and emits additionalContext JSON for backend edit', () => {
    const r = run({
        tool_name: 'Edit',
        tool_input: { file_path: '/x/qol-tools/qol-tray/src/main.rs', new_string: 'foo' },
    });
    assert.equal(r.exitCode, 0, `unexpected exit ${r.exitCode}: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.ok(out.hookSpecificOutput?.additionalContext, 'expected additionalContext');
    assert.match(out.hookSpecificOutput.additionalContext, /backend/);
});

test('exits 0 and emits additionalContext JSON for frontend edit', () => {
    const r = run({
        tool_name: 'Edit',
        tool_input: { file_path: '/x/qol-tools/qol-tray/ui/components/App.js', new_string: 'foo' },
    });
    assert.equal(r.exitCode, 0, `unexpected exit ${r.exitCode}: ${r.stderr}`);
    const out = JSON.parse(r.stdout);
    assert.ok(out.hookSpecificOutput?.additionalContext, 'expected additionalContext');
    assert.match(out.hookSpecificOutput.additionalContext, /frontend/);
});

test('exits 0 silently for hook-owned files (MEMORY.md, .reflect-last.log)', () => {
    const r1 = run({
        tool_name: 'Edit',
        tool_input: { file_path: '/x/qol-tools/qol-tray/src/MEMORY.md', new_string: 'foo' },
    });
    assert.equal(r1.exitCode, 0);
    assert.equal(r1.stdout.trim(), '');

    const r2 = run({
        tool_name: 'Edit',
        tool_input: { file_path: '/x/qol-tools/qol-tray/ui/lib/.reflect-last.log', new_string: 'foo' },
    });
    assert.equal(r2.exitCode, 0);
    assert.equal(r2.stdout.trim(), '');
});

test('exits 0 silently for files outside routing scope', () => {
    const r = run({
        tool_name: 'Edit',
        tool_input: { file_path: '/x/some/random/file.rs', new_string: 'foo' },
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim(), '');
});

test('exits 0 silently for non-Edit tools', () => {
    const r = run({
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim(), '');
});
