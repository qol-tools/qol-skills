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
    const root = path.join(temp, 'qol-monorepo');
    const file = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (content !== undefined) fs.writeFileSync(file, content);
    return { root, file };
}

function fixtureCratePath(relativePath, content, packageName = 'qol-library') {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-hook-'));
    const root = path.join(temp, 'qol-monorepo');
    const crateRoot = path.join(root, 'libs', packageName);
    const file = path.join(crateRoot, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
        path.join(crateRoot, 'Cargo.toml'),
        `[package]\nname = "${packageName}"\nversion = "0.1.0"\n`,
    );
    if (content !== undefined) fs.writeFileSync(file, content);
    return { root, crateRoot, file };
}

function fixtureManifestCrate(relativePath, dependencies, content) {
    const { crateRoot, file } = fixtureCratePath(relativePath, content);
    fs.appendFileSync(path.join(crateRoot, 'Cargo.toml'), `\n${dependencies}`);
    return { crateRoot, file };
}

function fixturePluginPath(relativePath, content) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-hook-'));
    const root = path.join(temp, 'qol-monorepo');
    const pluginRoot = path.join(root, 'plugins', 'plugin-fixture');
    const file = path.join(pluginRoot, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(path.join(pluginRoot, 'plugin.toml'), '[plugin]\nid = "fixture"\n');
    fs.writeFileSync(
        path.join(pluginRoot, 'Cargo.toml'),
        '[package]\nname = "plugin-fixture"\nversion = "0.1.0"\n',
    );
    if (content !== undefined) fs.writeFileSync(file, content);
    return { root, pluginRoot, file };
}

function fixturePlatform(files) {
    const { crateRoot } = fixtureCratePath('src/lib.rs', '');
    const platformDir = path.join(crateRoot, 'src', 'feature', 'platform');
    fs.mkdirSync(platformDir, { recursive: true });
    for (const [relativePath, content] of Object.entries(files)) {
        const file = path.join(platformDir, relativePath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
    return {
        modFile: path.join(platformDir, 'mod.rs'),
        platformDir,
    };
}

test('blocks new Rust implementation modules at a plugin src root', () => {
    const { file } = fixturePluginPath('src/recording.rs');
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: file,
            content: 'pub fn start() {}\n',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /directly under a plugin's `src\/` root/);
});

test('passes canonical plugin src root entrypoints and facades', () => {
    for (const basename of ['main.rs', 'lib.rs', 'cli.rs']) {
        const { file } = fixturePluginPath(`src/${basename}`);
        const r = run({
            tool_name: 'Write',
            tool_input: {
                file_path: file,
                content: 'pub fn run() {}\n',
            },
        });
        assert.equal(r.exitCode, 0, `${basename}: ${r.stderr}`);
    }
});

test('blocks edits to an existing module directly under a plugin src root', () => {
    const { file } = fixturePluginPath('src/config.rs', 'pub struct Config;\n');
    const r = run({
        tool_name: 'Edit',
        tool_input: {
            file_path: file,
            old_string: 'pub struct Config;',
            new_string: 'pub(crate) struct Config;',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /may not live directly under a plugin's `src\/` root/);
});

test('lint judges layout on every file, with or without a base', () => {
    const { pluginRoot, file } = fixturePluginPath('src/feature/capture.rs', 'pub fn start() {}\n');
    fs.mkdirSync(path.join(pluginRoot, 'src', 'feature', 'capture'));
    fs.writeFileSync(path.join(pluginRoot, 'src', 'feature', 'capture', 'worker.rs'), 'pub fn work() {}\n');
    const { lintFile } = require(HOOK);
    const content = fs.readFileSync(file, 'utf8');
    for (const baseline of [null, content, 'pub fn old() {}\n']) {
        assert.match(lintFile(file, content, baseline).join('\n'), /cannot use both/);
    }
});

test('layout violations honor the single-edit bypass marker', () => {
    const { root, file } = fixturePluginPath('src/recording.rs');
    const marker = path.join(root, '.claude', 'bypass-qol-arch-code');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '');
    const r = run({
        cwd: os.tmpdir(),
        tool_name: 'Write',
        tool_input: {
            file_path: file,
            content: 'pub fn start() {}\n',
        },
    });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(fs.existsSync(marker), false);
});

test('blocks a new child beneath a sibling file module', () => {
    const { pluginRoot, file } = fixturePluginPath('src/capture/worker.rs');
    fs.writeFileSync(path.join(pluginRoot, 'src', 'capture.rs'), 'mod worker;\n');
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: file,
            content: 'pub fn run() {}\n',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /both .*capture\.rs.*sibling directory/s);
});

test('blocks a new sibling file module when its directory exists', () => {
    const { pluginRoot, file } = fixturePluginPath('src/capture.rs');
    fs.mkdirSync(path.join(pluginRoot, 'src', 'capture'), { recursive: true });
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: file,
            content: 'mod worker;\n',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /`<module>\/mod\.rs`/);
});

test('blocks edits inside an existing file-directory module hybrid', () => {
    const { pluginRoot, file } = fixturePluginPath(
        'src/capture/worker.rs',
        'pub fn run() {}\n',
    );
    fs.writeFileSync(path.join(pluginRoot, 'src', 'capture.rs'), 'mod worker;\n');
    const r = run({
        tool_name: 'Edit',
        tool_input: {
            file_path: file,
            old_string: 'pub fn run() {}',
            new_string: 'pub fn run() { tracing::info!("run"); }',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /both .*capture\.rs.*sibling directory/s);
    assert.match(r.stderr, /holds for every file/);
});

test('leaves vendored crates to their upstream layout', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-hook-'));
    const root = path.join(temp, 'qol-monorepo');
    const crateRoot = path.join(root, 'vendor', 'gpui');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.join(crateRoot, 'src', 'app'), { recursive: true });
    fs.writeFileSync(path.join(crateRoot, 'Cargo.toml'), '[package]\nname = "gpui"\nversion = "0.1.0"\n');
    const file = path.join(crateRoot, 'src', 'app.rs');
    fs.writeFileSync(file, 'mod context;\npub fn run() {}\n');
    let r = run({
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: 'run', new_string: 'start' },
    });
    assert.equal(r.exitCode, 0, r.stderr);
    r = run({
        tool_name: 'Write',
        tool_input: { file_path: path.join(crateRoot, 'src', 'app', 'context.rs'), content: 'pub struct Context;\n' },
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('judges layout in a checkout that sits inside a folder named vendor', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-hook-'));
    const root = path.join(temp, 'vendor', 'qol-monorepo');
    const crateRoot = path.join(root, 'libs', 'qol-library');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.join(crateRoot, 'src', 'capture'), { recursive: true });
    fs.writeFileSync(path.join(crateRoot, 'Cargo.toml'), '[package]\nname = "qol-library"\nversion = "0.1.0"\n');
    const r = run({
        tool_name: 'Write',
        tool_input: { file_path: path.join(crateRoot, 'src', 'capture.rs'), content: 'mod worker;\n' },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /`<module>\/mod\.rs`/);
});

test('blocks new module hybrids in non-plugin Rust crates', () => {
    const { crateRoot, file } = fixtureCratePath('src/capture/worker.rs');
    fs.writeFileSync(path.join(crateRoot, 'src', 'capture.rs'), 'mod worker;\n');
    const r = run({
        tool_name: 'Write',
        tool_input: { file_path: file, content: 'pub fn run() {}\n' },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /both .*capture\.rs.*sibling directory/s);
});

test('blocks new catch-all source directories in non-plugin Rust crates', () => {
    const { file } = fixtureCratePath('src/utils/paths.rs');
    const r = run({
        tool_name: 'Write',
        tool_input: { file_path: file, content: 'pub fn expand() {}\n' },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /catch-all/);
});

test('blocks new implementation modules at the qol-tray source root', () => {
    const { file } = fixtureCratePath('src/service.rs', undefined, 'qol-tray');
    const r = run({
        tool_name: 'Write',
        tool_input: { file_path: file, content: 'pub fn run() {}\n' },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /qol-tray's `src\/` root/);
});

test('allows source-root facades in ordinary libraries', () => {
    const { file } = fixtureCratePath('src/service.rs');
    const r = run({
        tool_name: 'Write',
        tool_input: { file_path: file, content: 'pub fn run() {}\n' },
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('blocks mixed flat and directory OS module forms', () => {
    const flatAfterDirectory = fixtureCratePath('src/platform/macos.rs');
    fs.mkdirSync(path.join(flatAfterDirectory.crateRoot, 'src', 'platform', 'linux'), { recursive: true });
    let r = run({
        tool_name: 'Write',
        tool_input: { file_path: flatAfterDirectory.file, content: 'pub struct Platform;\n' },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /cannot mix flat OS modules/);

    const directoryAfterFlat = fixtureCratePath('src/platform/macos/mod.rs');
    fs.writeFileSync(
        path.join(directoryAfterFlat.crateRoot, 'src', 'platform', 'linux.rs'),
        'pub struct Platform;\n',
    );
    r = run({
        tool_name: 'Write',
        tool_input: { file_path: directoryAfterFlat.file, content: 'pub struct Platform;\n' },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /cannot mix flat OS modules/);
});

test('blocks new files in catch-all plugin source directories', () => {
    const { file } = fixturePluginPath('src/utils/paths.rs');
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: file,
            content: 'pub fn expand() {}\n',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /catch-all/);
});

test('blocks Rust code in host-served plugin ui', () => {
    const { file } = fixturePluginPath('ui/panel.rs');
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: file,
            content: 'pub struct Panel;\n',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /Rust UI code.*plugin-root `ui\/`/s);
});

test('blocks browser assets in native Rust ui', () => {
    const { file } = fixturePluginPath('src/ui/panel.html');
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: file,
            content: '<main>settings</main>\n',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /Browser assets do not belong in `src\/ui\/`/);
});

test('passes web assets in plugin ui and Rust code in src ui', () => {
    const cases = [
        ['ui/index.html', '<main>settings</main>\n'],
        ['src/ui/panel.rs', 'pub struct Panel;\n'],
    ];
    for (const [relativePath, content] of cases) {
        const { file } = fixturePluginPath(relativePath);
        const r = run({
            tool_name: 'Write',
            tool_input: { file_path: file, content },
        });
        assert.equal(r.exitCode, 0, `${relativePath}: ${r.stderr}`);
    }
});

test('does not impose plugin root rules on non-plugin crates', () => {
    const { file } = fixtureRepo('apps/example/src/service.rs', 'pub fn run() {}\n');
    const r = run({
        tool_name: 'Edit',
        tool_input: {
            file_path: file,
            old_string: 'pub fn run() {}',
            new_string: 'pub fn run() { tracing::info!("run"); }',
        },
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('blocks cfg(all(target_os, feature)) gating non-OS module', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/hotkeys/mod.rs',
            content: '#[cfg(all(target_os = "linux", feature = "foo"))]\nmod capture;\n',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /qol-arch-code violation/);
});

test('passes canonical multi-line cfg + mod re-export pattern', () => {
    const { modFile } = fixturePlatform({
        'linux.rs': 'pub struct Platform;\n',
        'macos.rs': 'pub struct Platform;\n',
        'windows.rs': 'pub struct Platform;\n',
    });
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: modFile,
            content:
                '#[cfg(target_os = "linux")]\npub use linux::Platform;\n#[cfg(target_os = "macos")]\npub use macos::Platform;\n#[cfg(target_os = "windows")]\npub use windows::Platform;\n',
        },
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('passes edit fragment containing only a canonical cfg attr when full file is valid', () => {
    const content =
        '#[cfg(target_os = "linux")]\npub(crate) use linux::install;\n#[cfg(target_os = "macos")]\npub(crate) use macos::install;\n#[cfg(target_os = "windows")]\npub(crate) use windows::install;\n';
    const { modFile: file } = fixturePlatform({
        'mod.rs': content,
        'linux.rs': 'pub(crate) fn install() {}\n',
        'macos.rs': 'pub(crate) fn install() {}\n',
        'windows.rs': 'pub(crate) fn install() {}\n',
    });
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
            file_path: '/x/Git/qol-monorepo/src/lib.rs',
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
            file_path: '/x/Git/qol-monorepo/src/platform/mod.rs',
            content: '#[cfg(target_os = "linux")] mod linux;\n#[cfg(target_os = "macos")] mod macos;\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('passes files outside any qol-* repo', () => {
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
                file_path: `/x/Git/qol-monorepo/src/platform/${name}`,
                content: '#[cfg(target_os = "linux")] pub fn anything() {}\n',
            },
        });
        assert.equal(r.exitCode, 0, `expected pass for ${name}`);
    }
});

test('passes OS-named files in a nested family under platform/', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/daemon/platform/unix/macos.rs',
            content: 'pub fn anything() {}\n',
        },
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('passes per-feature platform/ directory', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/hotkeys/capture/platform/linux.rs',
            content: 'pub(crate) fn install() {}\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('blocks target-selection facade that omits an unsupported OS shim', () => {
    const { modFile } = fixturePlatform({
        'linux.rs': 'pub(super) fn run() {}\n',
        'macos.rs': 'pub(super) fn run() {}\n',
    });
    const content = [
        '#[cfg(target_os = "linux")]',
        'pub(super) use linux::run;',
        '#[cfg(target_os = "macos")]',
        'pub(super) use macos::run;',
        '',
    ].join('\n');
    const r = run({
        tool_name: 'Write',
        tool_input: { file_path: modFile, content },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /missing target coverage: windows/);
});

test('passes explicit fallback shim for an unsupported OS', () => {
    const { modFile } = fixturePlatform({
        'linux.rs': 'pub(super) fn run() {}\n',
        'macos.rs': 'pub(super) fn run() {}\n',
        'unsupported.rs': 'pub(super) fn run() {}\n',
    });
    const content = [
        '#[cfg(target_os = "linux")]',
        'use linux as imp;',
        '#[cfg(target_os = "macos")]',
        'use macos as imp;',
        '#[cfg(target_os = "windows")]',
        'use unsupported as imp;',
        '',
        'pub(super) fn run() { imp::run() }',
        '',
    ].join('\n');
    const r = run({
        tool_name: 'Write',
        tool_input: { file_path: modFile, content },
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

function writeFacade(files, content) {
    const { modFile } = fixturePlatform(files);
    return run({ tool_name: 'Write', tool_input: { file_path: modFile, content } });
}

test('passes a facade that selects its adapters under any visibility or alias', () => {
    const r = writeFacade(
        {
            'linux.rs': 'pub(super) fn run() {}\n',
            'macos.rs': 'pub(super) fn run() {}\n',
            'windows.rs': 'pub(super) fn run() {}\n',
        },
        [
            '#[cfg(target_os = "linux")]',
            'pub(crate) mod linux;',
            '#[cfg(target_os = "macos")]',
            'mod macos;',
            '#[cfg(target_os = "windows")]',
            'mod windows;',
            '#[cfg(target_os = "linux")]',
            'use linux as active;',
            '#[cfg(target_os = "macos")]',
            'use macos as active;',
            '#[cfg(target_os = "windows")]',
            'use self::windows as active;',
            '',
        ].join('\n'),
    );
    assert.equal(r.exitCode, 0, r.stderr);
});

test('still blocks a facade that gates an external import by target', () => {
    const r = writeFacade(
        { 'linux.rs': '', 'macos.rs': '', 'windows.rs': '' },
        ['mod linux;', '#[cfg(target_os = "linux")]', 'use std::sync::OnceLock;', ''].join('\n'),
    );
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /canonical mod.rs/);
});

test('counts a not(target_os) fallback selection as target coverage', () => {
    const r = writeFacade(
        { 'linux.rs': 'pub(super) fn run() {}\n', 'fallback.rs': 'pub(super) fn run() {}\n' },
        [
            '#[cfg(not(target_os = "linux"))]',
            'mod fallback;',
            '#[cfg(target_os = "linux")]',
            'mod linux;',
            '#[cfg(not(target_os = "linux"))]',
            'use fallback as imp;',
            '#[cfg(target_os = "linux")]',
            'use linux as imp;',
            '',
            'pub(super) fn run() { imp::run() }',
            '',
        ].join('\n'),
    );
    assert.equal(r.exitCode, 0, r.stderr);
});

test('counts unix and windows family selections as target coverage', () => {
    const r = writeFacade(
        { 'unix.rs': 'pub(crate) fn run() {}\n', 'windows.rs': 'pub(crate) fn run() {}\n' },
        [
            '#[cfg(unix)]',
            'mod unix;',
            '#[cfg(windows)]',
            'mod windows;',
            '#[cfg(unix)]',
            'pub(crate) use unix::run;',
            '#[cfg(windows)]',
            'pub(crate) use windows::run;',
            '',
        ].join('\n'),
    );
    assert.equal(r.exitCode, 0, r.stderr);
});

test('does not count a feature-gated selection as target coverage', () => {
    const r = writeFacade(
        { 'linux.rs': 'pub(super) fn run() {}\n', 'macos.rs': 'pub(super) fn run() {}\n' },
        [
            '#[cfg(target_os = "linux")]',
            'pub(super) use linux::run;',
            '#[cfg(target_os = "macos")]',
            'pub(super) use macos::run;',
            '#[cfg(all(target_os = "windows", feature = "shim"))]',
            'pub(super) use macos::run;',
            '',
        ].join('\n'),
    );
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /missing target coverage: windows/);
});

test('checks a trait on every module a target selects', () => {
    const impl = 'pub(super) struct Platform;\nimpl Run for Platform {\n    fn run(&self) {}\n}\n';
    const r = writeFacade(
        { 'unix.rs': impl, 'windows.rs': impl, 'termios.rs': 'pub(crate) fn capture() {}\n', 'stub.rs': 'pub(crate) fn capture() {}\n' },
        [
            '#[cfg(unix)]',
            'mod termios;',
            '#[cfg(unix)]',
            'mod unix;',
            '#[cfg(windows)]',
            'mod stub;',
            '#[cfg(windows)]',
            'mod windows;',
            '#[cfg(unix)]',
            'pub(crate) use termios::capture;',
            '#[cfg(windows)]',
            'pub(crate) use stub::capture;',
            '#[cfg(unix)]',
            'use unix::Platform;',
            '#[cfg(windows)]',
            'use windows::Platform;',
            '',
            'trait Run {',
            '    fn run(&self);',
            '}',
            '',
        ].join('\n'),
    );
    assert.equal(r.exitCode, 0, r.stderr);
});

test('ignores a trait an adapter implements only for a type the facade never selects', () => {
    const r = writeFacade(
        {
            'unix.rs': 'pub(super) fn connect() {}\nimpl Connection for std::os::unix::net::UnixStream {\n    fn close(&self) {}\n}\n',
            'fallback.rs': 'pub(super) fn connect() {}\n',
        },
        [
            '#[cfg(not(unix))]',
            'mod fallback;',
            '#[cfg(unix)]',
            'mod unix;',
            '#[cfg(not(unix))]',
            'use fallback as active;',
            '#[cfg(unix)]',
            'use unix as active;',
            '',
            'pub(crate) trait Connection {',
            '    fn close(&self);',
            '}',
            '',
            'pub(crate) fn connect() { active::connect() }',
            '',
        ].join('\n'),
    );
    assert.equal(r.exitCode, 0, r.stderr);
});

test('blocks direct re-export surface drift between OS adapters', () => {
    const { modFile } = fixturePlatform({
        'linux.rs': 'pub(super) fn run() {}\npub(super) fn notify() {}\n',
        'macos.rs': 'pub(super) fn run() {}\npub(super) fn notify() {}\n',
        'windows.rs': 'pub(super) fn run() {}\npub(super) fn notify() {}\n',
    });
    const content = [
        '#[cfg(target_os = "linux")]',
        'pub(super) use linux::{notify, run};',
        '#[cfg(target_os = "macos")]',
        'pub(super) use macos::{notify, run};',
        '#[cfg(target_os = "windows")]',
        'pub(super) use windows::run;',
        '',
    ].join('\n');
    const r = run({
        tool_name: 'Write',
        tool_input: { file_path: modFile, content },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /callable surface differs/);
    assert.match(r.stderr, /windows.*run/);
});

test('blocks fallback adapter that does not implement a facade consumer', () => {
    const { modFile } = fixturePlatform({
        'linux.rs': 'pub(super) fn run() {}\n',
        'macos.rs': 'pub(super) fn run() {}\n',
        'unsupported.rs': 'pub(super) fn unavailable() {}\n',
    });
    const content = [
        '#[cfg(target_os = "linux")]',
        'use linux as imp;',
        '#[cfg(target_os = "macos")]',
        'use macos as imp;',
        '#[cfg(target_os = "windows")]',
        'use unsupported as imp;',
        '',
        'pub(super) fn run() { imp::run() }',
        '',
    ].join('\n');
    const r = run({
        tool_name: 'Write',
        tool_input: { file_path: modFile, content },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /unsupported.*missing.*run/);
});

test('blocks adapter that omits a required trait method', () => {
    const complete = [
        'pub struct Platform;',
        'impl super::WindowOps for Platform {',
        '    fn run(&self) {}',
        '    fn stop(&self) {}',
        '}',
        '',
    ].join('\n');
    const { modFile } = fixturePlatform({
        'linux.rs': complete,
        'macos.rs': complete,
        'windows.rs': [
            'pub struct Platform;',
            'impl super::WindowOps for Platform {',
            '    fn run(&self) {}',
            '}',
            '',
        ].join('\n'),
    });
    const content = [
        'pub trait WindowOps {',
        '    fn run(&self);',
        '    fn stop(&self);',
        '}',
        '#[cfg(target_os = "linux")]',
        'pub use linux::Platform;',
        '#[cfg(target_os = "macos")]',
        'pub use macos::Platform;',
        '#[cfg(target_os = "windows")]',
        'pub use windows::Platform;',
        '',
    ].join('\n');
    const r = run({
        tool_name: 'Write',
        tool_input: { file_path: modFile, content },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /windows.*WindowOps::stop/);
});

test('does not block an unchanged legacy facade violation', () => {
    const content = [
        '#[cfg(target_os = "linux")]',
        'pub(super) use linux::run;',
        '#[cfg(target_os = "macos")]',
        'pub(super) use macos::run;',
        '',
    ].join('\n');
    const { modFile } = fixturePlatform({
        'mod.rs': content,
        'linux.rs': 'pub(super) fn run() {}\n',
        'macos.rs': 'pub(super) fn run() {}\n',
    });
    const r = run({
        tool_name: 'Edit',
        tool_input: {
            file_path: modFile,
            old_string: 'pub(super) use linux::run;',
            new_string: 'pub(super) use linux::run;',
        },
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('blocks OS-named files placed outside a platform/ directory', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/hotkeys/capture/linux.rs',
            content: 'pub(crate) fn install() {}\n',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /must live inside[\s\S]*`platform\/`/);
});

test('leaves cfg(target_os) on a use statement outside platform/ to the cross-platform guard', () => {
    const file = fixtureFile('src/feature/mod.rs');
    const r = run({
        tool_name: 'Write',
        tool_input: { file_path: file, content: '#[cfg(target_os = "linux")]\nuse std::sync::OnceLock;\n' },
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('blocks cfg(target_os) gating a pub fn in business code', () => {
    const r = run({
        tool_name: 'Edit',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/hotkeys/mod.rs',
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
            file_path: '/x/Git/qol-monorepo/src/platform/mod.rs',
            content: '#[cfg(target_os = "linux")]\n#[allow(dead_code)]\nmod linux;\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('blocks cfg(any(target_os)) gating non-OS item', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/lib.rs',
            content:
                '#[cfg(any(target_os = "linux", target_os = "macos"))]\npub fn unix_thing() {}\n',
        },
    });
    assert.equal(r.exitCode, 2);
});

test('blocks a target_os cfg that also lets the item build for tests', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/lib.rs',
            content: '#[cfg(any(target_os = "macos", test))]\npub fn vendor_id() -> u32 {\n    0\n}\n',
        },
    });
    assert.equal(r.exitCode, 2);
});

test('passes a target_os cfg on a module its parent declares only for tests', () => {
    const { crateRoot } = fixtureCratePath('src/feature/mod.rs', 'pub fn live() {}\n\n#[cfg(test)]\nmod fixtures;\n');
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: path.join(crateRoot, 'src', 'feature', 'fixtures.rs'),
            content: '#[cfg(target_os = "linux")]\npub fn linux_fixture() {}\n',
        },
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('passes feature-only cfg (no target_os involved)', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/lib.rs',
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
            file_path: '/x/Git/qol-monorepo/src/lib.rs',
            content: '#[cfg(target_os = "linux")] pub fn foo() {}\n',
        },
    });
    assert.equal(r.exitCode, 2);
});

test('passes test files', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/tests/integration.rs',
            content: '#[cfg(target_os = "linux")] fn t() {}\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('passes tests.rs module files', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/handle/tests.rs',
            content: '#[cfg(target_os = "linux")] fn t() {}\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('blocks cfg macro platform branch outside facade', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/sync/service.rs',
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
            file_path: '/x/Git/qol-monorepo/src/profile/storage.rs',
            content: 'pub fn current() -> &' + '\'static str { std::env::consts::OS }\n',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /std::env::consts::OS/);
});

test('blocks OS-specific import outside facade', () => {
    const { file } = fixtureManifestCrate(
        'src/window/list.rs',
        '[target.\'cfg(target_os = "macos")\'.dependencies]\ncore-graphics = "0.24"\n',
    );
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: file,
            content: 'use core_graphics::window::CGWindowListCopyWindowInfo;\n',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /OS-specific import: line 1/);
});

test('blocks OS command dispatch outside facade', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/launcher/open.rs',
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
            file_path: '/x/Git/qol-monorepo/apps/qol-tray/src/features/profile/core/storage.rs',
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
            file_path: '/x/Git/qol-monorepo/libs/qol-migrations/src/v3_17_to_v3_18/mod.rs',
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
            file_path: '/x/Git/qol-monorepo/apps/qol-tray/src/features/profile/core/scope_store.rs',
            content: 'pub(crate) struct ProfileScopeStore { os_bucket: String }\nimpl ProfileScopeStore { pub(crate) fn os_dir(&self, profile: &Path) -> PathBuf { profile.join("os").join(&self.os_bucket) } }\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('passes platform decision inside resolver facade', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/plugins/config/resolver.rs',
            content: 'pub fn resolve(platforms: &[String], profile: &Path) -> PathBuf { if platforms.len() == 1 { return profile.join("os").join(&platforms[0]); } profile.join("core") }\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

const PLATFORM_GATED_TEST_FILE = [
    'use super::{Plugin, PluginId};',
    'use std::collections::HashMap;',
    'use std::sync::Arc;',
    '',
    'pub struct PluginManager {',
    '    plugins: HashMap<PluginId, Plugin>,',
    '    process_tracker: Arc<ProcessTracker>,',
    '    #[cfg(test)]',
    '    profile_reconciliation_count: u64,',
    '}',
    '',
    'impl PluginManager {',
    '    pub fn reconcile_profile_generation(&mut self) -> Result<bool> {',
    '        #[cfg(test)]',
    '        {',
    '            self.profile_reconciliation_count += 1;',
    '        }',
    '        if self.plugins.is_empty() {',
    '            return Ok(false);',
    '        }',
    '        Ok(true)',
    '    }',
    '}',
    '',
    '#[cfg(test)]',
    'mod tests {',
    '    use super::*;',
    '',
    '    #[cfg(unix)]',
    '    #[test]',
    '    fn running_gpui_daemon_ids_skips_headless_and_stopped_plugins() {',
    '        let manager = PluginManager::new();',
    '        assert!(manager.plugins.is_empty());',
    '    }',
    '}',
    '',
].join('\n');

const TEST_ONLY_PLATFORM_DATA_FILE = [
    'use super::{autostart, loading, PluginManager};',
    'use anyhow::Result;',
    '',
    'pub(super) fn reload_plugin(manager: &mut PluginManager, plugin_id: &str) -> Result<u64> {',
    '    #[cfg(debug_assertions)]',
    '    let old_pid = manager.plugins.get(plugin_id).and_then(Plugin::daemon_pid);',
    '    #[cfg(not(debug_assertions))]',
    '    let old_pid = None::<u32>;',
    '    if !crate::dev_generation::is_shadow() && !crate::dev_generation::is_rolling_restart() {',
    '        daemon_tracker::clean_stale_sockets(plugin_id);',
    '    }',
    '    loading::rebuild_identity_index(manager);',
    '    Ok(old_pid.unwrap_or_default() as u64)',
    '}',
    '',
    '#[cfg(all(test, unix))]',
    'mod tests {',
    '    use super::*;',
    '',
    '    #[test]',
    '    fn reload_rewrites_the_plugins_lock() {',
    '        save_plugins_lock(&PluginsLock {',
    '            version: CURRENT_PROFILE_VERSION,',
    '            plugins: vec![PluginLockEntry {',
    '                id: TARGET_ID.to_string(),',
    '                version: "1.0.0".to_string(),',
    '                platforms: None,',
    '            }],',
    '        })',
    '        .unwrap();',
    '    }',
    '}',
    '',
].join('\n');

test('passes an unrelated edit to a file whose only platform cfg gates a test', () => {
    const file = fixtureFile(
        'apps/qol-tray/src/plugins/manager/mod.rs',
        PLATFORM_GATED_TEST_FILE,
    );
    const r = run({
        tool_name: 'Edit',
        tool_input: {
            file_path: file,
            old_string: '    process_tracker: Arc<ProcessTracker>,',
            new_string: '    process_tracker: Arc<ProcessTracker>,\n    last_reload_reason: Option<String>,',
        },
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('passes an unrelated edit to a file whose only platform token is test data', () => {
    const file = fixtureFile(
        'apps/qol-tray/src/plugins/manager/runtime.rs',
        TEST_ONLY_PLATFORM_DATA_FILE,
    );
    const r = run({
        tool_name: 'Edit',
        tool_input: {
            file_path: file,
            old_string: '    loading::rebuild_identity_index(manager);',
            new_string: '    loading::rebuild_identity_index(manager);\n    sync_ignore_pids(manager);',
        },
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('passes build-profile cfg gates that name no platform', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/apps/qol-tray/src/plugins/manager/runtime.rs',
            content: [
                'pub(super) fn reload(manager: &mut PluginManager) -> Result<()> {',
                '    #[cfg(debug_assertions)]',
                '    let old_pid = manager.daemon_pid();',
                '    #[cfg(not(debug_assertions))]',
                '    let old_pid = None::<u32>;',
                '    if old_pid.is_some() {',
                '        manager.stop();',
                '    }',
                '    Ok(())',
                '}',
                '',
            ].join('\n'),
        },
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('passes a platforms field that is carried but never branched on', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/libs/qol-plugin-api/src/manifest/schema.rs',
            content: [
                'pub struct PluginManifest {',
                '    pub id: String,',
                '    pub platforms: Option<Vec<String>>,',
                '}',
                '',
                'impl PluginManifest {',
                '    pub fn supported_here(&self) -> bool {',
                '        super::supports_current_platform(&self.platforms)',
                '    }',
                '',
                '    pub fn display_id(&self) -> &str {',
                '        if self.id.is_empty() {',
                '            return "unknown";',
                '        }',
                '        &self.id',
                '    }',
                '}',
                '',
            ].join('\n'),
        },
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('passes platform decisions described only in comments', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/apps/qol-tray/src/plugins/state.rs',
            content: [
                '/// The facade resolves this with cfg!(target_os = "linux"); callers must not.',
                '// platforms.len() == 1 means single-OS, and the resolver owns that decision.',
                'pub fn describe(ready: bool) -> &' + '\'static str {',
                '    if ready {',
                '        return "ready";',
                '    }',
                '    "idle"',
                '}',
                '',
            ].join('\n'),
        },
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('blocks a platform cfg added to a production item beside a platform-gated test', () => {
    const file = fixtureFile(
        'apps/qol-tray/src/plugins/manager/mod.rs',
        PLATFORM_GATED_TEST_FILE,
    );
    const r = run({
        tool_name: 'Edit',
        tool_input: {
            file_path: file,
            old_string: '    pub fn reconcile_profile_generation(&mut self) -> Result<bool> {',
            new_string: '    #[cfg(unix)]\n    pub fn reconcile_profile_generation(&mut self) -> Result<bool> {',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /#\[cfg\(\.\.\)\] naming an OS family: line \d+/);
});

test('blocks platform branching added beside test-only platform data', () => {
    const file = fixtureFile(
        'apps/qol-tray/src/plugins/manager/runtime.rs',
        TEST_ONLY_PLATFORM_DATA_FILE,
    );
    const r = run({
        tool_name: 'Edit',
        tool_input: {
            file_path: file,
            old_string: '    loading::rebuild_identity_index(manager);',
            new_string: '    if manifest.platforms.len() == 1 { return Ok(0); }',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /platform token \+ branching/);
});

test('passes cfg(target_os) attached to a platform-gated test', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/apps/qol-tray/src/features/task_runner/execution/mod.rs',
            content: [
                'pub fn execute(command: &str) -> Result<()> {',
                '    runner::spawn(command)',
                '}',
                '',
                '#[cfg(test)]',
                'mod tests {',
                '    use super::*;',
                '',
                '    #[cfg(target_os = "linux")]',
                '    #[test]',
                '    fn executes_on_linux() {',
                '        assert!(execute("true").is_ok());',
                '    }',
                '}',
                '',
            ].join('\n'),
        },
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('blocks cfg(target_os) on a production item beside a platform-gated test', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/apps/qol-tray/src/features/task_runner/execution/mod.rs',
            content: [
                '#[cfg(target_os = "linux")]',
                'pub fn execute(command: &str) -> Result<()> {',
                '    runner::spawn(command)',
                '}',
                '',
                '#[cfg(test)]',
                'mod tests {',
                '    use super::*;',
                '',
                '    #[cfg(target_os = "linux")]',
                '    #[test]',
                '    fn executes_on_linux() {',
                '        assert!(execute("true").is_ok());',
                '    }',
                '}',
                '',
            ].join('\n'),
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /line 1: #\[cfg\(target_os = "linux"\)\]/);
});

test('passes platform decision inside named facade type', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/src/profile/layout.rs',
            content: 'pub(crate) struct ProfileLayoutFacade;\nimpl ProfileLayoutFacade { pub(crate) fn os_path(profile: &Path, current_os: &str) -> PathBuf { profile.join("os").join(current_os) } }\n',
        },
    });
    assert.equal(r.exitCode, 0);
});

function write(file, content) {
    return run({ tool_name: 'Write', tool_input: { file_path: file, content } });
}

function edit(file, oldString, newString) {
    return run({ tool_name: 'Edit', tool_input: { file_path: file, old_string: oldString, new_string: newString } });
}

test('blocks target_os nested beside another flag', () => {
    const r = write(
        '/x/Git/qol-monorepo/src/sync/probe.rs',
        '#[cfg(all(debug_assertions, target_os = "linux"))]\nfn probe() {}\n',
    );
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /line 1: #\[cfg\(all\(debug_assertions, target_os = "linux"\)\)\]/);
});

test('blocks a cfg attribute that spans lines and names its item', () => {
    const r = write(
        '/x/Git/qol-monorepo/src/sync/probe.rs',
        'pub fn a() {}\n#[cfg(any(\n    feature = "x",\n    target_os = "macos",\n))]\n\nfn b() {}\n',
    );
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /line 2: #\[cfg\(any\( feature = "x", target_os = "macos", \)\)\]/);
    assert.match(r.stderr, /line 7: fn b\(\) \{\}/);
});

test('blocks cfg_attr gated on target_os', () => {
    const r = write(
        '/x/Git/qol-monorepo/src/sync/probe.rs',
        '#[cfg_attr(not(target_os = "linux"), allow(dead_code))]\nfn helper() {}\n',
    );
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /line 1: #\[cfg_attr\(not\(target_os = "linux"\), allow\(dead_code\)\)\]/);
});

test('blocks an inner cfg on the OS outside platform', () => {
    const r = write('/x/Git/qol-monorepo/src/sync/registry.rs', '#![cfg(target_os = "windows")]\npub fn x() {}\n');
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /line 1: \(the whole module\)/);
});

test('passes cfg text inside literals and comments', () => {
    const r = write(
        '/x/Git/qol-monorepo/src/sync/help.rs',
        'pub const HELP: &str = "#[cfg(target_os = \\"linux\\")] or cfg!(windows)";\n// #[cfg(unix)]\npub fn x() {}\n',
    );
    assert.equal(r.exitCode, 0, r.stderr);
});

test('judges only the cfg attributes an edit adds', () => {
    const file = fixtureFile(
        'src/sync/probe.rs',
        '#[cfg(target_os = "linux")]\nfn probe() {}\npub fn other() {}\n',
    );
    const untouched = edit(file, 'pub fn other() {}', 'pub fn other() -> u8 {\n    1\n}');
    assert.equal(untouched.exitCode, 0, untouched.stderr);
    const added = edit(file, 'pub fn other() {}', '#[cfg(target_os = "macos")]\nfn probe_mac() {}\npub fn other() {}');
    assert.equal(added.exitCode, 2);
    assert.match(added.stderr, /line 3: #\[cfg\(target_os = "macos"\)\]/);
    assert.doesNotMatch(added.stderr, /line 1: #\[cfg\(target_os = "linux"\)\]/);
});

test('blocks cfg!(windows) outside a boundary', () => {
    const r = write(
        '/x/Git/qol-monorepo/src/sync/paths.rs',
        "pub fn separator() -> char {\n    if cfg!(windows) { '\\\\' } else { '/' }\n}\n",
    );
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /cfg!\(\.\.\) naming the OS: line 2$/m);
});

test('blocks an OS family cfg nested beside another flag', () => {
    const r = write(
        '/x/Git/qol-monorepo/src/sync/probe.rs',
        'pub fn a() {}\n#[cfg(all(debug_assertions, unix))]\nfn b() {}\n',
    );
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /#\[cfg\(\.\.\)\] naming an OS family: line 2$/m);
});

test('judges only the platform signals an edit adds, line by line', () => {
    const file = fixtureFile(
        'src/sync/paths.rs',
        "pub fn separator() -> char {\n    if cfg!(windows) { '\\\\' } else { '/' }\n}\npub fn other() {}\n",
    );
    const untouched = edit(file, 'pub fn other() {}', 'pub fn other() -> u8 {\n    1\n}');
    assert.equal(untouched.exitCode, 0, untouched.stderr);
    const added = edit(
        file,
        'pub fn other() {}',
        'pub fn suffix() -> &' + '\'static str {\n    if cfg!(windows) { ".exe" } else { "" }\n}',
    );
    assert.equal(added.exitCode, 2);
    assert.match(added.stderr, /cfg!\(\.\.\) naming the OS: line 5$/m);
});

test('blocks a crate the manifest declares only for unix', () => {
    const { file } = fixtureManifestCrate('src/probe.rs', '[target.\'cfg(unix)\'.dependencies]\nlibc = "0.2"\n');
    const r = write(file, 'pub fn root() -> bool {\n    unsafe { libc::geteuid() == 0 }\n}\n');
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /OS-specific import: line 2$/m);
});

test('blocks a crate declared under a target triple', () => {
    const { file } = fixtureManifestCrate(
        'src/registry.rs',
        '[target.x86_64-pc-windows-msvc.dependencies]\nwin-reg = "0.52"\n',
    );
    const r = write(file, 'use win_reg::RegKey;\npub fn open() -> Option<RegKey> {\n    None\n}\n');
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /OS-specific import: line 1$/m);
});

test('passes a crate declared for every OS', () => {
    for (const dependencies of [
        '[dependencies]\nlibc = "0.2"\n[target.\'cfg(unix)\'.dependencies]\nlibc = { version = "0.2", features = ["extra_traits"] }\n',
        '[target.\'cfg(unix)\'.dependencies]\nlibc = "0.2"\n[target.\'cfg(windows)\'.dependencies]\nlibc = "0.2"\n',
        '[target.\'cfg(target_arch = "x86_64")\'.dependencies]\nlibc = "0.2"\n',
    ]) {
        const { file } = fixtureManifestCrate('src/probe.rs', dependencies);
        const r = write(file, 'pub fn page() -> i64 {\n    unsafe { libc::sysconf(30) }\n}\n');
        assert.equal(r.exitCode, 0, `${dependencies}\n${r.stderr}`);
    }
});

test('reads the build script against build-dependencies', () => {
    const dependencies = '[target.\'cfg(windows)\'.build-dependencies]\nwinres = "0.1"\n';
    const build = fixtureManifestCrate('build.rs', dependencies);
    const r = write(build.file, 'fn main() {\n    winres::WindowsResource::new();\n}\n');
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /OS-specific import: line 2$/m);
    const library = fixtureManifestCrate('src/version.rs', dependencies);
    assert.equal(write(library.file, 'pub fn name() -> u8 {\n    winres::VERSION\n}\n').exitCode, 0);
});

test('passes a local path that shares an OS crate name', () => {
    const { file } = fixtureManifestCrate('src/probe.rs', '[target.\'cfg(unix)\'.dependencies]\nlibc = "0.2"\n');
    const r = write(file, 'pub fn root() -> bool {\n    crate::libc::is_root() || self::libc::ok()\n}\n');
    assert.equal(r.exitCode, 0, r.stderr);
});

test('blocks std::os paths except std::os::raw', () => {
    const r = write(
        '/x/Git/qol-monorepo/src/sync/perms.rs',
        'use std::{\n    fs,\n    os::unix::fs::PermissionsExt,\n};\nuse std::os::raw::c_int;\npub fn f(_: c_int) {}\n',
    );
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /OS-specific import: line 3$/m);
    const raw = write('/x/Git/qol-monorepo/src/sync/ffi.rs', 'use std::os::raw::c_char;\npub fn f(_: *const c_char) {}\n');
    assert.equal(raw.exitCode, 0, raw.stderr);
});

test('blocks runtime OS constants imported by name', () => {
    const r = write(
        '/x/Git/qol-monorepo/src/sync/host.rs',
        'use std::env::consts::{ARCH, OS};\npub fn host() -> (&' + '\'static str, &' + '\'static str) {\n    (OS, ARCH)\n}\n',
    );
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /std::env::consts::OS or FAMILY: line 1$/m);
    const arch = write(
        '/x/Git/qol-monorepo/src/sync/arch.rs',
        'use std::env::consts::ARCH;\npub fn arch() -> &' + '\'static str {\n    ARCH\n}\n',
    );
    assert.equal(arch.exitCode, 0, arch.stderr);
});

test('passes cfgs that hold on every OS', () => {
    const r = write(
        '/x/Git/qol-monorepo/src/sync/probe.rs',
        [
            '#[cfg(any(target_os = "linux", target_os = "macos", target_os = "windows"))]',
            'fn probe() {}',
            'pub fn portable() -> bool {',
            '    cfg!(any(unix, windows))',
            '}',
            '',
        ].join('\n'),
    );
    assert.equal(r.exitCode, 0, r.stderr);
});

test('passes OS cfgs on items that only build under cfg(test)', () => {
    const r = write(
        '/x/Git/qol-monorepo/src/sync/fixture.rs',
        [
            '#[cfg(all(test, target_os = "linux"))]',
            'pub(crate) fn register_fixture(name: &str) -> usize {',
            '    name.len()',
            '}',
            '#[cfg(all(test, any(target_os = "linux", target_os = "windows")))]',
            'mod tests {}',
            '',
        ].join('\n'),
    );
    assert.equal(r.exitCode, 0, r.stderr);
});
