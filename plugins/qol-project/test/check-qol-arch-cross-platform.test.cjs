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

function writeLinuxCaller(platformDir, name) {
    return run({
        tool_name: 'Write',
        tool_input: {
            file_path: path.join(platformDir, 'linux.rs'),
            content: `use super::super::${name};\npub(crate) fn loaded() { ${name}() }\n`,
        },
    });
}

test('passes a helper whose shared caller lives elsewhere in the crate', () => {
    const { platformDir } = fixtureFeature('mod platform;\npub(crate) fn plane() {}\n', {
        'macos.rs': '',
        'windows.rs': '',
    });
    const app = path.join(platformDir, '..', '..', 'app.rs');
    fs.writeFileSync(app, 'pub(crate) fn start() { crate::feature::plane() }\n');
    const r = writeLinuxCaller(platformDir, 'plane');
    assert.equal(r.exitCode, 0, r.stderr);
});

test('passes a helper that a fallback adapter also consumes', () => {
    const { platformDir } = fixtureFeature('mod platform;\npub(crate) fn checksum() {}\n', {
        'fallback.rs': 'use super::super::checksum;\npub(crate) fn loaded() { checksum() }\n',
    });
    const r = writeLinuxCaller(platformDir, 'checksum');
    assert.equal(r.exitCode, 0, r.stderr);
});

test('ignores methods whose names collide with other types', () => {
    const { platformDir } = fixtureFeature(
        'mod platform;\npub(crate) struct Plane;\nimpl Plane {\n    pub(crate) fn new() -> Self { Plane }\n}\n',
        { 'macos.rs': '', 'windows.rs': '' },
    );
    const r = writeLinuxCaller(platformDir, 'new');
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

test('passes tests.rs module files', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/handle/tests.rs',
            content: '#[cfg(target_os = "linux")]\nuse std::time::Duration;\n',
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

function write(filePath, content) {
    return run({ tool_name: 'Write', tool_input: { file_path: filePath, content } });
}

function fixtureCrate(files) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-cross-platform-'));
    for (const [relativePath, content] of Object.entries(files)) {
        const file = path.join(root, 'qol-monorepo', relativePath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
    return relativePath => path.join(root, 'qol-monorepo', relativePath);
}

test('blocks a Windows system tool started by its bare name', () => {
    for (const tool of ['cmd', 'reg.exe', 'NETSH.EXE', 'explorer.exe']) {
        const r = write(
            '/x/Git/qol-monorepo/libs/demo/src/feature/platform/windows.rs',
            `fn run() { let _ = Command::new("${tool}").status(); }\n`,
        );
        assert.equal(r.exitCode, 2, tool);
        assert.match(r.stderr, /bare name/, tool);
        assert.match(r.stderr, /system_command/, tool);
    }
});

test('passes system tools started through qol_process and bare tools on other OSes', () => {
    const cases = [
        ['/x/Git/qol-monorepo/libs/demo/src/feature/platform/windows.rs',
            'fn run() { let _ = qol_process::system_command("cmd.exe").status(); }\n'],
        ['/x/Git/qol-monorepo/libs/demo/src/feature/platform/linux.rs',
            'fn run() { let _ = Command::new("reg").status(); }\n'],
        ['/x/Git/qol-monorepo/libs/demo/src/feature/platform/unix_fallback.rs',
            'fn run() { let _ = Command::new("cmd").status(); }\n'],
        ['/x/Git/qol-monorepo/libs/demo/src/feature/platform/windows.rs',
            'fn run() {}\n\n#[cfg(test)]\nmod tests {\n    fn junction() { Command::new("cmd"); }\n}\n'],
        ['/x/Git/qol-monorepo/libs/demo/tests/junction.rs',
            'fn junction() { Command::new("cmd"); }\n'],
        ['/x/Git/qol-monorepo/libs/demo/src/feature/platform/windows.rs',
            'fn run() { let _ = Command::new("cmdlet-runner").status(); }\n'],
    ];
    for (const [filePath, content] of cases) {
        assert.equal(write(filePath, content).exitCode, 0, `${filePath}\n${content}`);
    }
});

test('blocks a tray or plugin spawn that does not hide its console', () => {
    for (const filePath of [
        '/x/Git/qol-monorepo/plugins/demo/src/session/git.rs',
        '/x/Git/qol-monorepo/apps/tray/src/features/store/command.rs',
    ]) {
        const r = write(filePath, 'fn branch() { let _ = Command::new("git").output(); }\n');
        assert.equal(r.exitCode, 2, filePath);
        assert.match(r.stderr, /console window/, filePath);
        assert.match(r.stderr, /hide_console_window/, filePath);
    }
});

test('passes a hidden plugin spawn, a library spawn and a Linux adapter spawn', () => {
    const cases = [
        ['/x/Git/qol-monorepo/plugins/demo/src/session/git.rs',
            'fn branch() {\n    let mut command = tokio::process::Command::new("git");\n'
            + '    qol_process::hide_console_window(command.as_std_mut());\n}\n'],
        ['/x/Git/qol-monorepo/libs/demo/src/run.rs',
            'fn run() { let _ = Command::new("cargo").status(); }\n'],
        ['/x/Git/qol-monorepo/plugins/demo/src/platform/linux/mod.rs',
            'fn run() { let _ = Command::new("xdotool").status(); }\n'],
        ['/x/Git/qol-monorepo/apps/tray/src/testing/git_repo.rs',
            'fn init() { let _ = Command::new("git").status(); }\n'],
    ];
    for (const [filePath, content] of cases) {
        assert.equal(write(filePath, content).exitCode, 0, `${filePath}\n${content}`);
    }
});

test('an edit next to an existing unhidden spawn passes and a second spawn is blocked', () => {
    const at = fixtureCrate({
        'plugins/demo/src/session/git.rs':
            'fn branch() { let _ = Command::new("git").output(); }\n\nfn other() {}\n',
    });
    const filePath = at('plugins/demo/src/session/git.rs');
    const untouched = run({
        tool_name: 'Edit',
        tool_input: { file_path: filePath, old_string: 'fn other() {}', new_string: 'fn other() { }' },
    });
    assert.equal(untouched.exitCode, 0, untouched.stderr);
    const second = run({
        tool_name: 'Edit',
        tool_input: {
            file_path: filePath,
            old_string: 'fn other() {}',
            new_string: 'fn other() { let _ = Command::new("git").output(); }',
        },
    });
    assert.equal(second.exitCode, 2);
});

test('blocks a plugin host-state change when its crate never listens for the stop request', () => {
    const at = fixtureCrate({
        'plugins/demo/src/main.rs': 'fn main() {}\n',
        'plugins/demo/src/cursor/platform/windows.rs': 'fn apply() {}\n',
    });
    for (const call of [
        'SetSystemCursor(cursor, id)',
        'SetDeviceGammaRamp(dc, ramp)',
        'BluetoothSetServiceState(radio, device, guid, flags)',
        'SystemParametersInfoW(SPI_SETCURSORS, 0, null_mut(), 0)',
    ]) {
        const r = write(
            at('plugins/demo/src/cursor/platform/windows.rs'),
            `fn apply() { unsafe { ${call} }; }\n`,
        );
        assert.equal(r.exitCode, 2, call);
        assert.match(r.stderr, /stop request/, call);
    }
});

test('passes a plugin host-state change when its crate registers a stop hook', () => {
    const at = fixtureCrate({
        'plugins/demo/src/main.rs':
            'fn main() { qol_process::on_stop_request(restore).ok(); }\n',
        'plugins/demo/src/cursor/platform/windows.rs': 'fn apply() {}\n',
    });
    const r = write(
        at('plugins/demo/src/cursor/platform/windows.rs'),
        'fn apply() { unsafe { SetSystemCursor(cursor, id) }; }\n',
    );
    assert.equal(r.exitCode, 0, r.stderr);
    const read = write(
        '/x/Git/qol-monorepo/plugins/other/src/platform/windows.rs',
        'fn area() { unsafe { SystemParametersInfoW(SPI_GETWORKAREA, 0, rect, 0) }; }\n',
    );
    assert.equal(read.exitCode, 0, read.stderr);
});

test('lint mode reports only Windows violations added since the base', () => {
    const { lintFile } = require(HOOK);
    const filePath = '/x/Git/qol-monorepo/libs/demo/src/feature/platform/windows.rs';
    const content = 'fn run() { let _ = Command::new("reg").status(); }\n';
    assert.equal(lintFile(filePath, content, content).length, 0);
    assert.equal(lintFile(filePath, content, '').length, 1);
    assert.equal(lintFile(filePath, content, null).length, 1);
});

test('passes command-line Command types, shared unix adapters and test helpers', () => {
    const cases = [
        ['/x/Git/qol-monorepo/plugins/demo/src/cli.rs',
            'use qol_headless::{Command, HeadlessApp};\n\nfn server() -> Command { Command::new("server") }\n'],
        ['/x/Git/qol-monorepo/apps/tray/src/installer/main.rs',
            'use clap::{Arg, Command};\n\nfn reg() -> Command { Command::new("reg") }\n'],
        ['/x/Git/qol-monorepo/apps/tray/src/installer/platform/unix_common/mod.rs',
            'fn running() { let _ = Command::new("pgrep").status(); }\n'],
        ['/x/Git/qol-monorepo/tools/cli/src/platform/test_process.rs',
            'fn exiting() -> Command { Command::new("cmd") }\n'],
        ['/x/Git/qol-monorepo/tools/cli/src/dev_console/testkit.rs',
            'fn shell() -> Command { Command::new("powershell") }\n'],
    ];
    for (const [filePath, content] of cases) {
        assert.equal(write(filePath, content).exitCode, 0, `${filePath}\n${content}`);
    }
    const qualified = write(
        '/x/Git/qol-monorepo/plugins/demo/src/cli.rs',
        'use qol_headless::Command;\n\nfn run() { let _ = std::process::Command::new("cmd").status(); }\n',
    );
    assert.equal(qualified.exitCode, 2);
    assert.match(qualified.stderr, /bare name/);
    assert.match(qualified.stderr, /console window/);
});

test('passes a tray spawn that spawn_detached or spawn_owned starts', () => {
    for (const start of ['qol_process::spawn_detached(&mut command)', 'qol_process::spawn_owned(command)']) {
        const result = write(
            '/x/Git/qol-monorepo/apps/tray/src/settings_surface/host.rs',
            `fn open() { let mut command = std::process::Command::new(exe()); let _ = ${start}; }\n`,
        );
        assert.equal(result.exitCode, 0, start);
    }
});
