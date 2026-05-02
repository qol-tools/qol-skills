'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'check-qol-architecture.cjs');

function run(payload) {
    const result = spawnSync('node', [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
    });
    return { exitCode: result.status, stderr: result.stderr };
}

test('blocks cfg(all(target_os, feature)) gating non-OS module', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/src/hotkeys/mod.rs',
            content: '#[cfg(all(target_os = "linux", feature = "foo"))]\nmod capture;\n',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /qol-architecture violation/);
});

test('passes canonical multi-line cfg + mod re-export pattern', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/src/platform/mod.rs',
            content:
                '#[cfg(target_os = "linux")]\nmod linux;\n#[cfg(target_os = "linux")]\npub use linux::Platform;\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('blocks compile_error! anywhere', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/src/lib.rs',
            content:
                '#[cfg(not(target_os = "linux"))]\ncompile_error!("only Linux");\n',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /compile_error!/);
});

test('passes same-line cfg + mod re-export pattern', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/src/platform/mod.rs',
            content: '#[cfg(target_os = "linux")] mod linux;\n#[cfg(target_os = "macos")] mod macos;\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('passes files outside the qol-tools workspace', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/some/other/repo/src/foo.rs',
            content: '#[cfg(target_os = "linux")] pub fn evil() {}\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('passes files literally named linux.rs / macos.rs / windows.rs', () => {
    for (const name of ['linux.rs', 'macos.rs', 'windows.rs']) {
        const r = run({
            tool_name: 'Write',
            tool_input: {
                file_path: `/x/qol-tools/foo/src/platform/${name}`,
                content: '#[cfg(target_os = "linux")] pub fn anything() {}\n',
            },
        });
        assert.equal(r.exitCode, 0, `expected pass for ${name}`);
    }
});

test('blocks cfg(target_os) gating a pub fn in business code', () => {
    const r = run({
        tool_name: 'Edit',
        tool_input: {
            file_path: '/x/qol-tools/foo/src/hotkeys/mod.rs',
            new_string:
                '#[cfg(all(target_os = "linux", feature = "linux_evdev"))]\npub fn start_evdev_capture() {}\n',
        },
    });
    assert.equal(r.exitCode, 2);
});

test('passes stacked attributes ending in canonical re-export', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/src/platform/mod.rs',
            content: '#[cfg(target_os = "linux")]\n#[allow(dead_code)]\nmod linux;\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('blocks cfg(any(target_os)) gating non-OS item', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/src/lib.rs',
            content:
                '#[cfg(any(target_os = "linux", target_os = "macos"))]\npub fn unix_thing() {}\n',
        },
    });
    assert.equal(r.exitCode, 2);
});

test('passes feature-only cfg (no target_os involved)', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/src/lib.rs',
            content: '#[cfg(feature = "dev")]\npub fn dev_thing() {}\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('passes when subagent is the caller', () => {
    const r = run({
        tool_name: 'Write',
        agent_type: 'qol-host:qol-tray-backend',
        tool_input: {
            file_path: '/x/qol-tools/foo/src/lib.rs',
            content: '#[cfg(target_os = "linux")] pub fn foo() {}\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('passes test files', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/tests/integration.rs',
            content: '#[cfg(target_os = "linux")] fn t() {}\n',
        },
    });
    assert.equal(r.exitCode, 0);
});
