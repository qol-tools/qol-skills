'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'check-qol-plugin-data.cjs');
const { lintFile } = require(HOOK);

const PLUGIN = (id = 'qol-explorer') => `[plugin]\nid = "${id}"\nname = "Explorer"\ndescription = "x"\nversion = "0.1.0"\n\n[menu]\nlabel = "Explorer"\nitems = []\n`;
const OPEN = '\n[action.open]\nlabel = "Open Explorer"\nargs = ["open"]\n';
const SETTINGS = '\n[action.settings]\nlabel = "Settings"\nkind = "settings"\nargs = ["--settings"]\n';
const SHORTCUT = (extra = '') => `\n[[shortcuts]]\nid = "open"\nname = "Explorer"\n${extra}`;
const FLOW = '\n[launcher]\nkind = "flow"\ntitle = "Explorer"\nquery = "rows"\n';

function pluginDir({ config = false } = {}) {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qac-data-')), 'qol-monorepo', 'plugins', 'explorer');
    fs.mkdirSync(dir, { recursive: true });
    if (config) fs.writeFileSync(path.join(dir, 'qol-config.toml'), 'schema_version = 1\n');
    return dir;
}

function run(payload) {
    const result = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
    const decision = result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput : null;
    return { status: result.status, decision };
}

function write(dir, content, file = 'plugin.toml') {
    return run({ tool_name: 'Write', tool_input: { file_path: path.join(dir, file), content } });
}

const WRITE_CASES = [
    ['open action with no launcher entry', PLUGIN() + OPEN, {}, /Open action has no launcher entry in plugin\.toml: line 11/],
    ['shortcut exporting open', PLUGIN() + OPEN + SHORTCUT('action = "open"\nexport_to_launcher = true\n'), {}, null],
    ['shortcut with the default action and export', PLUGIN() + OPEN + SHORTCUT(), {}, null],
    ['shortcut not exported', PLUGIN() + OPEN + SHORTCUT('export_to_launcher = false\n'), {}, /no launcher entry/],
    ['shortcut for another action', PLUGIN() + OPEN + SHORTCUT('action = "lock"\n'), {}, /no launcher entry/],
    ['launcher flow', PLUGIN() + OPEN + FLOW, {}, null],
    ['launcher plugin opens itself', PLUGIN('qol-launcher') + OPEN, {}, null],
    ['alt-tab opens from its hotkey', PLUGIN('qol-alt-tab') + OPEN, {}, null],
    ['open declared as settings', PLUGIN() + OPEN.replace('args', 'kind = "settings"\nargs'), {}, null],
    ['no open action', PLUGIN(), {}, null],
    ['settings contract without settings action', PLUGIN(), { config: true }, /Settings contract has no settings action in plugin\.toml: line 1 .*Settings > Explorer/],
    ['settings contract with settings action', PLUGIN() + SETTINGS, { config: true }, null],
    ['both gaps', PLUGIN() + OPEN, { config: true }, /no launcher entry[\s\S]*no settings action/],
    ['not a manifest', '[menu]\nlabel = "x"\n', { config: true }, null],
];

for (const [name, content, options, expected] of WRITE_CASES) {
    test(`write: ${name}`, () => {
        const result = write(pluginDir(options), content);
        assert.equal(result.status, 0);
        if (expected === null) {
            assert.equal(result.decision, null);
            return;
        }
        assert.equal(result.decision.permissionDecision, 'deny');
        assert.match(result.decision.permissionDecisionReason, expected);
        assert.match(result.decision.permissionDecisionReason, /\[qol-plugin-data\]/);
    });
}

test('ignores files that are not a qol plugin manifest', () => {
    const dir = pluginDir();
    assert.equal(write(dir, PLUGIN() + OPEN, 'Cargo.toml').decision, null);
    const outside = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'other-')), 'plugin.toml');
    assert.equal(run({ tool_name: 'Write', tool_input: { file_path: outside, content: PLUGIN() + OPEN } }).decision, null);
});

test('an edit to a manifest that already has a gap is denied until the gap is fixed', () => {
    const dir = pluginDir();
    const file = path.join(dir, 'plugin.toml');
    fs.writeFileSync(file, PLUGIN() + OPEN);
    const result = run({
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: 'version = "0.1.0"', new_string: 'version = "0.2.0"' },
    });
    assert.equal(result.decision.permissionDecision, 'deny');
    const fixed = run({
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: 'version = "0.1.0"', new_string: `version = "0.2.0"\n${SHORTCUT()}` },
    });
    assert.equal(fixed.decision, null);
});

test('an edit that removes the launcher entry is denied', () => {
    const dir = pluginDir();
    const file = path.join(dir, 'plugin.toml');
    const shortcut = SHORTCUT('action = "open"\n');
    fs.writeFileSync(file, PLUGIN() + OPEN + shortcut);
    const result = run({ tool_name: 'Edit', tool_input: { file_path: file, old_string: shortcut, new_string: '' } });
    assert.equal(result.decision.permissionDecision, 'deny');
});

test('lintFile reports every gap whatever the baseline holds', () => {
    const dir = pluginDir({ config: true });
    const file = path.join(dir, 'plugin.toml');
    const content = PLUGIN() + OPEN;
    assert.equal(lintFile(file, content).length, 2);
    assert.equal(lintFile(file, content, content).length, 2);
    assert.equal(lintFile(file, content, PLUGIN() + OPEN + SHORTCUT()).length, 2);
    assert.deepEqual(lintFile(file, PLUGIN() + OPEN + SHORTCUT() + SETTINGS, content), []);
});

const DAEMON = port => `\n[daemon]\nenabled = true\ncommand = "qol-x"\nport = ${port}\n`;

function siblingPlugin(dir, folder, id, port) {
    const sibling = path.join(path.dirname(dir), folder);
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, 'plugin.toml'), PLUGIN(id) + DAEMON(port));
}

const PORT_CASES = [
    ['port another plugin declares', [['lights', 'qol-lights', 42710]], 42710, /Daemon port is taken in plugin\.toml: line 14 sets \[daemon\] port = 42710, which qol-lights already declares/],
    ['port two plugins declare', [['lights', 'qol-lights', 42710], ['sound', 'qol-sound', 42710]], 42710, /which qol-lights, qol-sound already declares/],
    ['free port', [['lights', 'qol-lights', 42710]], 42720, null],
    ['no sibling plugins', [], 42710, null],
];

for (const [name, siblings, port, expected] of PORT_CASES) {
    test(`port: ${name}`, () => {
        const dir = pluginDir();
        for (const [folder, id, taken] of siblings) siblingPlugin(dir, folder, id, taken);
        const result = write(dir, PLUGIN() + DAEMON(port));
        assert.equal(result.status, 0);
        if (expected === null) {
            assert.equal(result.decision, null);
            return;
        }
        assert.equal(result.decision.permissionDecision, 'deny');
        assert.match(result.decision.permissionDecisionReason, expected);
        assert.match(result.decision.permissionDecisionReason, /give this daemon a free port/);
    });
}

test('port: a sibling folder without a manifest or a daemon port is ignored', () => {
    const dir = pluginDir();
    fs.mkdirSync(path.join(path.dirname(dir), 'empty'), { recursive: true });
    const noPort = path.join(path.dirname(dir), 'session');
    fs.mkdirSync(noPort, { recursive: true });
    fs.writeFileSync(path.join(noPort, 'plugin.toml'), PLUGIN('qol-session'));
    assert.equal(write(dir, PLUGIN() + DAEMON(42710)).decision, null);
});

test('port: lintFile reports a collision whatever the baseline holds', () => {
    const dir = pluginDir();
    siblingPlugin(dir, 'lights', 'qol-lights', 42710);
    const file = path.join(dir, 'plugin.toml');
    const content = PLUGIN() + DAEMON(42710);
    assert.equal(lintFile(file, content).length, 1);
    assert.equal(lintFile(file, content, content).length, 1);
});

const IDENTITY_MANIFESTS = {
    launcher: '[plugin]\nid = "qol-launcher"\nname = "Launcher"\nuid = "5cc75f62-2e3b-463c-ac7b-ae269cff1ef1"\n\n[daemon]\nsocket = "/tmp/qol-launcher.sock"\n',
    lights: '[plugin]\nid = "qol-lights"\nname = "Lights"\n\n[daemon]\nsocket = "/tmp/plugin-lights.sock"\nport = 42710\n',
    'cli-sessions': '[plugin]\nid = "qol-cli-sessions"\nname = "CLI Sessions"\n',
};
const IDENTITY_HINT = /\[qol-plugin-data\] take it from the generated qol-plugin-ids crate in this edit/;
const TRAY_LIB = path.join('apps', 'tray', 'src', 'lib.rs');

function identityRepo(manifests = IDENTITY_MANIFESTS) {
    const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qac-ids-')), 'qol-monorepo');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'plugins'), { recursive: true });
    for (const [folder, manifest] of Object.entries(manifests)) {
        fs.mkdirSync(path.join(root, 'plugins', folder), { recursive: true });
        fs.writeFileSync(path.join(root, 'plugins', folder, 'plugin.toml'), manifest);
    }
    return root;
}

const IDENTITY_CASES = [
    ['id outside its plugin', TRAY_LIB, 'const L: &str = "qol-launcher";\n', /^Plugin identity typed by hand in lib\.rs: on line 1, "qol-launcher" is the launcher plugin's id typed by hand; use qol_plugin_ids::launcher::ID instead\./],
    ['uid', TRAY_LIB, 'const U: &str = "5cc75f62-2e3b-463c-ac7b-ae269cff1ef1";\n', /"5cc75f62-2e3b-463c-ac7b-ae269cff1ef1" is the launcher plugin's uid typed by hand; use qol_plugin_ids::launcher::UID instead/],
    ['socket file name', 'libs/runtime/src/lib.rs', 'const S: &str = "qol-launcher.sock";\n', /"qol-launcher\.sock" is the launcher plugin's socket typed by hand; use qol_plugin_ids::launcher::SOCKET_NAME instead/],
    ['socket path', 'libs/runtime/src/lib.rs', 'const S: &str = "/tmp/qol-launcher.sock";\n', /"\/tmp\/qol-launcher\.sock" holds the launcher plugin's socket typed by hand/],
    ['socket path template', 'tools/cli/src/reload.rs', 'fn s(dir: &str) -> String {\n    format!("{}/plugin-lights.sock", dir)\n}\n', /on line 2, "\{\}\/plugin-lights\.sock" holds the lights plugin's socket typed by hand; use qol_plugin_ids::lights::SOCKET_NAME instead/],
    ['port as an integer', TRAY_LIB, 'let p = 42710;\n', /on line 1, 42710 is the lights plugin's port typed by hand; use qol_plugin_ids::lights::PORT instead/],
    ['port with separators and a suffix', TRAY_LIB, 'let p = 42_710u16;\n', /on line 1, 42_710u16 is the lights plugin's port/],
    ['port inside a string', TRAY_LIB, 'let a = "127.0.0.1:42710";\n', /"127\.0\.0\.1:42710" holds the lights plugin's port typed by hand/],
    ['folder with a dash', TRAY_LIB, 'const C: &str = "qol-cli-sessions";\n', /is the cli-sessions plugin's id typed by hand; use qol_plugin_ids::cli_sessions::ID instead/],
    ['another plugin\'s folder', 'plugins/clipboard/src/host.rs', 'const L: &str = "qol-launcher";\n', /in host\.rs: on line 1, "qol-launcher" is the launcher plugin's id/],
    ['raw string', TRAY_LIB, 'const L: &str = r#"qol-launcher"#;\n', /"qol-launcher" is the launcher plugin's id/],
    ['own folder', 'plugins/launcher/src/main.rs', 'const L: &str = "qol-launcher";\n', null],
    ['own port', 'plugins/lights/src/net.rs', 'let p = 42710;\n', null],
    ['comments', TRAY_LIB, '// talks to "qol-launcher" on 42710\n/* "qol-launcher" */\nfn f() {}\n', null],
    ['test module', TRAY_LIB, 'fn f() {}\n\n#[cfg(test)]\nmod tests {\n    const L: &str = "qol-launcher";\n}\n', null],
    ['test file', 'apps/tray/tests/ids.rs', 'const L: &str = "qol-launcher";\n', null],
    ['migrations', 'libs/migrations/src/v1/mod.rs', 'const L: &str = "qol-launcher";\n', null],
    ['conventions', 'libs/conventions/src/lib.rs', 'pub const TITLE: &str = "qol-launcher";\n', null],
    ['generated crate', 'libs/plugin-ids/src/lib.rs', 'pub const ID: &str = "qol-launcher";\n', null],
    ['id inside a longer name', TRAY_LIB, 'const W: &str = "qol-launcher-window";\n', null],
    ['id inside a path', TRAY_LIB, 'const P: &str = "plugins/qol-launcher";\n', null],
    ['longer number', TRAY_LIB, 'let n = 427100;\n', null],
    ['hex number', TRAY_LIB, 'let n = 0x42710;\n', null],
    ['float', TRAY_LIB, 'let n = 42710.0;\n', null],
    ['generated constant', TRAY_LIB, 'const L: &str = qol_plugin_ids::launcher::ID;\n', null],
    ['not Rust', 'scripts/ids.py', 'LAUNCHER = "qol-launcher"\n', null],
];

for (const [name, rel, source, expected] of IDENTITY_CASES) {
    test(`identity: ${name}`, () => {
        const messages = lintFile(path.join(identityRepo(), rel), source);
        if (expected === null) {
            assert.deepEqual(messages, []);
            return;
        }
        assert.equal(messages.length, 1);
        assert.match(messages[0], expected);
        assert.match(messages[0], IDENTITY_HINT);
    });
}

test('identity: every hit is its own finding, in line order', () => {
    const source = 'fn a() {}\nconst L: &str = "qol-launcher";\n\n\nconst P: u16 = 42710;\n';
    const messages = lintFile(path.join(identityRepo(), TRAY_LIB), source);
    assert.equal(messages.length, 2);
    assert.match(messages[0], /on line 2, "qol-launcher"/);
    assert.match(messages[1], /on line 5, 42710/);
});

test('identity: lintFile reports a hit whatever the baseline holds', () => {
    const file = path.join(identityRepo(), TRAY_LIB);
    const source = 'const L: &str = "qol-launcher";\n';
    assert.equal(lintFile(file, source, source).length, 1);
    assert.equal(lintFile(file, source, '').length, 1);
});

test('identity: a repository without a plugins folder has nothing to check', () => {
    const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qac-ids-')), 'qol-monorepo');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    assert.deepEqual(lintFile(path.join(root, TRAY_LIB), 'const L: &str = "qol-launcher";\n'), []);
});

test('identity: a plugin folder without a readable manifest is ignored', () => {
    const root = identityRepo({ ...IDENTITY_MANIFESTS, menu: '[menu]\nlabel = "qol-menu"\n', empty: '' });
    fs.mkdirSync(path.join(root, 'plugins', 'bare'));
    fs.mkdirSync(path.join(root, 'plugins', 'odd', 'plugin.toml'), { recursive: true });
    const file = path.join(root, TRAY_LIB);
    assert.deepEqual(lintFile(file, 'const M: &str = "qol-menu";\n'), []);
    assert.equal(lintFile(file, 'const L: &str = "qol-launcher";\n').length, 1);
});

test('identity: the hook denies a write that types a plugin id and allows the generated constant', () => {
    const file = path.join(identityRepo(), TRAY_LIB);
    const denied = run({ tool_name: 'Write', tool_input: { file_path: file, content: 'const L: &str = "qol-launcher";\n' } });
    assert.equal(denied.status, 0);
    assert.equal(denied.decision.permissionDecision, 'deny');
    assert.match(denied.decision.permissionDecisionReason, /"qol-launcher" is the launcher plugin's id typed by hand/);
    assert.match(denied.decision.permissionDecisionReason, IDENTITY_HINT);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'const L: &str = "qol-launcher";\n');
    const fixed = run({
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: '"qol-launcher"', new_string: 'qol_plugin_ids::launcher::ID' },
    });
    assert.equal(fixed.decision, null);
});
