'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'check-qol-logging.cjs');
const { lintFile } = require(HOOK);

const COMPLIANT = 'fn main() {\n    qol_log::init_stderr();\n    run();\n}\n';
const MISSING = 'fn main() {\n    run();\n}\n';
const LATE = 'fn main() {\n    run();\n    qol_log::init_stderr();\n}\n';
const NEVER = /Main never initializes the logger in /;
const NOT_FIRST = /Logger init is not first in main in /;

function pkg(name, extra = '') {
    return `[package]\nname = "${name}"\nversion = "1.0.0"\nedition = "2021"\n${extra}`;
}

const WORKSPACE = [
    '[workspace]',
    'members = ["apps/*", "libs/*", "plugins/*", "tools/*"]',
    '',
    '[workspace.dependencies]',
    'qol-config = { path = "libs/config" }',
    'qol-log = { path = "libs/log" }',
    'qol-store = { path = "libs/store" }',
    'qol-testkit = { path = "libs/testkit" }',
    'qol-builder = { path = "libs/builder" }',
    'qol-unix = { path = "libs/unix" }',
].join('\n');

const BASE = {
    'Cargo.toml': WORKSPACE,
    'libs/log/Cargo.toml': pkg('qol-log', '\n[dependencies]\nqol-config = { workspace = true }\n\n[target.\'cfg(unix)\'.dependencies]\nqol-unix = { workspace = true }\n\n[dev-dependencies]\nqol-testkit = { workspace = true }\n\n[build-dependencies]\nqol-builder = { path = "../builder" }\n'),
    'libs/config/Cargo.toml': pkg('qol-config', '\n[dependencies]\nqol-store = { path = "../store" }\n'),
    'libs/store/Cargo.toml': pkg('qol-store'),
    'libs/unix/Cargo.toml': pkg('qol-unix'),
    'libs/testkit/Cargo.toml': pkg('qol-testkit'),
    'libs/builder/Cargo.toml': pkg('qol-builder'),
    '.config/hakari.toml': 'hakari-package = "workspace-hack"\n\n[final-excludes]\nworkspace-members = [\n    "qol-lean",\n    "qol-plugin-registry",\n]\nthird-party = [\n    { name = "gpui" },\n]\n',
    'plugins/launcher/Cargo.toml': pkg('qol-launcher'),
    'apps/tray/Cargo.toml': pkg('qol-tray', '\n[[bin]]\nname = "qol-tray"\npath = "src/main.rs"\n\n[[bin]]\nname = "qol-tray-doctor"\npath = "src/doctor/main.rs"\n\n[[bin]]\nname = "qol-tray-install"\npath = "src/installer/main.rs"\n'),
    'libs/lean/Cargo.toml': pkg('qol-lean'),
    'tools/plugin-registry/Cargo.toml': pkg('qol-plugin-registry'),
};

function tree(files = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-logging-entry-'));
    const top = path.join(root, 'qol-monorepo');
    for (const [relative, content] of Object.entries({ ...BASE, ...files })) {
        const file = path.join(top, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
    return top;
}

function lint(top, relative, content, baseline = null) {
    return lintFile(path.join(top, relative), content, baseline).filter(message => NEVER.test(message) || NOT_FIRST.test(message));
}

function run(payload) {
    const result = spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
    return { exit: result.status, stdout: result.stdout };
}

test('accepts a main that calls qol_log::init_stderr() first', () => {
    const top = tree();
    assert.deepEqual(lint(top, 'plugins/launcher/src/main.rs', COMPLIANT), []);
});

test('accepts the call spelled with spaces, a leading path separator or an import', () => {
    const top = tree();
    assert.deepEqual(lint(top, 'plugins/launcher/src/main.rs', 'fn main() {\n    qol_log :: init_stderr ( ) ;\n}\n'), []);
    assert.deepEqual(lint(top, 'plugins/launcher/src/main.rs', 'fn main() -> std::process::ExitCode {\n    ::qol_log::init_stderr();\n    run()\n}\n'), []);
    assert.deepEqual(lint(top, 'plugins/launcher/src/main.rs', 'use qol_log::init_stderr;\n\nfn main() {\n    init_stderr();\n}\n'), []);
});

test('accepts an async main with the call first', () => {
    const top = tree();
    assert.deepEqual(lint(top, 'plugins/launcher/src/main.rs', '#[tokio::main]\nasync fn main() -> anyhow::Result<()> {\n    qol_log::init_stderr();\n    run().await\n}\n'), []);
});

test('reports a main without the call, naming its line and the fix', () => {
    const top = tree();
    const [message, ...rest] = lint(top, 'plugins/launcher/src/main.rs', `use std::io;\n\n${MISSING}`);
    assert.equal(rest.length, 0);
    assert.match(message, /^Main never initializes the logger in main\.rs: the main on line 3 calls no qol_log::init_stderr\(\), so every log:: call in this process is dropped\./);
    assert.match(message, /\n\[qol-logging\] add qol_log::init_stderr\(\); as the first statement of main \(qol-project:qol-arch-code, "Output: log, trace, command output"\)$/);
    assert.equal(message.split('\n').length, 2);
});

test('reports an async main without the call', () => {
    const top = tree();
    assert.equal(lint(top, 'plugins/launcher/src/main.rs', '#[tokio::main]\nasync fn main() {\n    run().await;\n}\n').length, 1);
});

test('reports a main that calls it later than first, naming both lines', () => {
    const top = tree();
    const [message, ...rest] = lint(top, 'plugins/launcher/src/main.rs', LATE);
    assert.equal(rest.length, 0);
    assert.match(message, /^Logger init is not first in main in main\.rs: on line 3, qol_log::init_stderr\(\) runs after other statements of the main on line 1\./);
    assert.match(message, /\n\[qol-logging\] make qol_log::init_stderr\(\); the first statement of main, so nothing logs before it \(qol-project:qol-arch-code, /);
});

test('a call inside a nested block, a comment or a string is not the first statement', () => {
    const top = tree();
    assert.match(lint(top, 'plugins/launcher/src/main.rs', 'fn main() {\n    if verbose {\n        qol_log::init_stderr();\n    }\n}\n')[0], NOT_FIRST);
    assert.match(lint(top, 'plugins/launcher/src/main.rs', 'fn main() {\n    // qol_log::init_stderr();\n    let s = "qol_log::init_stderr();";\n}\n')[0], NEVER);
});

test('the message never says why a bin is exempt', () => {
    const top = tree();
    for (const message of [...lint(top, 'plugins/launcher/src/main.rs', MISSING), ...lint(top, 'plugins/launcher/src/main.rs', LATE)]) {
        assert.doesNotMatch(message, /exempt|hakari|workspace-hack|cycle|closure/i);
    }
});

test('checks a main in src/bin/<name>.rs and src/bin/<name>/main.rs', () => {
    const top = tree();
    assert.match(lint(top, 'plugins/launcher/src/bin/tool.rs', MISSING)[0], NEVER);
    assert.match(lint(top, 'plugins/launcher/src/bin/tool/main.rs', LATE)[0], NOT_FIRST);
    assert.deepEqual(lint(top, 'plugins/launcher/src/bin/tool.rs', COMPLIANT), []);
});

test('checks a main at the path of a [[bin]] entry', () => {
    const top = tree({ 'plugins/launcher/Cargo.toml': pkg('qol-launcher', '\n[[bin]]\nname = "launcher-run"\npath = "src/cmd/run.rs"\n') });
    assert.match(lint(top, 'plugins/launcher/src/cmd/run.rs', MISSING)[0], NEVER);
    assert.deepEqual(lint(top, 'plugins/launcher/src/cmd/run.rs', COMPLIANT), []);
});

test('ignores a fn main that is not a process entry point', () => {
    const top = tree();
    for (const relative of [
        'plugins/launcher/src/lib.rs',
        'plugins/launcher/src/cli.rs',
        'plugins/launcher/src/bin/tool/helper.rs',
        'plugins/launcher/examples/demo.rs',
        'plugins/launcher/src/examples/demo.rs',
        'plugins/launcher/tests/integration.rs',
        'plugins/launcher/benches/speed.rs',
        'plugins/launcher/build.rs',
    ]) {
        assert.deepEqual(lint(top, relative, MISSING), [], relative);
    }
});

test('ignores a main inside a module and a main in test-only code', () => {
    const top = tree();
    assert.deepEqual(lint(top, 'plugins/launcher/src/main.rs', `${COMPLIANT}mod helper {\n    pub fn main() {}\n}\n`), []);
    assert.deepEqual(lint(top, 'plugins/launcher/src/main.rs', `${COMPLIANT}#[cfg(test)]\nmod tests {\n    fn main() {}\n}\n`), []);
});

test('reports each main of a file that declares several', () => {
    const top = tree();
    const found = lint(top, 'plugins/launcher/src/main.rs', '#[cfg(unix)]\nfn main() {\n    run();\n}\n\n#[cfg(not(unix))]\nfn main() {\n    qol_log::init_stderr();\n}\n');
    assert.equal(found.length, 1);
    assert.match(found[0], /the main on line 2/);
});

test('qol-tray host binary is exempt, its other bins are not', () => {
    const top = tree();
    assert.deepEqual(lint(top, 'apps/tray/src/main.rs', MISSING), []);
    assert.deepEqual(lint(top, 'apps/tray/src/main.rs', LATE), []);
    assert.match(lint(top, 'apps/tray/src/doctor/main.rs', MISSING)[0], NEVER);
    assert.match(lint(top, 'apps/tray/src/bin/qol-resident-policy.rs', MISSING)[0], NEVER);
    assert.match(lint(top, 'apps/tray/src/installer/main.rs', LATE)[0], NOT_FIRST);
    assert.deepEqual(lint(top, 'apps/tray/src/doctor/main.rs', COMPLIANT), []);
});

test('only the bin named qol-tray of a package named qol-tray is the host', () => {
    const top = tree({ 'plugins/launcher/Cargo.toml': pkg('qol-tray', '\n[[bin]]\nname = "other"\npath = "src/main.rs"\n') });
    assert.match(lint(top, 'plugins/launcher/src/main.rs', MISSING)[0], NEVER);
    const named = tree({ 'plugins/launcher/Cargo.toml': pkg('qol-launcher', '\n[[bin]]\nname = "qol-tray"\npath = "src/main.rs"\n') });
    assert.match(lint(named, 'plugins/launcher/src/main.rs', MISSING)[0], NEVER);
});

test('a package in qol-log normal dependency closure is exempt, however deep', () => {
    const top = tree();
    assert.deepEqual(lint(top, 'libs/config/src/bin/qol-config.rs', MISSING), []);
    assert.deepEqual(lint(top, 'libs/store/src/main.rs', MISSING), []);
    assert.deepEqual(lint(top, 'libs/unix/src/main.rs', MISSING), []);
    assert.deepEqual(lint(top, 'libs/log/src/main.rs', LATE), []);
});

test('a dev or build dependency of qol-log does not exempt a package', () => {
    const top = tree();
    assert.match(lint(top, 'libs/testkit/src/main.rs', MISSING)[0], NEVER);
    assert.match(lint(top, 'libs/builder/src/main.rs', MISSING)[0], NEVER);
});

test('the closure follows what the manifests say, not names', () => {
    const top = tree({ 'libs/log/Cargo.toml': pkg('qol-log', '\n[dependencies]\nqol-store = { workspace = true }\n') });
    assert.deepEqual(lint(top, 'libs/store/src/main.rs', MISSING), []);
    assert.match(lint(top, 'libs/config/src/bin/qol-config.rs', MISSING)[0], NEVER);
});

test('a package hakari keeps off workspace-hack is exempt', () => {
    const top = tree();
    assert.deepEqual(lint(top, 'libs/lean/src/main.rs', MISSING), []);
    assert.deepEqual(lint(top, 'tools/plugin-registry/src/main.rs', MISSING), []);
});

test('hakari third-party and traversal excludes do not exempt a package', () => {
    const top = tree({
        '.config/hakari.toml': '[final-excludes]\nworkspace-members = ["qol-lean"]\nthird-party = [{ name = "qol-launcher" }]\n\n[traversal-excludes]\nworkspace-members = ["qol-launcher"]\n',
    });
    assert.match(lint(top, 'plugins/launcher/src/main.rs', MISSING)[0], NEVER);
    assert.deepEqual(lint(top, 'libs/lean/src/main.rs', MISSING), []);
});

test('without a hakari config nothing is exempt by it', () => {
    const top = tree();
    fs.rmSync(path.join(top, '.config'), { recursive: true });
    assert.match(lint(top, 'libs/lean/src/main.rs', MISSING)[0], NEVER);
});

test('a workspace without libs/log is not qol-monorepo and is ignored', () => {
    const top = tree();
    fs.rmSync(path.join(top, 'libs', 'log'), { recursive: true });
    assert.deepEqual(lint(top, 'plugins/launcher/src/main.rs', MISSING), []);
});

test('a package outside any workspace, or in a workspace of its own, is ignored', () => {
    const top = tree({
        'docs/research/probe/Cargo.toml': `${pkg('probe')}\n[workspace]\n`,
        'standalone/Cargo.toml': pkg('standalone'),
    });
    assert.deepEqual(lint(top, 'docs/research/probe/src/main.rs', MISSING), []);
    const loose = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-logging-entry-'));
    fs.mkdirSync(path.join(loose, 'qol-monorepo', 'src'), { recursive: true });
    assert.deepEqual(lint(path.join(loose, 'qol-monorepo'), 'src/main.rs', MISSING), []);
    assert.deepEqual(lintFile('/x/qol-monorepo/plugins/launcher/src/main.rs', MISSING, null).filter(message => NEVER.test(message)), []);
});

test('lint mode reports the site whatever the baseline holds', () => {
    const top = tree();
    for (const baseline of [null, '', MISSING, COMPLIANT]) {
        assert.equal(lint(top, 'plugins/launcher/src/main.rs', MISSING, baseline).length, 1);
        assert.equal(lint(top, 'plugins/launcher/src/main.rs', LATE, baseline).length, 1);
    }
});

test('the hook denies a write of a main without the call, naming the section', () => {
    const top = tree();
    const result = run({ tool_name: 'Write', tool_input: { file_path: path.join(top, 'plugins/launcher/src/main.rs'), content: MISSING } });
    assert.equal(result.exit, 0);
    const reason = JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /Main never initializes the logger in main\.rs/);
    assert.match(reason, /\[qol-logging\] add qol_log::init_stderr\(\); as the first statement of main \(qol-project:qol-arch-code, "Output: log, trace, command output"\)/);
});

test('the hook allows a compliant main and an exempt bin', () => {
    const top = tree();
    for (const [relative, content] of [
        ['plugins/launcher/src/main.rs', COMPLIANT],
        ['apps/tray/src/main.rs', MISSING],
        ['libs/config/src/bin/qol-config.rs', MISSING],
        ['libs/lean/src/main.rs', MISSING],
    ]) {
        const result = run({ tool_name: 'Write', tool_input: { file_path: path.join(top, relative), content } });
        assert.deepEqual(result, { exit: 0, stdout: '' }, relative);
    }
});

test('the hook denies an edit that moves the call out of first place', () => {
    const top = tree({ 'plugins/launcher/src/main.rs': COMPLIANT });
    const result = run({
        tool_name: 'Edit',
        tool_input: { file_path: path.join(top, 'plugins/launcher/src/main.rs'), old_string: '    qol_log::init_stderr();\n    run();', new_string: '    run();\n    qol_log::init_stderr();' },
    });
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, NOT_FIRST);
});

test('the hook denies an edit while the main keeps the gap, and allows the edit that closes it', () => {
    const top = tree({ 'plugins/launcher/src/main.rs': `${MISSING}fn other() {}\n` });
    const file = path.join(top, 'plugins/launcher/src/main.rs');
    const denied = run({ tool_name: 'Edit', tool_input: { file_path: file, old_string: 'fn other() {}', new_string: 'fn other() { work(); }' } });
    assert.match(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecisionReason, NEVER);
    const fixed = run({ tool_name: 'Edit', tool_input: { file_path: file, old_string: 'fn main() {\n', new_string: 'fn main() {\n    qol_log::init_stderr();\n' } });
    assert.deepEqual(fixed, { exit: 0, stdout: '' });
});

test('the hook denies a MultiEdit that leaves a main without the call', () => {
    const top = tree({ 'plugins/launcher/src/main.rs': COMPLIANT });
    const result = run({
        tool_name: 'MultiEdit',
        tool_input: { file_path: path.join(top, 'plugins/launcher/src/main.rs'), edits: [{ old_string: '    qol_log::init_stderr();\n', new_string: '' }] },
    });
    assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, NEVER);
});

test('the hook ignores a write outside qol-monorepo', () => {
    const loose = fs.mkdtempSync(path.join(os.tmpdir(), 'plain-'));
    fs.mkdirSync(path.join(loose, 'src'), { recursive: true });
    fs.writeFileSync(path.join(loose, 'Cargo.toml'), pkg('plain'));
    const result = run({ tool_name: 'Write', tool_input: { file_path: path.join(loose, 'src/main.rs'), content: MISSING } });
    assert.deepEqual(result, { exit: 0, stdout: '' });
});

test('a main that prints and lacks the call yields two separate findings', () => {
    const top = tree();
    const messages = lintFile(path.join(top, 'plugins/launcher/src/main.rs'), 'fn main() {\n    eprintln!("x");\n}\n', null);
    assert.equal(messages.length, 2);
    assert.match(messages[0], /New eprintln!/);
    assert.match(messages[1], NEVER);
});
