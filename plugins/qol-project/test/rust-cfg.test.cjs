'use strict';

const test = require('node:test');
const assert = require('node:assert');
const rustCfg = require('../bin/rust-cfg.cjs');

const holdsOn = expression =>
    rustCfg.TARGETS.map(target => rustCfg.holds(rustCfg.parse(expression), target));

test('parses nested predicates into a tree', () => {
    assert.deepEqual(rustCfg.parse('all(debug_assertions, not(target_os = "windows"))'), {
        op: 'all',
        args: [
            { key: 'debug_assertions', value: null },
            { op: 'not', args: [{ key: 'target_os', value: 'windows' }] },
        ],
    });
    assert.deepEqual(rustCfg.parse(' any( unix , ) '), { op: 'any', args: [{ key: 'unix', value: null }] });
});

test('rejects what rustc rejects', () => {
    for (const expression of [
        'all(unix windows)',
        'not(unix, windows)',
        'not()',
        'feature(unix)',
        'all(unix',
        'target_os = linux',
        'unix windows',
        '',
    ]) {
        assert.equal(rustCfg.parse(expression), null, expression);
    }
});

test('evaluates OS atoms on linux, macos and windows', () => {
    const cases = [
        ['unix', [true, true, false]],
        ['windows', [false, false, true]],
        ['target_family = "unix"', [true, true, false]],
        ['target_os = "macos"', [false, true, false]],
        ['not(target_os = "linux")', [false, true, true]],
        ['any(target_os = "linux", windows)', [true, false, true]],
        ['all(unix, not(target_os = "macos"))', [true, false, false]],
        ['all()', [true, true, true]],
        ['any()', [false, false, false]],
    ];
    for (const [expression, expected] of cases) assert.deepEqual(holdsOn(expression), expected, expression);
});

test('leaves a predicate that names anything but the OS undecided', () => {
    assert.deepEqual(holdsOn('all(unix, feature = "x")'), [null, null, null]);
    assert.deepEqual(holdsOn('not(debug_assertions)'), [null, null, null]);
    assert.deepEqual(holdsOn('target_env = "gnu"'), [null, null, null]);
});

test('finds which predicates depend on the OS', () => {
    const cases = [
        ['unix', true],
        ['all(debug_assertions, unix)', true],
        ['any(feature = "a", target_os = "linux")', true],
        ['target_env = "gnu"', true],
        ['target_vendor = "apple"', true],
        ['any(unix, windows)', false],
        ['any(target_os = "linux", target_os = "macos", target_os = "windows")', false],
        ['any(unix, not(unix))', false],
        ['all(feature = "x", not(feature = "x"), unix)', false],
        ['target_arch = "x86_64"', false],
        ['debug_assertions', false],
        ['target_os = "android"', false],
    ];
    for (const [expression, expected] of cases) {
        assert.equal(rustCfg.dependsOnOs(rustCfg.parse(expression)), expected, expression);
    }
});

test('reads Cargo target table keys as predicates', () => {
    const cases = [
        ['cfg(unix)', true],
        ["cfg(all(target_os = \"macos\", target_arch = \"aarch64\"))", true],
        ['cfg(any(unix, windows))', false],
        ['x86_64-pc-windows-msvc', true],
        ['aarch64-apple-darwin', true],
        ['x86_64-unknown-linux-gnu', true],
        ['wasm32-unknown-unknown', false],
    ];
    for (const [key, expected] of cases) {
        assert.equal(rustCfg.dependsOnOs(rustCfg.targetTree(key)), expected, key);
    }
    assert.deepEqual(rustCfg.TARGETS.map(target => rustCfg.holds(rustCfg.targetTree('cfg(not(windows))'), target)), [
        true,
        true,
        false,
    ]);
});

test('finds cfg attributes, cfg_attr predicates and cfg! macros with their lines', () => {
    const source = [
        '#![cfg(unix)]',
        '#[cfg(all(',
        '    debug_assertions,',
        '    target_os = "linux"',
        '))]',
        'fn probe() {}',
        '#[cfg_attr(windows, allow(dead_code))]',
        'fn quiet() { if cfg!(target_os = "macos") {} }',
        '#[cfg(test)] mod tests {}',
    ].join('\n');
    const found = rustCfg.predicates(source).map(predicate => ({
        kind: predicate.kind,
        inner: predicate.inner,
        line: predicate.line,
        endLine: predicate.endLine,
        text: predicate.text.replace(/\s+/g, ' '),
    }));
    assert.deepEqual(found, [
        { kind: 'cfg', inner: true, line: 1, endLine: 1, text: 'unix' },
        { kind: 'cfg', inner: false, line: 2, endLine: 5, text: 'all( debug_assertions, target_os = "linux" )' },
        { kind: 'cfg_attr', inner: false, line: 7, endLine: 7, text: 'windows' },
        { kind: 'macro', inner: false, line: 8, endLine: 8, text: 'target_os = "macos"' },
        { kind: 'cfg', inner: false, line: 9, endLine: 9, text: 'test' },
    ]);
});

test('reads predicates from the blanked text and their values from the kept text', () => {
    const kept = 'let s = "#[cfg(unix)]";\n#[cfg(target_os = "linux")]\nfn f() {}\n';
    const blanked = kept.replace('"#[cfg(unix)]"', '"            "').replace('"linux"', '"     "');
    const found = rustCfg.predicates(kept, blanked);
    assert.equal(found.length, 1);
    assert.equal(found[0].line, 2);
    assert.deepEqual(found[0].tree, { key: 'target_os', value: 'linux' });
});

test('names the OS keys of a predicate, by word when it does not parse', () => {
    const [parsed, unparsed, none] = rustCfg.predicates(
        '#[cfg(all(feature = "x", target_family = "unix"))]\n#[cfg($cond, windows)]\n#[cfg(feature = "windows")]\n',
    );
    assert.deepEqual([...rustCfg.namedOsKeys(parsed)], ['target_family']);
    assert.equal(unparsed.tree, null);
    assert.deepEqual([...rustCfg.namedOsKeys(unparsed)], ['windows']);
    assert.deepEqual([...rustCfg.namedOsKeys(none)], []);
});

test('maps offsets to 1-based lines', () => {
    const starts = rustCfg.lineStarts('a\nbc\n\nd');
    assert.deepEqual(starts, [0, 2, 5, 6]);
    assert.deepEqual([0, 1, 2, 4, 5, 6].map(index => rustCfg.lineAt(starts, index)), [1, 1, 2, 2, 3, 4]);
});

test('evaluates with three-valued logic for a caller that knows some atoms', () => {
    const withoutTest = atom => (atom.key === 'test' && atom.value === null ? false : null);
    const cases = [
        ['all(test, feature = "x")', false],
        ['any(test, feature = "x")', null],
        ['any(feature = "x", not(test))', true],
        ['all(not(test), unix)', null],
        ['all()', true],
        ['any()', false],
    ];
    for (const [expression, expected] of cases) {
        assert.equal(rustCfg.kleene(rustCfg.parse(expression), withoutTest), expected, expression);
    }
    assert.deepEqual(rustCfg.parse('feature = "a\\"b"'), { key: 'feature', value: 'a\\"b' });
});

test('a predicate decides the OS when it names an OS key and its value changes with the OS', () => {
    const [nested, everywhere, family, feature, broken] = rustCfg.predicates(
        [
            '#[cfg(all(test, target_os = "linux"))]',
            '#[cfg(all(test, any(target_os = "linux", target_os = "macos", target_os = "windows")))]',
            '#[cfg_attr(unix, allow(dead_code))]',
            '#[cfg(feature = "windows")]',
            '#[cfg($x, unix)]',
        ].join('\n'),
    );
    const targetOs = new Set(['target_os']);
    assert.equal(rustCfg.decidesOs(nested, targetOs), true);
    assert.equal(rustCfg.decidesOs(everywhere, targetOs), false);
    assert.equal(rustCfg.decidesOs(family, targetOs), false);
    assert.equal(rustCfg.decidesOs(family), true);
    assert.equal(rustCfg.decidesOs(feature), false);
    assert.equal(rustCfg.decidesOs(broken), true);
});
