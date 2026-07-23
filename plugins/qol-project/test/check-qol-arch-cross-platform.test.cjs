'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'check-qol-arch-cross-platform.cjs');

function run(payload) {
    const result = spawnSync('node', [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
    });
    return { exitCode: result.status, stderr: result.stderr };
}

function fixtureFeature(parentContent, adapters) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-cross-platform-'));
    const featureDir = path.join(root, 'qol-monorepo', 'libs', 'fixture', 'src', 'feature');
    const platformDir = path.join(featureDir, 'platform');
    fs.mkdirSync(platformDir, { recursive: true });
    const parent = path.join(featureDir, 'mod.rs');
    fs.writeFileSync(parent, parentContent);
    for (const [relativePath, content] of Object.entries(adapters)) {
        const file = path.join(platformDir, relativePath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
    return { parent, platformDir };
}

test('blocks #[allow(dead_code)] in non-platform shared file', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/hotkeys/mod.rs',
            content: '#[allow(dead_code)]\npub fn parse() {}\n',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /qol-arch-cross-platform/);
    assert.match(r.stderr, /dead_code/);
});

test('blocks #[allow(unused_mut)] in non-platform shared file', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/hotkeys/mod.rs',
            content: '#[allow(unused_mut)]\nfn collect(mut v: Vec<u8>) {}\n',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /unused_mut/);
});

test('passes #[allow(dead_code)] inside platform/<os>.rs', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/hotkeys/platform/macos.rs',
            content: '#[allow(dead_code)]\npub(crate) fn stub() {}\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('passes #[allow(unused_mut)] inside platform/linux.rs', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/platform/linux.rs',
            content: '#[allow(unused_mut)]\nfn helper(mut x: Vec<u8>) {}\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('blocks combined #[allow(dead_code, unused_mut)]', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/lib.rs',
            content: '#[allow(dead_code, unused_mut)]\npub fn f(mut x: u32) {}\n',
        },
    });
    assert.equal(r.exitCode, 2);
});

test('blocks #[cfg(target_os = "linux")] on use statement', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/foo.rs',
            content: '#[cfg(target_os = "linux")]\nuse crate::evdev::KeyState;\n',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /use statement/);
});

test('blocks same-line #[cfg(target_os)] use', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/foo.rs',
            content: '#[cfg(target_os = "linux")] use crate::evdev::KeyState;\n',
        },
    });
    assert.equal(r.exitCode, 2);
});

test('blocks #[cfg(target_os)] on pub use statement', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/foo.rs',
            content: '#[cfg(target_os = "linux")]\npub use crate::evdev::KeyState;\n',
        },
    });
    assert.equal(r.exitCode, 2);
});

test('passes cfg-on-use inside platform/', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/platform/linux.rs',
            content: '#[cfg(target_os = "linux")]\nuse x11rb::Connection;\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('blocks helper whose only production consumer is one OS adapter', () => {
    const { platformDir } = fixtureFeature(
        [
            'mod platform;',
            '',
            'pub(crate) fn parse_proc_version(text: &str) -> Option<String> {',
            '    Some(text.to_string())',
            '}',
            '',
            '#[cfg(test)]',
            'mod tests {',
            '    use super::parse_proc_version;',
            '}',
            '',
        ].join('\n'),
        {
            'linux.rs': '',
            'macos.rs': '',
            'windows.rs': '',
        },
    );
    const linux = path.join(platformDir, 'linux.rs');
    const content = [
        'use super::super::parse_proc_version;',
        'pub(crate) fn loaded(text: &str) -> Option<String> { parse_proc_version(text) }',
        '',
    ].join('\n');
    const r = run({
        tool_name: 'Write',
        tool_input: { file_path: linux, content },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /adapter-exclusive shared helper/);
    assert.match(r.stderr, /parse_proc_version.*linux/);
});

test('passes shared helper with a non-platform production consumer', () => {
    const { platformDir } = fixtureFeature(
        [
            'mod platform;',
            'pub(crate) fn normalize(text: &str) -> String { text.to_string() }',
            'pub(crate) fn load(text: &str) -> String { normalize(text) }',
            '',
        ].join('\n'),
        {
            'linux.rs': '',
            'macos.rs': '',
            'windows.rs': '',
        },
    );
    const linux = path.join(platformDir, 'linux.rs');
    const content = [
        'use super::super::normalize;',
        'pub(crate) fn loaded(text: &str) -> String { normalize(text) }',
        '',
    ].join('\n');
    const r = run({
        tool_name: 'Write',
        tool_input: { file_path: linux, content },
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('blocks parent edit that creates a single-adapter helper leak', () => {
    const { parent } = fixtureFeature(
        'mod platform;\n',
        {
            'linux.rs': 'use super::super::parse_proc_version;\n',
            'macos.rs': '',
            'windows.rs': '',
        },
    );
    const r = run({
        tool_name: 'Edit',
        tool_input: {
            file_path: parent,
            old_string: 'mod platform;\n',
            new_string:
                'mod platform;\npub(crate) fn parse_proc_version(text: &str) -> String { text.to_string() }\n',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /parse_proc_version.*linux/);
});

test('does not block an unchanged legacy adapter-exclusive helper', () => {
    const parentContent = [
        'mod platform;',
        'pub(crate) fn parse_proc_version(text: &str) -> String { text.to_string() }',
        '',
    ].join('\n');
    const { parent } = fixtureFeature(
        parentContent,
        {
            'linux.rs': 'use super::super::parse_proc_version;\n',
            'macos.rs': '',
            'windows.rs': '',
        },
    );
    const r = run({
        tool_name: 'Edit',
        tool_input: {
            file_path: parent,
            old_string: 'mod platform;',
            new_string: 'mod platform;',
        },
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('passes cfg-on-mod (canonical pattern, not on use)', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/platform/mod.rs',
            content: '#[cfg(target_os = "linux")]\nmod linux;\n#[cfg(target_os = "linux")]\npub use linux::Platform;\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('passes outside any qol-* repo', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/other/src/foo.rs',
            content: '#[allow(dead_code)]\npub fn x() {}\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('passes test files', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/tests/integration.rs',
            content: '#[allow(dead_code)]\npub fn helper() {}\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('passes _test.rs suffix files', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/foo_test.rs',
            content: '#[allow(dead_code)]\npub fn x() {}\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('blocks cross-platform violations when subagent is the caller', () => {
    const r = run({
        tool_name: 'Write',
        agent_type: 'qol-tray-backend',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/foo.rs',
            content: '#[allow(dead_code)]\npub fn x() {}\n',
        },
    });
    assert.equal(r.exitCode, 2);
});

test('passes non-Rust files', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/Cargo.toml',
            content: '#[allow(dead_code)]\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('passes when no violations present', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/lib.rs',
            content: 'pub fn ok() -> u32 { 42 }\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('passes Edit tool when new_string is clean', () => {
    const r = run({
        tool_name: 'Edit',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/lib.rs',
            old_string: 'old',
            new_string: 'pub fn x() {}',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('blocks Edit tool when new_string contains allow(dead_code)', () => {
    const r = run({
        tool_name: 'Edit',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/lib.rs',
            old_string: 'old',
            new_string: '#[allow(dead_code)] pub fn x() {}',
        },
    });
    assert.equal(r.exitCode, 2);
});

test('handles Windows-style backslash paths', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: 'D:\\a\\qol-monorepo\\src\\hotkeys\\mod.rs',
            content: '#[allow(dead_code)]\npub fn parse() {}\n',
        },
    });
    assert.equal(r.exitCode, 2);
});

test('exempts platform/ on Windows-style paths', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: 'D:\\a\\qol-monorepo\\src\\hotkeys\\platform\\macos.rs',
            content: '#[allow(dead_code)]\npub(crate) fn stub() {}\n',
        },
    });
    assert.equal(r.exitCode, 0);
});
