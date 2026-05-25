'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'check-qol-arch-code.cjs');

function run(payload) {
    const result = spawnSync('node', [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
    });
    return { exitCode: result.status, stderr: result.stderr };
}

function fixtureFile(relativePath, content) {
    return fixtureRepo(relativePath, content).file;
}

function fixtureRepo(relativePath, content) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-hook-'));
    const root = path.join(temp, 'qol-tools');
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return { root, file };
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
    assert.match(r.stderr, /qol-arch-code violation/);
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

test('passes edit fragment containing only a canonical cfg attr when full file is valid', () => {
    const file = fixtureFile(
        'foo/src/hotkeys/capture/platform/mod.rs',
        '#[cfg(target_os = "linux")]\nmod linux;\n#[cfg(target_os = "linux")]\npub(crate) use linux::install;\n',
    );
    const r = run({
        tool_name: 'Edit',
        tool_input: {
            file_path: file,
            old_string: '#[cfg(target_os = "linux")]',
            new_string: '#[cfg(target_os = "linux")]',
        },
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('passes multiedit fragments when reconstructed platform mod file is valid', () => {
    const file = fixtureFile(
        'foo/src/hotkeys/capture/platform/mod.rs',
        '#[cfg(target_os = "linux")]\nmod linux;\n#[cfg(target_os = "macos")]\nmod macos;\n',
    );
    const r = run({
        tool_name: 'MultiEdit',
        tool_input: {
            file_path: file,
            edits: [
                {
                    old_string: '#[cfg(target_os = "linux")]',
                    new_string: '#[cfg(target_os = "linux")]',
                },
                {
                    old_string: '#[cfg(target_os = "macos")]',
                    new_string: '#[cfg(target_os = "macos")]',
                },
            ],
        },
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('blocks edit when reconstructed file gates business code by target_os', () => {
    const file = fixtureFile('foo/src/hotkeys/mod.rs', 'pub fn install() {}\n');
    const r = run({
        tool_name: 'Edit',
        tool_input: {
            file_path: file,
            old_string: 'pub fn install() {}',
            new_string: '#[cfg(target_os = "linux")]\npub fn install() {}',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /qol-arch-code violation/);
});

test('consumes bypass marker from edited repo when cwd differs', () => {
    const { root, file } = fixtureRepo('foo/src/hotkeys/mod.rs', 'pub fn install() {}\n');
    const marker = path.join(root, '.claude', 'bypass-qol-arch-code');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '');
    const r = run({
        cwd: os.tmpdir(),
        tool_name: 'Edit',
        tool_input: {
            file_path: file,
            old_string: 'pub fn install() {}',
            new_string: '#[cfg(target_os = "linux")]\npub fn install() {}',
        },
    });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(fs.existsSync(marker), false);
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

test('passes OS-named files when nested in a platform/ directory', () => {
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

test('passes per-feature platform/ directory', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/src/hotkeys/capture/platform/linux.rs',
            content: 'pub(crate) fn install() {}\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('blocks OS-named files placed outside a platform/ directory', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/src/hotkeys/capture/linux.rs',
            content: 'pub(crate) fn install() {}\n',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /must live inside[\s\S]*`platform\/`/);
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

test('blocks architecture violations when subagent is the caller', () => {
    const r = run({
        tool_name: 'Write',
        agent_type: 'qol-host:qol-tray-backend',
        tool_input: {
            file_path: '/x/qol-tools/foo/src/lib.rs',
            content: '#[cfg(target_os = "linux")] pub fn foo() {}\n',
        },
    });
    assert.equal(r.exitCode, 2);
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

test('blocks cfg macro platform branch outside facade', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/src/sync/service.rs',
            content: 'pub fn bucket() -> &' + '\'static str { if cfg!(target_os = "macos") { return "macos"; } "linux" }\n',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /platform-specific decision logic/);
});

test('blocks runtime OS constant outside facade', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/src/profile/storage.rs',
            content: 'pub fn current() -> &' + '\'static str { std::env::consts::OS }\n',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /std::env::consts::OS/);
});

test('blocks OS-specific import outside facade', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/src/window/list.rs',
            content: 'use core_graphics::window::CGWindowListCopyWindowInfo;\n',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /OS-specific import/);
});

test('blocks OS command dispatch outside facade', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/src/launcher/open.rs',
            content: 'pub fn open_file(path: &Path) { let _ = Command::new("open").arg(path).status(); }\n',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /OS command dispatch/);
});

test('blocks profile scoped path routing outside facade', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/qol-tray/src/features/profile/core/storage.rs',
            content: 'pub fn os_path(profile: &Path, current_os: &str) -> PathBuf { profile.join("os").join(current_os).join("plugin-configs") }\n',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /platform token \+ storage\/path routing/);
});

test('blocks manifest platform routing outside facade', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/qol-migrations/src/v3_17_to_v3_18/mod.rs',
            content: 'if entry.platforms.len() == 1 { target = profile.join("os").join(&entry.platforms[0]); }\n',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /platform token \+ branching/);
});

test('passes platform decision inside ProfileScopeStore facade', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/qol-tray/src/features/profile/core/scope_store.rs',
            content: 'pub(crate) struct ProfileScopeStore { os_bucket: String }\nimpl ProfileScopeStore { pub(crate) fn os_dir(&self, profile: &Path) -> PathBuf { profile.join("os").join(&self.os_bucket) } }\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('passes platform decision inside resolver facade', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/src/plugins/config/resolver.rs',
            content: 'pub fn resolve(platforms: &[String], profile: &Path) -> PathBuf { if platforms.len() == 1 { return profile.join("os").join(&platforms[0]); } profile.join("core") }\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('passes platform decision inside named facade type', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/src/profile/layout.rs',
            content: 'pub(crate) struct ProfileLayoutFacade;\nimpl ProfileLayoutFacade { pub(crate) fn os_path(profile: &Path, current_os: &str) -> PathBuf { profile.join("os").join(current_os) } }\n',
        },
    });
    assert.equal(r.exitCode, 0);
});
