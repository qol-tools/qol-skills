'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'check-qol-logging.cjs');

function run(payload) {
    const result = spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
    return { exit: result.status, stdout: result.stdout };
}

function assertDeny(result, pattern) {
    assert.equal(result.exit, 0);
    const reason = JSON.parse(result.stdout).hookSpecificOutput?.permissionDecisionReason ?? '';
    assert.match(reason, /\[qol-logging\]/);
    assert.match(reason, pattern);
}

function assertAllow(result) {
    assert.equal(result.exit, 0);
    assert.equal(result.stdout, '');
}

function write(filePath, content) {
    return run({ tool_name: 'Write', tool_input: { file_path: filePath, content } });
}

function fixture(relative, content) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-logging-'));
    const file = path.join(root, 'qol-monorepo', relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return { root, file };
}

const PLUGIN_FILE = '/x/qol-monorepo/plugins/launcher/src/ui/controller.rs';

for (const macro of ['eprintln!("x")', 'eprint!("x")', 'dbg!(value)']) {
    test(`blocks a new ${macro} in plugin code`, () => {
        assertDeny(write(PLUGIN_FILE, `fn f() { ${macro}; }\n`), new RegExp(macro.split('(')[0]));
    });
}

test('allows log:: and probe! calls', () => {
    assertAllow(write(PLUGIN_FILE, 'fn f() { log::info!("x"); qol_runtime::probe!("T", "m"); }\n'));
});

test('allows println! since stdout is product output', () => {
    assertAllow(write(PLUGIN_FILE, 'fn f() { println!("{}", json); }\n'));
});

test('allows an edit that keeps the existing eprintln! count', () => {
    const { file } = fixture('plugins/launcher/src/ui/controller.rs', 'fn f() {\n    eprintln!("old");\n}\n');
    assertAllow(run({
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: 'eprintln!("old")', new_string: 'eprintln!("new")' },
    }));
});

test('blocks an edit that adds a second eprintln! to a file that has one', () => {
    const { file } = fixture('libs/apps/src/lib.rs', 'fn f() {\n    eprintln!("old");\n}\n');
    assertDeny(run({
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: '}\n', new_string: '    eprintln!("more");\n}\n' },
    }), /eprintln!/);
});

test('blocks eprintln! added through MultiEdit', () => {
    const { file } = fixture('apps/tray/src/app/mod.rs', 'fn f() {}\n');
    assertDeny(run({
        tool_name: 'MultiEdit',
        tool_input: { file_path: file, edits: [{ old_string: 'fn f() {}', new_string: 'fn f() { eprintln!("x"); }' }] },
    }), /eprintln!/);
});

test('ignores eprintln! inside the cfg(test) module and comments', () => {
    assertAllow(write(PLUGIN_FILE, [
        'fn f() {}',
        '// eprintln!("commented")',
        '#[cfg(test)]',
        'mod tests {',
        '    fn t() { eprintln!("test"); }',
        '}',
        '',
    ].join('\n')));
});

for (const exempt of [
    '/x/qol-monorepo/plugins/launcher/tests/launch.rs',
    '/x/qol-monorepo/plugins/launcher/examples/demo.rs',
    '/x/qol-monorepo/plugins/launcher/build.rs',
    '/x/qol-monorepo/plugins/launcher/src/cli.rs',
    '/x/qol-monorepo/plugins/launcher/src/cli/doctor.rs',
    '/x/qol-monorepo/tools/cli/src/main.rs',
    '/x/qol-monorepo/apps/tray/src/logging/relay.rs',
    '/x/qol-monorepo/libs/log/src/lib.rs',
    '/x/qol-monorepo/libs/runtime/src/probe.rs',
    '/x/qol-monorepo/libs/plugin-daemon/src/logger.rs',
]) {
    test(`exempts ${exempt.replace('/x/qol-monorepo/', '')}`, () => {
        assertAllow(write(exempt, 'fn f() { eprintln!("x"); }\n'));
    });
}

test('ignores non-qol repos and non-Rust files', () => {
    assertAllow(write('/x/other-repo/src/main.rs', 'fn f() { eprintln!("x"); }\n'));
    assertAllow(write('/x/qol-monorepo/scripts/run.sh', 'eprintln!("x")\n'));
});

test('bypass marker lets one edit through and is consumed', () => {
    const { root } = fixture('plugins/x/src/lib.rs', '');
    fs.mkdirSync(path.join(root, '.claude'));
    const marker = path.join(root, '.claude', 'bypass-qol-logging');
    fs.writeFileSync(marker, '');
    const payload = { tool_name: 'Write', cwd: root, tool_input: { file_path: PLUGIN_FILE, content: 'fn f() { eprintln!("x"); }\n' } };
    assertAllow(run(payload));
    assert.equal(fs.existsSync(marker), false);
    assertDeny(run(payload), /eprintln!/);
});
