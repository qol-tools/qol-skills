'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'check-qol-arch-code.cjs');
const { lintFile, LOCATORS } = require(HOOK);

const MATCH = 'fn label(tool: Tool) -> &\'static str {\n    match tool {\n        Tool::Pi => "pi",\n        _ => "other",\n    }\n}\n';
const CLEAN = 'fn label(descriptor: &Descriptor) -> &\'static str {\n    descriptor.display_name\n}\n';

function run(payload) {
    const result = spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
    return { exitCode: result.status, stderr: result.stderr };
}

function repo() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-tool-match-'));
    const root = path.join(temp, 'qol-monorepo');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    return root;
}

function place(root, relative, content) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (content !== undefined) fs.writeFileSync(file, content);
    return file;
}

function write(file, content) {
    return run({ tool_name: 'Write', tool_input: { file_path: file, content }, cwd: path.dirname(file) });
}

const refused = [
    'plugins/cli-sessions/src/daemon/reconcile.rs',
    'plugins/cli-sessions/src/daemon/notify.rs',
    'plugins/cli-sessions/src/signal/screen.rs',
    'libs/terminal-sessions/src/cli/interpreter.rs',
    'libs/terminal-sessions/src/cli/naming.rs',
];

const allowed = [
    'plugins/cli-sessions/src/session/tool.rs',
    'plugins/cli-sessions/tests/reconcile.rs',
    'plugins/cli-sessions/src/test/helpers.rs',
    'libs/terminal-sessions/src/cli/builtins/pi/mod.rs',
    'libs/terminal-sessions/src/kitty/mod.rs',
    'apps/qol-tray/src/lib.rs',
];

for (const relative of refused) {
    test(`Write adding a match on the tool is refused in ${relative}`, () => {
        const root = repo();
        const result = write(place(root, relative), MATCH);
        assert.equal(result.exitCode, 2);
        assert.match(result.stderr, /tool match violation/);
        assert.match(result.stderr, /second registry/);
    });
}

for (const relative of allowed) {
    test(`Write adding a match on the tool passes in ${relative}`, () => {
        const root = repo();
        const result = write(place(root, relative), MATCH);
        assert.doesNotMatch(result.stderr, /tool match violation/);
    });
}

test('the field accessor shapes are refused', () => {
    const root = repo();
    const file = place(root, 'plugins/cli-sessions/src/daemon/notify.rs');
    for (const shape of ['match s.tool {', 'match session.tool {', 'match tool{']) {
        const result = write(file, `fn f() {\n    ${shape}\n        _ => {}\n    }\n}\n`);
        assert.equal(result.exitCode, 2, shape);
    }
});

test('other matches and comparisons on the tool pass', () => {
    const root = repo();
    const file = place(root, 'plugins/cli-sessions/src/daemon/notify.rs');
    for (const shape of ['match status {', 'match toolbox {', 'if tool == Tool::Pi {', 'match tool_name {']) {
        const result = write(file, `fn f() {\n    ${shape}\n        _ => {}\n    }\n}\n`);
        assert.doesNotMatch(result.stderr, /tool match violation/, shape);
    }
});

test('a clean edit in a scoped file passes', () => {
    const root = repo();
    const file = place(root, 'plugins/cli-sessions/src/daemon/reconcile.rs');
    assert.doesNotMatch(write(file, CLEAN).stderr, /tool match violation/);
});

test('an Edit and a MultiEdit that add a match are refused, applied to the existing file', () => {
    const root = repo();
    const file = place(root, 'plugins/cli-sessions/src/daemon/reconcile.rs', `${CLEAN}// end\n`);
    const edit = run({
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: CLEAN, new_string: MATCH },
        cwd: path.dirname(file),
    });
    assert.equal(edit.exitCode, 2);
    const multi = run({
        tool_name: 'MultiEdit',
        tool_input: {
            file_path: file,
            edits: [
                { old_string: '// end', new_string: '// done' },
                { old_string: CLEAN, new_string: MATCH },
            ],
        },
        cwd: path.dirname(file),
    });
    assert.equal(multi.exitCode, 2);
});

test('an edit that leaves an existing match in place does not count it as new', () => {
    const root = repo();
    const file = place(root, 'plugins/cli-sessions/src/daemon/reconcile.rs', `${MATCH}// end\n`);
    const result = run({
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: '// end', new_string: '// done' },
        cwd: path.dirname(file),
    });
    assert.doesNotMatch(result.stderr, /tool match violation/);
});

test('a second match added beside an existing one is refused', () => {
    const root = repo();
    const file = place(root, 'plugins/cli-sessions/src/daemon/reconcile.rs', MATCH);
    assert.equal(write(file, `${MATCH}${MATCH}`).exitCode, 2);
});

test('a bypass marker lets one edit through and is consumed', () => {
    const root = repo();
    const file = place(root, 'plugins/cli-sessions/src/daemon/reconcile.rs');
    place(root, '.claude/bypass-qol-arch-code', '');
    assert.doesNotMatch(write(file, MATCH).stderr, /tool match violation/);
    assert.equal(fs.existsSync(path.join(root, '.claude', 'bypass-qol-arch-code')), false);
    assert.equal(write(file, MATCH).exitCode, 2);
});

test('lintFile reports the shape against the lint base and skips existing debt', () => {
    const root = repo();
    const file = place(root, 'plugins/cli-sessions/src/daemon/reconcile.rs');
    const fresh = lintFile(file, MATCH, null);
    assert.equal(fresh.length, 1);
    assert.match(fresh[0], /tool match violation/);
    assert.deepEqual(lintFile(file, MATCH, MATCH).filter(message => /tool match violation/.test(message)), []);
    assert.deepEqual(lintFile(file, CLEAN, null).filter(message => /tool match violation/.test(message)), []);
});

test('the locator finds the matching line', () => {
    const locator = LOCATORS.find(entry => entry.label === 'match on the tool in shared code');
    assert.ok(locator.re.test('    match s.tool {'));
    assert.ok(!locator.re.test('    match status {'));
});
