'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'code-deny-comments.cjs');
const {
    addedComments,
    extractComments,
    inQolRepo,
    languageFor,
} = require('../bin/code-deny-comments.cjs');

const RUST = languageFor('lib.rs');
const JS = languageFor('app.js');
const CSS = languageFor('theme.css');
const SCSS = languageFor('theme.scss');
const PY = languageFor('main.py');
const SH = languageFor('run.sh');

function run(payload) {
    const result = spawnSync('node', [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
    });
    return { exitCode: result.status, stdout: result.stdout };
}

function decisionOf(result) {
    assert.equal(result.exitCode, 0);
    if (!result.stdout.trim()) return null;
    return JSON.parse(result.stdout).hookSpecificOutput;
}

function qolPath(name) {
    return path.join(os.tmpdir(), 'qol-monorepo', name);
}

test('extracts line and block comments from Rust', () => {
    assert.deepEqual(extractComments('let x = 1; // why\n', RUST), [' why']);
    assert.deepEqual(extractComments('/* banner */ let x = 1;', RUST), [' banner ']);
    assert.deepEqual(extractComments('/// doc\nfn f() {}', RUST), ['/ doc']);
});

test('ignores comment tokens inside strings', () => {
    assert.deepEqual(extractComments('let url = "https://example.com";', RUST), []);
    assert.deepEqual(extractComments('const u = `a // b`;', JS), []);
    assert.deepEqual(extractComments("print('# not a comment')", PY), []);
});

test('ignores Rust lifetimes and raw strings', () => {
    assert.deepEqual(extractComments("fn f<'a>(s: &'a str) {}\n// added", RUST), [' added']);
    assert.deepEqual(extractComments('let s = r#"https://x // y"#;', RUST), []);
    assert.deepEqual(extractComments("let c = '/';\n", RUST), []);
});

test('ignores shell shebangs and parameter expansions', () => {
    assert.deepEqual(extractComments('#!/usr/bin/env bash\necho "${#items[@]}"\n', SH), []);
    assert.deepEqual(extractComments('#!/bin/sh\n# real comment\n', SH), [' real comment']);
});

test('plain CSS has no line comments, SCSS does', () => {
    assert.deepEqual(extractComments('a { background: url(http://x/y.png); }', CSS), []);
    assert.deepEqual(extractComments('a { color: red; /* why */ }', CSS), [' why ']);
    assert.deepEqual(extractComments('a { color: red; } // why', SCSS), [' why']);
    assert.deepEqual(extractComments('a { background: url(http://x); } // why', SCSS), [' why']);
});

test('python triple-quoted strings are not scanned for comments', () => {
    assert.deepEqual(extractComments('s = """a # b"""\n# real\n', PY), [' real']);
});

test('addedComments only reports comments the edit introduces', () => {
    assert.deepEqual(addedComments('// kept\nlet a = 1;', '// kept\nlet a = 2;', RUST), []);
    assert.deepEqual(addedComments('let a = 1;', '// new\nlet a = 1;', RUST), ['new']);
    assert.deepEqual(addedComments('// gone\nlet a = 1;', 'let a = 1;', RUST), []);
});

test('repo gate matches qol clones and worktrees only', () => {
    assert.ok(inQolRepo('/media/x/Git/qol-monorepo/libs/a/src/lib.rs'));
    assert.ok(inQolRepo('/media/x/Git/qol-monorepo-worktrees/feature/src/lib.rs'));
    assert.ok(inQolRepo('/media/x/Git/qol-skills/plugins/a/bin/b.cjs'));
    assert.ok(!inQolRepo('/media/x/Git/other-project/src/lib.rs'));
});

test('denies an Edit that adds a comment', () => {
    const decision = decisionOf(
        run({
            tool_name: 'Edit',
            tool_input: {
                file_path: qolPath('src/lib.rs'),
                old_string: 'let a = 1;',
                new_string: '// explain\nlet a = 1;',
            },
        })
    );
    assert.equal(decision.permissionDecision, 'deny');
    assert.match(decision.permissionDecisionReason, /\[code-deny-comments\]/);
    assert.match(decision.permissionDecisionReason, /explain/);
});

test('allows an Edit that adds no comment', () => {
    assert.equal(
        decisionOf(
            run({
                tool_name: 'Edit',
                tool_input: {
                    file_path: qolPath('src/lib.rs'),
                    old_string: 'let a = 1;',
                    new_string: 'let a = 2;',
                },
            })
        ),
        null
    );
});

test('allows files outside qol repos and unknown extensions', () => {
    const outside = {
        tool_name: 'Edit',
        tool_input: {
            file_path: path.join(os.tmpdir(), 'other-repo', 'src/lib.rs'),
            old_string: '',
            new_string: '// explain',
        },
    };
    assert.equal(decisionOf(run(outside)), null);

    const markdown = {
        tool_name: 'Edit',
        tool_input: {
            file_path: qolPath('README.md'),
            old_string: '',
            new_string: '<!-- explain -->',
        },
    };
    assert.equal(decisionOf(run(markdown)), null);
});

test('Write compares against the file already on disk', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-monorepo-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'lib.rs');
    fs.writeFileSync(file, '// kept\nlet a = 1;\n');

    const unchanged = run({
        tool_name: 'Write',
        tool_input: { file_path: file, content: '// kept\nlet a = 2;\n' },
    });
    assert.equal(decisionOf(unchanged), null);

    const added = run({
        tool_name: 'Write',
        tool_input: { file_path: file, content: '// kept\n// new\nlet a = 1;\n' },
    });
    assert.equal(decisionOf(added).permissionDecision, 'deny');
});

test('the bypass marker allows one edit and is consumed', (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-monorepo-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.mkdirSync(path.join(dir, '.claude'));
    const marker = path.join(dir, '.claude', 'bypass-no-comments');
    fs.writeFileSync(marker, '');

    const payload = {
        tool_name: 'Edit',
        tool_input: {
            file_path: path.join(dir, 'src', 'lib.rs'),
            old_string: 'let a = 1;',
            new_string: '// explain\nlet a = 1;',
        },
    };

    assert.equal(decisionOf(run(payload)), null);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(decisionOf(run(payload)).permissionDecision, 'deny');
});

test('MultiEdit denies when any edit adds a comment', () => {
    const decision = decisionOf(
        run({
            tool_name: 'MultiEdit',
            tool_input: {
                file_path: qolPath('src/lib.rs'),
                edits: [
                    { old_string: 'let a = 1;', new_string: 'let a = 2;' },
                    { old_string: 'let b = 1;', new_string: '// why\nlet b = 2;' },
                ],
            },
        })
    );
    assert.equal(decision.permissionDecision, 'deny');
});
