'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'route-to-agent.cjs');
const { classifyAgent } = require('../bin/route-to-agent.cjs');

function run(payload) {
    const r = spawnSync('node', [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
    });
    return { exitCode: r.status, stderr: r.stderr };
}

test('classifyAgent recognizes ui/ as frontend', () => {
    assert.equal(classifyAgent('/x/qol-tray/ui/components/App.js'), 'qol-host:qol-tray-frontend');
    assert.equal(classifyAgent('/x/qol-tray/ui/lib/foo.js'), 'qol-host:qol-tray-frontend');
    assert.equal(classifyAgent('/x/qol-tray/ui/styles/bar.css'), 'qol-host:qol-tray-frontend');
});

test('classifyAgent recognizes src/ as backend', () => {
    assert.equal(classifyAgent('/x/qol-tray/src/main.rs'), 'qol-host:qol-tray-backend');
    assert.equal(classifyAgent('/x/qol-tray/src/plugins/manager.rs'), 'qol-host:qol-tray-backend');
});

test('classifyAgent ignores files outside qol-tray', () => {
    assert.equal(classifyAgent('/x/some-other/src/foo.rs'), null);
    assert.equal(classifyAgent('/x/qol-tray/Cargo.toml'), null);
});

test('blocks main-Claude Edit on qol-tray/src', () => {
    const r = run({
        tool_name: 'Edit',
        tool_input: { file_path: '/x/qol-tools/qol-tray/src/main.rs', new_string: 'foo' },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /qol-tray-backend/);
});

test('passes when agent_type is set (subagent run)', () => {
    const r = run({
        tool_name: 'Edit',
        agent_type: 'qol-host:qol-tray-backend',
        tool_input: { file_path: '/x/qol-tools/qol-tray/src/main.rs', new_string: 'foo' },
    });
    assert.equal(r.exitCode, 0);
});

test('passes hook-owned files (MEMORY.md, .reflect-last.log)', () => {
    const r1 = run({
        tool_name: 'Edit',
        tool_input: { file_path: '/x/qol-tools/qol-tray/src/MEMORY.md', new_string: 'foo' },
    });
    assert.equal(r1.exitCode, 0);
    const r2 = run({
        tool_name: 'Edit',
        tool_input: { file_path: '/x/qol-tools/qol-tray/ui/lib/.reflect-last.log', new_string: 'foo' },
    });
    assert.equal(r2.exitCode, 0);
});

test('passes files outside the routing scope', () => {
    const r = run({
        tool_name: 'Edit',
        tool_input: { file_path: '/x/some/random/file.rs', new_string: 'foo' },
    });
    assert.equal(r.exitCode, 0);
});

test('passes non-Edit tools', () => {
    const r = run({
        tool_name: 'Bash',
        tool_input: { command: 'ls' },
    });
    assert.equal(r.exitCode, 0);
});

test('bypass marker (count=1) consumes and removes', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'route-bypass-'));
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    const marker = path.join(cwd, '.claude', 'bypass-agent-routing');
    fs.writeFileSync(marker, '');
    try {
        const r = run({
            tool_name: 'Edit',
            cwd,
            tool_input: { file_path: '/x/qol-tools/qol-tray/src/main.rs', new_string: 'foo' },
        });
        assert.equal(r.exitCode, 0);
        assert.equal(fs.existsSync(marker), false, 'marker should be removed after single use');
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});

test('bypass marker (count=N) decrements without removal', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'route-bypass-n-'));
    fs.mkdirSync(path.join(cwd, '.claude'), { recursive: true });
    const marker = path.join(cwd, '.claude', 'bypass-agent-routing');
    fs.writeFileSync(marker, '3');
    try {
        const r = run({
            tool_name: 'Edit',
            cwd,
            tool_input: { file_path: '/x/qol-tools/qol-tray/src/main.rs', new_string: 'foo' },
        });
        assert.equal(r.exitCode, 0);
        assert.equal(fs.readFileSync(marker, 'utf8'), '2');
    } finally {
        fs.rmSync(cwd, { recursive: true, force: true });
    }
});
