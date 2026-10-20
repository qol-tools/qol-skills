'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'check-qol-arch-cross-platform.cjs');
const crossPlatform = require('../bin/check-qol-arch-cross-platform.cjs');
const { silentStub, rustFunctions } = require('../bin/one-os-stubs.cjs');
const { inQolRepo } = require('../bin/qol-repo.cjs');

const LIVE_LINUX = `pub fn set_input_region_by_title(title: &str, x: i16) -> bool {
    let region = compute(title, x);
    apply(region)
}
`;

function fixture(adapters) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-one-os-'));
    const platformDir = path.join(root, 'qol-monorepo', 'libs', 'fixture', 'src', 'popup', 'platform');
    fs.mkdirSync(platformDir, { recursive: true });
    fs.writeFileSync(path.join(platformDir, 'mod.rs'), '#[cfg(target_os = "macos")]\nmod macos;\n');
    for (const [relativePath, content] of Object.entries(adapters)) {
        const file = path.join(platformDir, relativePath);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
    return platformDir;
}

function write(file, content) {
    const result = spawnSync('node', [HOOK], {
        input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file, content } }),
        encoding: 'utf8',
    });
    const line = result.stdout.trim();
    return { exitCode: result.status, note: line ? JSON.parse(line).hookSpecificOutput.additionalContext : null };
}

test('notes a new macOS stub for a function Linux implements', () => {
    const dir = fixture({ 'linux.rs': LIVE_LINUX });
    const r = write(path.join(dir, 'macos.rs'), 'pub fn set_input_region_by_title(_title: &str, _x: i16) -> bool {\n    false\n}\n');
    assert.equal(r.exitCode, 0);
    assert.match(r.note, /set_input_region_by_title returns `false` on macOS/);
    assert.match(r.note, /macos\.rs:1/);
    assert.match(r.note, /linux implements it/);
    assert.match(r.note, /rule 9/);
});

test('notes the macOS stub when Linux gains the implementation second', () => {
    const dir = fixture({ 'macos.rs': 'pub fn set_input_region_by_title(_title: &str, _x: i16) -> bool {\n    false\n}\n' });
    const r = write(path.join(dir, 'linux.rs'), LIVE_LINUX);
    assert.equal(r.exitCode, 0);
    assert.match(r.note, /set_input_region_by_title returns `false` on macOS \([^)]*macos\.rs:1\) while linux implements it/);
});

test('passes stubs no live macOS or Linux sibling contradicts', () => {
    const cases = [
        ['Err stub', { 'linux.rs': LIVE_LINUX }, 'pub fn set_input_region_by_title(_t: &str, _x: i16) -> Result<()> {\n    Err(anyhow!("unsupported"))\n}\n'],
        ['unit stub', { 'linux.rs': 'pub fn present(title: &str) {\n    raise(title);\n}\n' }, 'pub fn present(_title: &str) {}\n'],
        ['explicit Unsupported', { 'linux.rs': 'pub fn observe() -> Observation {\n    read_sysfs()\n}\n' }, 'pub fn observe() -> Observation {\n    Observation::Unsupported\n}\n'],
        ['per-OS constant', { 'linux.rs': 'pub fn name() -> &\'static str {\n    detect_backend()\n}\n' }, 'pub fn name() -> &\'static str {\n    "macos"\n}\n'],
        ['constructor', { 'linux.rs': 'impl Platform {\n    pub fn new() -> Self {\n        Self { conn: connect() }\n    }\n}\n' }, 'impl Platform {\n    pub fn new() -> Self {\n        Self::default()\n    }\n}\n'],
        ['Windows-only concept', { 'windows.rs': 'pub fn program_roots() -> Vec<PathBuf> {\n    known_folders()\n}\n' }, 'pub fn program_roots() -> Vec<PathBuf> {\n    Vec::new()\n}\n'],
        ['stub on both', { 'linux.rs': 'pub fn grab() -> Option<Grab> {\n    None\n}\n' }, 'pub fn grab() -> Option<Grab> {\n    None\n}\n'],
        ['test module', { 'linux.rs': LIVE_LINUX }, '#[cfg(test)]\nmod tests {\n    fn set_input_region_by_title() -> bool {\n        false\n    }\n}\n'],
    ];
    for (const [name, adapters, macos] of cases) {
        const dir = fixture(adapters);
        const r = write(path.join(dir, 'macos.rs'), macos);
        assert.equal(r.exitCode, 0, name);
        assert.equal(r.note, null, name);
    }
});

test('passes an edit that leaves an existing stub as it was', () => {
    const stub = 'pub fn set_input_region_by_title(_title: &str, _x: i16) -> bool {\n    false\n}\n';
    const dir = fixture({ 'linux.rs': LIVE_LINUX, 'macos.rs': stub });
    const r = write(path.join(dir, 'macos.rs'), `${stub}\npub fn scale() -> f64 {\n    backing_scale()\n}\n`);
    assert.equal(r.note, null);
});

test('passes a stub moved from another macOS adapter file of the crate', () => {
    const stub = 'pub fn set_input_region_by_title(_title: &str, _x: i16) -> bool {\n    false\n}\n';
    const dir = fixture({ 'linux.rs': LIVE_LINUX, 'macos/mod.rs': 'mod region;\n', 'macos/region.rs': stub });
    const r = write(path.join(dir, 'macos', 'window.rs'), stub);
    assert.equal(r.note, null);
});

test('passes stubs written into fallback and Windows adapters', () => {
    const stub = 'pub fn set_input_region_by_title(_title: &str, _x: i16) -> bool {\n    false\n}\n';
    const dir = fixture({ 'linux.rs': LIVE_LINUX });
    assert.equal(write(path.join(dir, 'fallback.rs'), stub).note, null);
    assert.equal(write(path.join(dir, 'windows.rs'), stub).note, null);
});

test('qac lint never reports the note', () => {
    const dir = fixture({ 'linux.rs': LIVE_LINUX });
    const findings = crossPlatform.lintFile(path.join(dir, 'macos.rs'), 'pub fn set_input_region_by_title(_t: &str, _x: i16) -> bool {\n    false\n}\n');
    assert.deepEqual(findings, []);
});

test('silent stubs: neutral values and claimed success, after silenced parameters', () => {
    const body = src => silentStub(rustFunctions(src)[0]);
    assert.equal(body('fn a(x: u8, y: u8) -> bool {\n    let _ = (x, y);\n    false\n}'), 'false');
    assert.equal(body('fn a() -> Result<()> {\n    Ok(())\n}'), 'Ok(())');
    assert.equal(body('fn a() -> Option<u8> {\n    None\n}'), 'None');
    assert.equal(body('fn a() -> Vec<u8> {\n    Vec::new()\n}'), 'Vec::new()');
    assert.equal(body('fn a() -> bool {\n    true\n}'), 'true');
    assert.equal(body('fn a() -> Option<u8> {\n    let _ = Command::new("open").spawn();\n    None\n}'), null);
    assert.equal(body('fn a() -> f64 {\n    1.5\n}'), null);
    assert.equal(body('fn a() -> Backend {\n    Backend::Quartz\n}'), null);
});

test('a qol checkout counts whatever its folder is called', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-identity-'));
    const named = path.join(root, 'qol', 'libs', 'x.rs');
    assert.equal(inQolRepo(named), true);

    const clone = path.join(root, 'main-clone');
    fs.mkdirSync(path.join(clone, '.git', 'worktrees', 'feature'), { recursive: true });
    fs.writeFileSync(path.join(clone, '.git', 'config'), '[remote "origin"]\n\turl = https://github.com/qol-tools/qol.git\n');
    fs.writeFileSync(path.join(clone, '.git', 'worktrees', 'feature', 'commondir'), '../..\n');
    const worktree = path.join(root, 'worktrees', 'launcher-fix');
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(worktree, '.git'), `gitdir: ${path.join(clone, '.git', 'worktrees', 'feature')}\n`);
    assert.equal(inQolRepo(path.join(worktree, 'libs', 'gpui', 'src', 'new.rs')), true);
    assert.equal(inQolRepo(path.join(clone, 'apps', 'tray', 'src', 'main.rs')), true);

    const other = path.join(root, 'elsewhere');
    fs.mkdirSync(path.join(other, '.git'), { recursive: true });
    fs.writeFileSync(path.join(other, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:someone/tool.git\n');
    assert.equal(inQolRepo(path.join(other, 'src', 'main.rs')), false);
    assert.equal(inQolRepo('/x/other/src/foo.rs'), false);
});
