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

function fixture(relativePath, content, { plugin = true } = {}) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-hook-'));
    const root = path.join(temp, 'qol-monorepo');
    const crateRoot = path.join(root, plugin ? 'plugins/plugin-fixture' : 'libs/qol-library');
    const file = path.join(crateRoot, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (plugin) fs.writeFileSync(path.join(crateRoot, 'plugin.toml'), '[plugin]\nid = "fixture"\n');
    fs.writeFileSync(
        path.join(crateRoot, 'Cargo.toml'),
        `[package]\nname = "${plugin ? 'plugin-fixture' : 'qol-library'}"\nversion = "0.1.0"\n`,
    );
    if (content !== undefined) fs.writeFileSync(file, content);
    return { root, file };
}

function write(file, content) {
    return run({ tool_name: 'Write', tool_input: { file_path: file, content } });
}

const CONTRACT_LOAD = [
    'const CONFIG_CONTRACT: &str = qol_config::plugin_config_contract!();',
    'pub fn load() -> Config {',
    '    qol_config::load_plugin_config_from_env_with_contract(PLUGIN_ID, CONFIG_CONTRACT)',
    '}',
    '',
].join('\n');

test('passes a contract-backed config load', () => {
    const { file } = fixture('src/config/mod.rs');
    const r = write(file, CONTRACT_LOAD);
    assert.equal(r.exitCode, 0, r.stderr);
});

test('passes the with_contract loader by id list', () => {
    const { file } = fixture('src/config/mod.rs');
    const r = write(file, 'pub fn load() -> Config {\n    qol_config::load_plugin_config_with_contract(&[ID], CONTRACT)\n}\n');
    assert.equal(r.exitCode, 0, r.stderr);
});

for (const [label, line] of [
    ['contract-less config loader', 'qol_config::load_plugin_config_from_env(PLUGIN_ID)'],
    ['contract-less config loader', 'qol_config::load_plugin_config::<Config>(&[ID])'],
    ['contract-less config loader', 'qol_config::load_plugin_config_or(&[ID], Config::default)'],
    ['raw config file path', 'qol_config::plugin_config_paths(&[ID])'],
    ['raw config file path', 'qol_config::plugin_config_paths_from_env(PLUGIN_ID)'],
    ['host config tree', 'qol_config::config_dir().map(|dir| dir.join("plugins"))'],
]) {
    test(`blocks ${line} on Write`, () => {
        const { file } = fixture('src/config/mod.rs');
        const r = write(file, `pub fn load() {\n    let _ = ${line};\n}\n`);
        assert.equal(r.exitCode, 2);
        assert.match(r.stderr, new RegExp(label.replace(/[()]/g, '\\$&')));
        assert.match(r.stderr, /Enforcement: settings guard/);
    });
}

test('blocks a hand-rolled loader added by Edit', () => {
    const { file } = fixture('src/config/mod.rs', CONTRACT_LOAD);
    const r = run({
        tool_name: 'Edit',
        tool_input: {
            file_path: file,
            old_string: 'pub fn load() -> Config {',
            new_string: 'pub fn raw() -> Vec<PathBuf> {\n    qol_config::plugin_config_paths(&[ID])\n}\n\npub fn load() -> Config {',
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /raw config file path/);
});

test('passes an unrelated edit to a file with existing debt', () => {
    const debt = 'pub fn paths() -> Vec<PathBuf> {\n    qol_config::plugin_config_paths(&[ID])\n}\n';
    const { file } = fixture('src/doctor/mod.rs', debt);
    const r = run({
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: 'pub fn paths()', new_string: 'pub(crate) fn paths()' },
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('ignores signals in comments and test modules', () => {
    const { file } = fixture('src/config/mod.rs');
    const content = [
        '// never call qol_config::load_plugin_config(&[ID]) here',
        CONTRACT_LOAD,
        '#[cfg(test)]',
        'mod tests {',
        '    #[test]',
        '    fn reads_file() {',
        '        let _ = qol_config::plugin_config_paths(&[ID]);',
        '    }',
        '}',
        '',
    ].join('\n');
    const r = write(file, content);
    assert.equal(r.exitCode, 0, r.stderr);
});

test('ignores plugin tests/ paths', () => {
    const { file } = fixture('tests/config_props.rs');
    const r = write(file, 'fn read() {\n    qol_config::plugin_config_paths(&[ID]);\n}\n');
    assert.equal(r.exitCode, 0, r.stderr);
});

test('ignores crates that are not plugins', () => {
    const { file } = fixture('src/loader.rs', undefined, { plugin: false });
    const r = write(file, 'pub fn load() {\n    let _ = qol_config::load_plugin_config(&[ID]);\n}\n');
    assert.equal(r.exitCode, 0, r.stderr);
});

test('bypass marker passes one edit and then locks again', () => {
    const { root, file } = fixture('src/config/mod.rs');
    const marker = path.join(root, '.claude', 'bypass-qol-arch-code');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '');
    const content = 'pub fn load() {\n    let _ = qol_config::load_plugin_config(&[ID]);\n}\n';
    const payload = { tool_name: 'Write', tool_input: { file_path: file, content }, cwd: root };
    assert.equal(run(payload).exitCode, 0);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(run(payload).exitCode, 2);
});

test('earlier checks still fire in plugin config modules', () => {
    const { file } = fixture('src/config/mod.rs');
    const r = write(file, 'compile_error!("unsupported");\n');
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /compile_error!/);
});
