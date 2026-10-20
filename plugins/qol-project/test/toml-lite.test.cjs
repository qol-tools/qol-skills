'use strict';

const test = require('node:test');
const assert = require('node:assert');
const toml = require('../bin/toml-lite.cjs');

test('values of every TOML kind parse to their JavaScript form', () => {
    const { value } = toml.parse([
        'basic = "a\\tb\\u00e9"',
        "literal = 'C:\\path'",
        'multi = """',
        'one \\',
        '   two"""',
        "raw = '''",
        "x\\y'''",
        'int = 1_000',
        'hex = 0xff',
        'big = 9007199254740993',
        'float = -2.5e3',
        'inf = +inf',
        'yes = true',
        'no = false',
        'date = 2026-10-20T08:00:00Z',
        'list = [1, "two", [3], { four = 4 }]',
        'dotted.key = "v"',
        '"quoted key" = 1',
    ].join('\n'));
    assert.deepStrictEqual(value, {
        basic: 'a\tbé',
        literal: 'C:\\path',
        multi: 'one two',
        raw: 'x\\y',
        int: 1000,
        hex: 255,
        big: 9007199254740993n,
        float: -2500,
        inf: Infinity,
        yes: true,
        no: false,
        date: '2026-10-20T08:00:00Z',
        list: [1, 'two', [3], { four: 4 }],
        dotted: { key: 'v' },
        'quoted key': 1,
    });
});

test('tables, sub-tables and arrays of tables nest', () => {
    const { value } = toml.parse([
        '[plugin]',
        'id = "demo"',
        '[action.run]',
        'label = "Run"',
        '[[shortcuts]]',
        'id = "a"',
        '[[shortcuts]]',
        'id = "b"',
        '[shortcuts.extra]',
        'on = true',
    ].join('\n'));
    assert.deepStrictEqual(value, {
        plugin: { id: 'demo' },
        action: { run: { label: 'Run' } },
        shortcuts: [{ id: 'a' }, { id: 'b', extra: { on: true } }],
    });
});

test('key and table lines point at their declarations', () => {
    const { value, lines } = toml.parse([
        '# header',
        '[plugin]',
        'id = "demo"',
        '',
        'name = "Demo"',
        '[[shortcuts]]',
        'id = "a"',
        '[action.run]',
        'label = "Run"',
    ].join('\n'));
    assert.equal(toml.tableLine(lines, value.plugin), 2);
    assert.equal(toml.keyLine(lines, value.plugin, 'name'), 5);
    assert.equal(toml.keyLine(lines, value.plugin, 'missing'), 2);
    assert.equal(toml.tableLine(lines, value.shortcuts[0]), 6);
    assert.equal(toml.keyLine(lines, value.action, 'run'), 8);
    assert.equal(toml.keyLine(lines, value.action.run, 'label'), 9);
    assert.equal(toml.keyLine(lines, {}, 'x'), 0);
});

test('a CRLF file with a byte-order mark parses', () => {
    const { value, lines } = toml.parse('\ufeff[plugin]\r\nid = "demo"\r\nname = "Demo"\r\n');
    assert.deepStrictEqual(value, { plugin: { id: 'demo', name: 'Demo' } });
    assert.equal(toml.keyLine(lines, value.plugin, 'name'), 3);
});

test('invalid documents throw a TomlError with the line', () => {
    const cases = [
        ['a = 1\na = 2', 2, /duplicate key a/],
        ['[x]\n[x]', 2, /duplicate table x/],
        ['a = "open', 1, /unterminated string/],
        ['a = 1 b', 1, /after a value/],
        ['\n\n[menu', 3, /expected \] after a table header/],
        ['a = [1 2]', 1, /expected , or \]/],
        ['a = nope', 1, /invalid value "nope"/],
        ['t = { x = 1 }\n[t.y]', 2, /is not a table/],
    ];
    for (const [text, line, pattern] of cases) {
        assert.throws(() => toml.parse(text), error => {
            assert.ok(error instanceof toml.TomlError, text);
            assert.equal(error.line, line, text);
            assert.match(error.message, pattern);
            assert.match(error.message, new RegExp(`\\(line ${line}\\)$`));
            return true;
        });
    }
});
