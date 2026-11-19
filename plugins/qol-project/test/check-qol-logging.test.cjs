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

test('ignores prints in every test-only item, and still sees the code after them', () => {
    assertAllow(write(PLUGIN_FILE, [
        '#[cfg(test)]',
        'fn fixture() { println!("test"); }',
        '#[cfg(all(test, unix))]',
        'mod unix_tests {',
        '    fn t() { eprintln!("test"); }',
        '}',
        'fn f() {}',
        '',
    ].join('\n')));
    assertDeny(write(PLUGIN_FILE, '#[cfg(test)]\nmod tests {}\nfn after() { eprintln!("x"); }\n'), /eprintln!/);
    assertDeny(write(PLUGIN_FILE, '#[cfg(any(windows, test))]\nfn windows_too() { eprintln!("x"); }\n'), /eprintln!/);
});

test('ignores prints in a module its parent declares only for tests', () => {
    const { file } = fixture('plugins/launcher/src/feature/mod.rs', '#[cfg(test)]\nmod fixtures;\n');
    assertAllow(write(path.join(path.dirname(file), 'fixtures.rs'), 'fn f() { println!("x"); }\n'));
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

function bash(command, cwd = '/x/qol-monorepo') {
    return run({ tool_name: 'Bash', hook_event_name: 'PreToolUse', tool_use_id: `t${Date.now()}${Math.random()}`, cwd, tool_input: { command } });
}

test('blocks a python heredoc that writes eprintln! into a qol Rust file', () => {
    const command = [
        "python3 - <<'PY'",
        'p="libs/peers/src/service/session/active.rs"',
        's=open(p).read()',
        's=s.replace("outcome", "eprintln!(\\"PROBE\\"); outcome")',
        'open(p,"w").write(s)',
        'PY',
    ].join('\n');
    assertDeny(bash(command), /eprintln!/);
});

test('blocks sed -i with an escaped println into a qol Rust file', () => {
    assertDeny(bash("sed -i 's/a/println\\!(\"x\")/' plugins/launcher/src/client.rs"), /println!/);
});

test('blocks a redirect that appends dbg! to a qol Rust file', () => {
    assertDeny(bash("echo 'fn f() { dbg!(1); }' >> apps/tray/src/app/mod.rs"), /dbg!/);
});

test('allows reading prints with grep', () => {
    assertAllow(bash('grep -rn "eprintln!" libs/peers/src/service/session/active.rs'));
});

test('allows shell writes of command output into cli and test files', () => {
    assertAllow(bash("sed -i 's/a/println!(\"x\")/' plugins/launcher/src/cli.rs"));
    assertAllow(bash("sed -i 's/a/eprintln!(\"x\")/' plugins/launcher/tests/launch.rs"));
});

test('allows shell writes outside qol repos', () => {
    assertAllow(bash("sed -i 's/a/eprintln!(\"x\")/' src/main.rs", '/x/other-repo'));
});

function repo() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-logging-'));
    const dir = path.join(root, 'qol-monorepo');
    fs.mkdirSync(path.join(dir, 'libs/peers/src'), { recursive: true });
    const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
    git('init', '-q');
    fs.writeFileSync(path.join(dir, 'libs/peers/src/lib.rs'), 'fn f() {}\n');
    fs.writeFileSync(path.join(dir, 'libs/peers/src/old.rs'), 'fn f() { eprintln!("old"); }\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    return dir;
}

function around(dir, change) {
    const id = `t${Date.now()}${Math.random()}`.replace('.', '');
    const payload = { tool_name: 'Bash', tool_use_id: id, cwd: dir, tool_input: { command: 'python3 edit.py' } };
    assertAllow(run({ ...payload, hook_event_name: 'PreToolUse' }));
    change();
    return run({ ...payload, hook_event_name: 'PostToolUse' });
}

test('flags prints a shell command wrote through a script file', () => {
    const dir = repo();
    const result = around(dir, () => fs.appendFileSync(path.join(dir, 'libs/peers/src/lib.rs'), 'fn g() { eprintln!("x"); }\n'));
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /\[qol-logging\]/);
    assert.match(output.reason, /libs\/peers\/src\/lib\.rs \(eprintln!\)/);
});

test('flags prints in a new untracked file', () => {
    const dir = repo();
    const result = around(dir, () => fs.writeFileSync(path.join(dir, 'libs/peers/src/new.rs'), 'fn g() { dbg!(1); }\n'));
    assert.match(JSON.parse(result.stdout).reason, /new\.rs \(dbg!\)/);
});

const FS_MUTATORS = ['write', 'create_dir', 'create_dir_all', 'rename', 'copy', 'set_permissions', 'hard_link', 'soft_link'];
const THROWN_AWAY = /File system result thrown away in controller\.rs: on line (\d+), (\S+) drops the error of std::fs::(\w+); return it with \? or log it with log::warn! naming the path\./;

function lint(content, file = PLUGIN_FILE, baseline = null) {
    return require(HOOK).lintFile(file, content, baseline);
}

function fsFindings(content, file) {
    return lint(content, file).filter(message => THROWN_AWAY.test(message)).map(message => {
        const [, line, shown, name] = THROWN_AWAY.exec(message);
        return { line: Number(line), shown, name };
    });
}

const SHAPES = {
    'let underscore': call => `let _ = ${call};`,
    'bare underscore': call => `_ = ${call};`,
    'ok statement': call => `${call}.ok();`,
    'empty block arm': call => `match ${call} {\n        Ok(()) => {}\n        Err(_) => {}\n    }`,
    'unit arm with comma': call => `match ${call} {\n        Ok(()) => (),\n        Err(_) => (),\n    }`,
    'named underscore arm': call => `match ${call} {\n        Ok(()) => {}\n        Err(_why) => {},\n    }`,
    'rest pattern block arm': call => `match ${call} {\n        Ok(()) => {}\n        Err(..) => {}\n    }`,
    'rest pattern unit arm': call => `match ${call} {\n        Ok(()) => (),\n        Err(..) => (),\n    }`,
    'wildcard block arm': call => `match ${call} {\n        Ok(()) => log::info!("saved"),\n        _ => {}\n    }`,
    'wildcard unit arm': call => `match ${call} {\n        Ok(()) => log::info!("saved"),\n        _ => (),\n    }`,
    'let underscore ok': call => `let _ = ${call}.ok();`,
    'bare underscore ok': call => `_ = ${call}.ok();`,
    'ok statement with spaces': call => `${call} . ok ( ) ;`,
    'unwrap_or_default statement': call => `${call}.unwrap_or_default();`,
    'let underscore unwrap_or_default': call => `let _ = ${call}.unwrap_or_default();`,
    'bare underscore unwrap_or_default': call => `_ = ${call}.unwrap_or_default();`,
    'unwrap_or statement': call => `${call}.unwrap_or(());`,
    'let underscore unwrap_or': call => `let _ = ${call}.unwrap_or(());`,
    'bare underscore unwrap_or': call => `_ = ${call}.unwrap_or(());`,
};

const SPELLINGS = {
    short: name => `fs::${name}(path, data)`,
    std: name => `std::fs::${name}(path, data)`,
    'short with spaces': name => `fs :: ${name} (path, data)`,
    'std with spaces': name => `std :: fs\n        :: ${name}(path, data)`,
};

for (const [shape, build] of Object.entries(SHAPES)) {
    for (const [spelling, spell] of Object.entries(SPELLINGS)) {
        test(`reports ${shape} with the ${spelling} spelling for every mutator`, () => {
            for (const name of FS_MUTATORS) {
                const found = fsFindings(`fn f() {\n    ${build(spell(name))}\n}\n`);
                assert.deepEqual(found.map(({ line, name: reported }) => [line, reported]), [[2, name]], `${shape} ${name}`);
            }
        });
    }
}

test('shows the call the way it is spelled, without spaces around the path separators', () => {
    assert.equal(fsFindings('fn f() {\n    let _ = std :: fs :: rename(a, b);\n}\n')[0].shown, 'std::fs::rename(..)');
    assert.equal(fsFindings('fn f() {\n    let _ = fs :: copy(a, b);\n}\n')[0].shown, 'fs::copy(..)');
});

test('reports a call whose arguments span lines, nest calls and hold closures', () => {
    const found = fsFindings([
        'fn f() {',
        '    let _ = fs::write(',
        '        dir.join(format!("{}.pid", pid)),',
        '        encode(&|x| (x, (1, 2))),',
        '    );',
        '}',
        '',
    ].join('\n'));
    assert.deepEqual(found.map(({ line }) => line), [2]);
});

const HANDLED = {
    'question mark': 'fs::write(p, d)?;',
    'question mark on a let': 'let _ = fs::write(p, d)?;',
    'binding kept': 'let result = fs::write(p, d);',
    'named binding': 'let _kept = fs::write(p, d);',
    'unwrap': 'fs::write(p, d).unwrap();',
    'expect': 'fs::write(p, d).expect("write");',
    'map_err': 'let _ = fs::write(p, d).map_err(|e| log::warn!("{e}"));',
    'map_err statement': 'fs::write(p, d).map_err(|e| log::warn!("{e}")).ok();',
    'inspect_err': 'let _ = fs::write(p, d).inspect_err(|e| log::warn!("{e}"));',
    'unwrap_or_else': 'fs::write(p, d).unwrap_or_else(|e| log::warn!("{e}"));',
    'or_else': 'let _ = fs::write(p, d).or_else(|e| retry(e));',
    'if let Err': 'if let Err(e) = fs::write(p, d) { log::warn!("{e}"); }',
    'logging arm': 'match fs::write(p, d) {\n        Ok(()) => {}\n        Err(e) => log::warn!("{e}"),\n    }',
    'logging arm with block': 'match fs::write(p, d) {\n        Ok(()) => {}\n        Err(_) => { log::warn!("write failed"); }\n    }',
    'empty arm of another match': 'match other() {\n        Ok(()) => {}\n        Err(_) => {}\n    }',
    'empty arm nested in the body': 'match fs::write(p, d) {\n        Ok(()) => match next() {\n            Ok(()) => {}\n            Err(_) => {}\n        },\n        Err(e) => log::warn!("{e}"),\n    }',
    'wildcard beside an Err arm': 'match fs::write(p, d) {\n        Ok(()) => {}\n        Err(e) => log::warn!("{e}"),\n        _ => {}\n    }',
    'wildcard beside an Err arm with a guard': 'match fs::write(p, d) {\n        Err(e) if retry(&e) => again(),\n        Ok(()) => {}\n        _ => {}\n    }',
    'wildcard beside an Err arm in a block': 'match fs::write(p, d) {\n        Err(e) => { log::warn!("{e}"); }\n        _ => (),\n    }',
    'wildcard arm that logs': 'match fs::write(p, d) {\n        Ok(()) => {}\n        _ => log::warn!("failed"),\n    }',
    'wildcard of another match': 'match other() {\n        Ok(()) => {}\n        _ => {}\n    }',
    'wildcard nested in the body': 'match fs::write(p, d) {\n        Ok(()) => match next() {\n            Ok(()) => {}\n            _ => {}\n        },\n        Err(e) => log::warn!("{e}"),\n    }',
    'wildcard inside an Ok pattern': 'match fs::write(p, d) {\n        Ok(_) => {}\n        Err(e) => log::warn!("{e}"),\n    }',
    'Err with a binding': 'match fs::write(p, d) {\n        Ok(()) => {}\n        Err(error) => log::warn!("{error}"),\n    }',
    'ok kept in a binding': 'let kept = fs::write(p, d).ok();',
    'unwrap_or_default kept in a binding': 'let kept = fs::write(p, d).unwrap_or_default();',
    'unwrap_or kept in a binding': 'let kept = fs::write(p, d).unwrap_or(());',
    'unwrap_or_default chained on': 'fs::write(p, d).unwrap_or_default().to_string();',
    'unwrap_or with a handler before it': 'let _ = fs::write(p, d).map_err(|e| log::warn!("{e}")).unwrap_or(());',
    'unwrap_or_else statement': 'fs::write(p, d).unwrap_or_else(|_| ());',
    'returned value': 'return fs::write(p, d);',
    'tail value': 'fs::write(p, d)',
    'remove_file': 'let _ = fs::remove_file(p);',
    'remove_dir': '_ = fs::remove_dir(p);',
    'remove_dir_all': 'fs::remove_dir_all(p).ok();',
    'remove_dir_all match': 'match fs::remove_dir_all(p) {\n        Ok(()) => {}\n        Err(_) => {}\n    }',
    'read': 'let _ = fs::read(p);',
    'read_to_string': 'fs::read_to_string(p).ok();',
    'metadata': 'let _ = fs::metadata(p);',
    'tokio fs': 'let _ = tokio::fs::write(p, d);',
    'tokio fs with spaces': 'let _ = tokio :: fs :: rename(a, b);',
    'crate fs module': 'let _ = crate::fs::write(p, d);',
    'other receiver': 'let _ = other.fs::write(p, d);',
    'longer function name': 'let _ = fs::write_all(p, d);',
    'longer module name': 'let _ = myfs::write(p, d);',
    'imported write': 'let _ = write(p, d);',
    'file handle': 'let _ = file.write(d);',
    'drop': 'drop(fs::write(p, d));',
    'ok result kept': 'let kept = fs::write(p, d).ok();',
    'ok in a condition': 'if fs::write(p, d).ok().is_some() { go(); }',
};

for (const [name, body] of Object.entries(HANDLED)) {
    test(`passes ${name}`, () => {
        assert.deepEqual(fsFindings(`fn f() {\n    ${body}\n}\n`), []);
    });
}

test('reports a call written with a leading path separator', () => {
    assert.equal(fsFindings('fn f() {\n    let _ = ::std::fs::write(p, d);\n}\n').length, 1);
});

test('ignores a call inside a string, a comment or a raw string', () => {
    assert.deepEqual(fsFindings([
        'fn f() {',
        '    let text = "let _ = fs::write(p, d);";',
        '    let raw = r#"fs::rename(a, b).ok();"#;',
        '    // let _ = fs::copy(a, b);',
        '    /* fs::write(p, d).ok(); */',
        '    /// let _ = fs::create_dir(p);',
        '}',
        '',
    ].join('\n')), []);
});

test('ignores a test file and a cfg(test) module, and still sees the code after them', () => {
    const body = 'fn f() {\n    let _ = fs::write(p, d);\n    fs::rename(a, b).ok();\n}\n';
    for (const file of [
        '/x/qol-monorepo/plugins/launcher/tests/launch.rs',
        '/x/qol-monorepo/plugins/launcher/src/tests.rs',
        '/x/qol-monorepo/plugins/launcher/examples/demo.rs',
    ]) assert.deepEqual(fsFindings(body, file), [], file);
    assert.deepEqual(fsFindings(`#[cfg(test)]\nmod tests {\n    ${body}}\n`), []);
    assert.deepEqual(fsFindings(`#[cfg(all(test, unix))]\nfn fixture() {\n    ${body}}\n`), []);
    assert.deepEqual(fsFindings(`#[cfg(test)]\nmod tests {}\n${body}`).map(({ line }) => line), [4, 5]);
});

test('ignores non-qol repos and non-Rust files for thrown-away results', () => {
    const body = 'fn f() { let _ = fs::write(p, d); }\n';
    assert.deepEqual(lint(body, '/x/other-repo/src/main.rs'), []);
    assert.deepEqual(lint(body, '/x/qol-monorepo/scripts/run.sh'), []);
});

test('reports several sites in line order, one finding each', () => {
    const found = fsFindings([
        'fn f() {',
        '    fs::rename(a, b).ok();',
        '    let _ = fs::write(p, d);',
        '    let _ = fs::remove_file(p);',
        '    match fs::copy(a, b) {',
        '        Ok(_) => {}',
        '        Err(_) => {}',
        '    }',
        '    _ = std::fs::hard_link(a, b);',
        '}',
        '',
    ].join('\n'));
    assert.deepEqual(found.map(({ line, name }) => [line, name]), [[2, 'rename'], [3, 'write'], [5, 'copy'], [9, 'hard_link']]);
});

test('a finding carries the rule title, the way forward and a hint line', () => {
    const [message] = lint('fn f() {\n    let _ = fs::write(p, d);\n}\n');
    assert.equal(message.split('\n').length, 2);
    assert.match(message, /^File system result thrown away in controller\.rs: on line 2, /);
    assert.match(message, /\n\[qol-logging\] .*qol-arch-code/);
});

test('lint mode reports every site whatever the baseline holds', () => {
    const content = 'fn f() {\n    let _ = fs::write(p, d);\n    fs::rename(a, b).ok();\n}\n';
    for (const baseline of [null, '', content, 'fn f() {}\n']) {
        assert.equal(lint(content, PLUGIN_FILE, baseline).filter(message => THROWN_AWAY.test(message)).length, 2);
    }
});

test('lint mode reports a print and a thrown-away result as separate findings', () => {
    const messages = lint('fn f() {\n    eprintln!("x");\n    let _ = fs::write(p, d);\n}\n');
    assert.equal(messages.length, 2);
    assert.match(messages[0], /New eprintln! in controller\.rs/);
    assert.match(messages[1], THROWN_AWAY);
});

test('the hook denies a write that leaves a site, naming the line and the call', () => {
    const result = write(PLUGIN_FILE, 'fn f() {\n    let _ = std::fs::create_dir_all(dir);\n}\n');
    assertDeny(result, /File system result thrown away in controller\.rs: on line 2, std::fs::create_dir_all\(\.\.\) drops the error of std::fs::create_dir_all/);
});

test('the hook allows a clean write and a write that only removes files', () => {
    assertAllow(write(PLUGIN_FILE, 'fn f() -> std::io::Result<()> {\n    fs::write(p, d)?;\n    let _ = fs::remove_file(p);\n    Ok(())\n}\n'));
});

test('the hook denies an edit while the file keeps a site that was already there', () => {
    const { file } = fixture('plugins/launcher/src/ui/controller.rs', 'fn f() {\n    let _ = fs::write(p, d);\n}\nfn g() {}\n');
    assertDeny(run({
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: 'fn g() {}', new_string: 'fn g() { h(); }' },
    }), /on line 2, fs::write\(\.\.\) drops the error of std::fs::write/);
});

test('the hook allows the edit that handles the site', () => {
    const { file } = fixture('plugins/launcher/src/ui/controller.rs', 'fn f() {\n    let _ = fs::write(p, d);\n}\n');
    assertAllow(run({
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: 'let _ = fs::write(p, d);', new_string: 'fs::write(p, d).map_err(|e| log::warn!("{e}")).ok();' },
    }));
});

test('the hook denies a site added through MultiEdit', () => {
    const { file } = fixture('apps/tray/src/app/mod.rs', 'fn f() {}\n');
    assertDeny(run({
        tool_name: 'MultiEdit',
        tool_input: { file_path: file, edits: [{ old_string: 'fn f() {}', new_string: 'fn f() { fs::rename(a, b).ok(); }' }] },
    }), /fs::rename\(\.\.\) drops the error of std::fs::rename/);
});

test('the hook gives one reason when a print and a site arrive together', () => {
    const result = write(PLUGIN_FILE, 'fn f() {\n    eprintln!("x");\n    let _ = fs::write(p, d);\n}\n');
    assertDeny(result, /New eprintln! in controller\.rs[\s\S]*File system result thrown away in controller\.rs: on line 3/);
});

test('does not flag prints that were already there or live in test modules', () => {
    const dir = repo();
    fs.appendFileSync(path.join(dir, 'libs/peers/src/lib.rs'), 'fn dirty() { println!("before"); }\n');
    assertAllow(around(dir, () => {
        fs.appendFileSync(path.join(dir, 'libs/peers/src/lib.rs'), 'fn h() {}\n');
        fs.writeFileSync(path.join(dir, 'libs/peers/src/old.rs'), 'fn f() { eprintln!("old"); }\n#[cfg(test)]\nmod tests {\n    fn t() { println!("x"); }\n}\n');
    }));
});
