'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'check-qol-arch-code.cjs');
const FIXTURE = path.join(__dirname, 'fixtures', 'quoted-lines');
const { lintFile } = require(HOOK);
const { quotesOf, lexString } = require('../bin/qol-quote-guard.cjs');

function run(payload) {
    const result = spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
    return { exitCode: result.status, stderr: result.stderr };
}

function repo() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-quoted-lines-'));
    const root = path.join(temp, 'qol-monorepo');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(root, 'Cargo.toml'), '[workspace]\nmembers = ["libs/*"]\n');
    const crate = path.join(root, 'libs', 'quoted-lines');
    fs.cpSync(FIXTURE, crate, { recursive: true });
    return { root, crate, module: path.join(crate, 'src', 'plugin', 'register.tsx') };
}

function edit(file, oldString, newString) {
    return run({
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: oldString, new_string: newString },
        cwd: path.dirname(file),
    });
}

function write(file, content) {
    return run({ tool_name: 'Write', tool_input: { file_path: file, content }, cwd: path.dirname(file) });
}

function denied(result) {
    assert.equal(result.exitCode, 2, result.stderr);
    assert.match(result.stderr, /quoted line violation/);
}

function passed(result) {
    assert.equal(result.exitCode, 0, result.stderr);
    assert.doesNotMatch(result.stderr, /quoted line violation/);
}

test('Edit changing a line a test quotes directly is refused and names the quote', () => {
    const { module } = repo();
    const result = edit(module, "const FORK = 'project-fork'", "const FORK = 'fork'");
    denied(result);
    assert.match(result.stderr, /libs\/quoted-lines\/src\/plugin\/mod\.rs:15 MODULE\.contains\("const FORK = 'project-fork'"\)/);
    assert.match(result.stderr, /Update the quotes in the test/);
});

test('Edit changing a line a test quotes through a literal loop is refused', () => {
    const { module } = repo();
    const result = edit(module, 'CONTINUE)', 'CONTINUE_TEXT)');
    denied(result);
    assert.match(result.stderr, /mod\.rs:25 MODULE\.contains\("const sent = await sendTo\(\$, entry, CONTINUE\)"\)/);
});

test('a needle after a comment in the loop array is still a quote', () => {
    const { module } = repo();
    denied(edit(module, 'recordPart($, key, agentId)', 'recordPart($, agentId)'));
});

test('Write dropping a raw string quote is refused', () => {
    const { module } = repo();
    const content = fs.readFileSync(module, 'utf8').replace("on('turn.start'", "on('turn.begin'");
    denied(write(module, content));
});

test('an escaped quote is compared unescaped', () => {
    const { module } = repo();
    denied(edit(module, String.raw`/^\s*Project:`, String.raw`/^\s*Project :`));
});

test('MultiEdit breaking one quote is refused', () => {
    const { module } = repo();
    const result = run({
        tool_name: 'MultiEdit',
        tool_input: {
            file_path: module,
            edits: [
                { old_string: 'return next(e)', new_string: 'return next({ ...e })' },
                { old_string: "const FORK = 'project-fork'", new_string: "const FORK = 'fork'" },
            ],
        },
        cwd: path.dirname(module),
    });
    denied(result);
});

test('an included file outside the module folder is guarded too', () => {
    const { crate } = repo();
    denied(edit(path.join(crate, 'docs', 'notes.md'), 'Forks report', 'Forks file'));
});

test('an edit that keeps every quote passes', () => {
    const { module } = repo();
    passed(edit(module, 'return next(e)', 'return next({ ...e })'));
});

test('an edit adding a retired text is not this rule', () => {
    const { module } = repo();
    passed(edit(module, 'return next(e)', 'return takeOver(e)'));
});

test('a quote built with format! is not compared', () => {
    const { module } = repo();
    passed(edit(module, "const NAME = 'qol-switchboard'", "const NAME = 'switchboard'"));
});

test('a quote already missing before the edit does not block an unrelated edit', () => {
    const { module } = repo();
    fs.writeFileSync(module, fs.readFileSync(module, 'utf8').replace("const FORK = 'project-fork'\n", ''));
    passed(edit(module, 'return next(e)', 'return next({ ...e })'));
});

test('an edit whose old text is not in the file fails open', () => {
    const { module } = repo();
    passed(edit(module, 'no such text', "const FORK = 'fork'"));
});

test('a sibling file no test includes passes', () => {
    const { crate } = repo();
    const file = path.join(crate, 'src', 'plugin', 'helper.tsx');
    passed(write(file, 'export const unquoted = 2\n'));
});

test('a file with no package crate above it passes', () => {
    const { root } = repo();
    const file = path.join(root, 'docs', 'register.tsx');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    passed(write(file, 'const FORK = 1\n'));
});

test('a file outside a qol repository passes', () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'elsewhere-'));
    const crate = path.join(temp, 'project');
    fs.cpSync(FIXTURE, crate, { recursive: true });
    passed(edit(path.join(crate, 'src', 'plugin', 'register.tsx'), "const FORK = 'project-fork'", "const FORK = 'fork'"));
});

test('the bypass marker lets one edit through and is consumed', () => {
    const { root, module } = repo();
    const marker = path.join(root, '.claude', 'bypass-qol-arch-code');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '');
    passed(edit(module, "const FORK = 'project-fork'", "const FORK = 'fork'"));
    assert.equal(fs.existsSync(marker), false);
    denied(edit(module, "const FORK = 'project-fork'", "const FORK = 'fork'"));
});

test('an earlier check in the sequence still fires on Rust', () => {
    const { crate } = repo();
    const result = write(path.join(crate, 'src', 'plugin', 'mod.rs'), 'compile_error!("no");\n');
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /compile_error/);
});

test('qac lint reports a missing quote when linting the whole file', () => {
    const { module } = repo();
    const content = fs.readFileSync(module, 'utf8').replace("'project-fork'", "'fork'");
    const messages = lintFile(module, content);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /quoted line violation/);
});

test('qac lint against a base reports only quotes the change broke', () => {
    const { module } = repo();
    const original = fs.readFileSync(module, 'utf8');
    const broken = original.replace("'project-fork'", "'fork'");
    assert.equal(lintFile(module, broken, original).length, 1);
    assert.deepEqual(lintFile(module, broken, broken), []);
    assert.deepEqual(lintFile(module, original, null), []);
});

test('quotesOf picks the innermost literal loop and skips negated and non-literal calls', () => {
    const src = [
        'for outer in ["a"] {',
        '    for needle in ["b", r"c"] {',
        '        assert!(M.contains(needle));',
        '        assert!(!M.contains(needle));',
        '    }',
        '    assert!(M.contains(outer));',
        '}',
        'for value in [x, "d"] { assert!(M.contains(value)); }',
        'assert!(M.contains(&name));',
        'assert!(OTHER_M.contains("e"));',
        'assert!(M.contains("f"));',
    ].join('\n');
    assert.deepEqual(quotesOf(src, 'M').map(quote => quote.value), ['b', 'c', 'a', 'f']);
});

test('lexString unescapes Rust literals', () => {
    assert.equal(lexString(String.raw`"a\"b\\c\n\t\x41\u{263A}"`, 0).value, 'a"b\\c\n\tA☺');
    assert.equal(lexString('"one \\\n    two"', 0).value, 'one two');
    assert.equal(lexString('r##"a "# b"##', 0).value, 'a "# b');
    assert.equal(lexString('"open', 0), null);
});
