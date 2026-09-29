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

for (const macro of ['eprintln!("x")', 'eprint!("x")', 'println!("x")', 'print!("x")', 'dbg!(value)']) {
    test(`blocks a new ${macro} in plugin code`, () => {
        assertDeny(write(PLUGIN_FILE, `fn f() { ${macro}; }\n`), new RegExp(macro.split('(')[0]));
    });
}

test('blocks a raw stderr handle in plugin code', () => {
    assertDeny(write(PLUGIN_FILE, 'fn f() { let _ = writeln!(std::io::stderr(), "x"); }\n'), /io::stderr\(\)/);
});

test('blocks a print allow outside a cli module', () => {
    assertDeny(write(PLUGIN_FILE, '#![allow(clippy::print_stderr)]\nfn f() {}\n'), /allow\(clippy::print_\*\)/);
});

test('allows a print allow and prints inside a cli module', () => {
    assertAllow(write('/x/qol-monorepo/plugins/launcher/src/cli.rs', '#![allow(clippy::print_stdout, clippy::print_stderr)]\nfn f() { println!("x"); }\n'));
});

test('blocks dbg! even inside a cli module', () => {
    assertDeny(write('/x/qol-monorepo/plugins/launcher/src/cli.rs', 'fn f() { dbg!(1); }\n'), /dbg!/);
});

test('allows log:: and probe! calls', () => {
    assertAllow(write(PLUGIN_FILE, 'fn f() { log::info!("x"); qol_runtime::probe!("T", "m"); }\n'));
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

test('ignores prints inside the cfg(test) module and comments', () => {
    assertAllow(write(PLUGIN_FILE, [
        'fn f() {}',
        '// eprintln!("commented")',
        '#[cfg(test)]',
        'mod tests {',
        '    #[allow(clippy::print_stdout)]',
        '    fn t() { println!("test"); dbg!(1); }',
        '}',
        '',
    ].join('\n')));
});

for (const allowed of [
    '/x/qol-monorepo/plugins/launcher/tests/launch.rs',
    '/x/qol-monorepo/plugins/launcher/examples/demo.rs',
    '/x/qol-monorepo/plugins/launcher/build.rs',
    '/x/qol-monorepo/plugins/launcher/src/cli.rs',
    '/x/qol-monorepo/plugins/launcher/src/cli/doctor.rs',
    '/x/qol-monorepo/apps/tray/src/app/host_cli.rs',
    '/x/qol-monorepo/libs/conventions/src/build/plugin_manifest.rs',
    '/x/qol-monorepo/tools/cli/src/commands/dev.rs',
    '/x/qol-monorepo/apps/tray/src/logging/relay.rs',
    '/x/qol-monorepo/libs/log/src/stderr.rs',
    '/x/qol-monorepo/libs/headless/src/lib.rs',
]) {
    test(`allows command output in ${allowed.replace('/x/qol-monorepo/', '')}`, () => {
        assertAllow(write(allowed, 'fn f() { eprintln!("x"); println!("y"); }\n'));
    });
}

for (const blocked of [
    '/x/qol-monorepo/libs/runtime/src/probe.rs',
    '/x/qol-monorepo/apps/tray/src/installer/mod.rs',
    '/x/qol-monorepo/plugins/launcher/src/client.rs',
]) {
    test(`blocks command output in ${blocked.replace('/x/qol-monorepo/', '')}`, () => {
        assertDeny(write(blocked, 'fn f() { eprintln!("x"); }\n'), /eprintln!/);
    });
}

test('ignores non-qol repos and non-Rust files', () => {
    assertAllow(write('/x/other-repo/src/main.rs', 'fn f() { eprintln!("x"); }\n'));
    assertAllow(write('/x/qol-monorepo/scripts/run.sh', 'eprintln!("x")\n'));
});
