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
