'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'deny-tool-matches.cjs');
const {
    TOOL_MATCH,
    editPairs,
    inScope,
    targetPath,
} = require('../bin/deny-tool-matches.cjs');

const REPO = '/media/kmrh47/WD_SN850X/Git/qol-monorepo';

function run(payload) {
    const r = spawnSync('node', [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
    });
    return { exitCode: r.status, stdout: r.stdout };
}

function editPayload(filePath, newString) {
    return {
        tool_name: 'Edit',
        tool_input: {
            file_path: filePath,
            old_string: 'old',
            new_string: newString,
        },
    };
}

test('detects a match on the tool added to daemon shared code', () => {
    const r = run(editPayload(
        `${REPO}/plugins/cli-sessions/src/daemon/reconcile.rs`,
        'let label = match tool {\n    Tool::Pi => "pi",\n};',
    ));
    assert.equal(r.exitCode, 0);
    assert.ok(r.stdout.includes('permissionDecision'));
    assert.ok(r.stdout.includes('deny'));
    assert.ok(r.stdout.includes('deny-tool-matches'));
});

test('detects a match on a field accessor in UI code', () => {
    const r = run(editPayload(
        `${REPO}/plugins/cli-sessions/src/ui/notify.rs`,
        'match s.tool {\n    Tool::Kimi => "Kimi",\n};',
    ));
    assert.ok(r.stdout.includes('deny'));
});

test('detects a match inside a MultiEdit pair', () => {
    const r = run({
        tool_name: 'MultiEdit',
        tool_input: {
            file_path: `${REPO}/plugins/cli-sessions/src/signal/screen.rs`,
            edits: [
                { old_string: 'a', new_string: 'clean' },
                { old_string: 'b', new_string: 'match tool {\n    Tool::Claude => c,\n};' },
            ],
        },
    });
    assert.ok(r.stdout.includes('deny'));
});

test('detects a match in the shared library cli root', () => {
    const r = run(editPayload(
        `${REPO}/libs/qol-terminal-sessions/src/cli/interpreter.rs`,
        'match tool {\n    _ => {}\n};',
    ));
    assert.ok(r.stdout.includes('deny'));
});

test('lets a match in the tool model file through', () => {
    const r = run(editPayload(
        `${REPO}/plugins/cli-sessions/src/session/tool.rs`,
        'match tool {\n    Tool::Generic => "generic",\n};',
    ));
    assert.ok(!r.stdout.includes('deny'));
});

test('lets a match in a backend module through', () => {
    const r = run(editPayload(
        `${REPO}/libs/qol-terminal-sessions/src/cli/builtins/pi/mod.rs`,
        'match tool {\n    _ => {}\n};',
    ));
    assert.ok(!r.stdout.includes('deny'));
});

test('lets a match in a test file through', () => {
    const r = run(editPayload(
        `${REPO}/plugins/cli-sessions/tests/reconcile.rs`,
        'match tool {\n    _ => {}\n};',
    ));
    assert.ok(!r.stdout.includes('deny'));
});

test('lets clean edits in scoped files through', () => {
    const r = run(editPayload(
        `${REPO}/plugins/cli-sessions/src/daemon/reconcile.rs`,
        'let label = descriptor.display_name;',
    ));
    assert.ok(!r.stdout.includes('deny'));
});

test('lets edits outside the interpretation roots through', () => {
    for (const filePath of [
        `${REPO}/apps/qol-tray/src/lib.rs`,
        '/tmp/scratch.rs',
        `${REPO}/libs/qol-terminal-sessions/src/kitty/mod.rs`,
    ]) {
        const r = run(editPayload(filePath, 'match tool {\n    _ => {}\n};'));
        assert.ok(!r.stdout.includes('deny'), `expected allow for ${filePath}`);
    }
});

test('TOOL_MATCH recognizes the observed branch shapes', () => {
    assert.ok(TOOL_MATCH.test('match tool {'));
    assert.ok(TOOL_MATCH.test('match s.tool {'));
    assert.ok(TOOL_MATCH.test('match session.tool {'));
    assert.ok(!TOOL_MATCH.test('match status {'));
    assert.ok(!TOOL_MATCH.test('if tool == Tool::Pi {'));
});

test('inScope honors the roots and the exemptions', () => {
    assert.ok(inScope(`${REPO}/plugins/cli-sessions/src/daemon/reconcile.rs`));
    assert.ok(inScope(`${REPO}/libs/qol-terminal-sessions/src/cli/naming.rs`));
    assert.ok(!inScope(`${REPO}/apps/qol-tray/src/lib.rs`));
    assert.ok(!inScope(`${REPO}/libs/qol-terminal-sessions/src/kitty/mod.rs`));
    assert.ok(!inScope(`${REPO}/plugins/cli-sessions/src/session/tool.rs`));
    assert.ok(!inScope(`${REPO}/plugins/cli-sessions/tests/reconcile.rs`));
    assert.ok(!inScope('/tmp/scratch.rs'));
});

test('editPairs covers Edit, Write, and MultiEdit payloads', () => {
    assert.deepEqual(
        editPairs({ new_string: 'x', old_string: 'y' }),
        [['y', 'x']],
    );
    assert.deepEqual(editPairs({ content: 'z' }), [['', 'z']]);
    assert.deepEqual(
        editPairs({ edits: [{ old_string: 'a', new_string: 'b' }] }),
        [['a', 'b']],
    );
    assert.deepEqual(editPairs({}), []);
});

test('targetPath prefers file_path', () => {
    assert.equal(targetPath({ file_path: 'a', path: 'b' }), 'a');
    assert.equal(targetPath({ path: 'b' }), 'b');
    assert.equal(targetPath({}), null);
});
