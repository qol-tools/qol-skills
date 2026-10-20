'use strict';

const test = require('node:test');
const assert = require('node:assert');
const rust = require('../bin/rust-serde.cjs');

const SCHEMA = `use serde::Deserialize;

#[derive(Deserialize)]
#[serde(rename_all = "kebab-case")]
pub struct Root {
    pub display_name: String,
    #[serde(rename = "type", alias = "kind")]
    pub flavour: Flavour,
    #[serde(default)]
    pub count: Option<u32>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(flatten)]
    pub nested: Nested,
    #[serde(default)]
    pub items: Vec<Item>,
    #[serde(skip)]
    pub cache: Cache,
    #[serde(default)]
    pub ratio: f64,
}

#[derive(Deserialize)]
pub struct Nested {
    #[serde(default)]
    pub depth: u8,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum Flavour {
    #[default]
    Plain,
    ExtraHot,
    #[serde(other)]
    Unknown,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Item {
    Action { id: String },
    Separator,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Strict {
    pub id: String,
}

pub type Alias = Strict;

#[cfg(test)]
mod tests {
    #[derive(serde::Deserialize)]
    pub struct OnlyInTests {
        pub id: String,
    }
}
`;

function schema(content = SCHEMA) {
    return rust.serdeSchema([{ file: 'libs/demo/src/lib.rs', content }]);
}

function check(root, value, content) {
    return rust.checkDocument(schema(content), root, value);
}

test('the lexer collects decoded strings and blanks comments and literals out of the skeleton', () => {
    const src = 'let a = "x\\ny"; // "comment"\nlet b = r#"raw "quoted""#; /* "block" */ let c = \'"\'; let d: &\'static str = b"bytes";';
    const lexed = rust.lexRust(src);
    assert.deepStrictEqual(lexed.strings.map(string => string.value), ['x\ny', 'raw "quoted"', 'bytes']);
    assert.equal(lexed.skeleton.length, src.length);
    assert.ok(!lexed.skeleton.includes('comment'));
    assert.ok(!lexed.skeleton.includes('raw'));
    assert.ok(lexed.clean.includes('"x\\ny"'));
    assert.ok(!lexed.clean.includes('block'));
    assert.ok(lexed.skeleton.includes("&'static str"));
});

test('production code drops cfg(test) items and whole test files', () => {
    const lexed = rust.production('plugins/demo/src/lib.rs', 'fn live() { "kept"; }\n#[cfg(test)]\nmod tests { fn t() { "dropped"; } }\n');
    assert.deepStrictEqual(lexed.strings.map(string => string.value), ['kept']);
    assert.ok(!lexed.skeleton.includes('fn t'));
    assert.equal(rust.production('plugins/demo/src/tests.rs', 'fn t() {}'), null);
    assert.equal(rust.production('plugins/demo/tests/flow.rs', 'fn t() {}'), null);
    assert.ok(rust.TEST_FILE.test('plugins/demo/src/config_tests.rs'));
    assert.ok(!rust.TEST_FILE.test('plugins/demo/src/contest.rs'));
});

test('types parse into names, arguments, sequences and tuples', () => {
    assert.deepStrictEqual(rust.parseType("Option<Vec<&'a str>>"), { name: 'Option', args: [{ name: 'Vec', args: [{ name: 'str', args: [] }] }] });
    assert.deepStrictEqual(rust.parseType('std::collections::HashMap<String, toml::Value>'), { name: 'HashMap', args: [{ name: 'String', args: [] }, { name: 'Value', args: [] }] });
    assert.deepStrictEqual(rust.parseType('[u8; 4]'), { seq: { name: 'u8', args: [] } });
    assert.deepStrictEqual(rust.parseType('(u8, bool)'), { tuple: [{ name: 'u8', args: [] }, { name: 'bool', args: [] }] });
    assert.deepStrictEqual(rust.parseType('Box<dyn Fn(u8) -> u8>'), { name: 'Box', args: [{ any: true }] });
});

test('items record serde attributes, and test-only items are left out', () => {
    const { types } = schema();
    const root = types.get('Root')[0];
    assert.equal(root.renameAll, 'kebab-case');
    const flavour = root.fields.find(field => field.rust === 'flavour');
    assert.equal(flavour.rename, 'type');
    assert.deepStrictEqual(flavour.aliases, ['kind']);
    assert.ok(root.fields.find(field => field.rust === 'nested').flatten);
    assert.ok(root.fields.find(field => field.rust === 'cache').skip);
    assert.ok(types.get('Strict')[0].denyUnknown);
    assert.equal(types.get('Item')[0].tag, 'type');
    assert.equal(types.get('Alias')[0].kind, 'alias');
    assert.ok(!types.has('OnlyInTests'));
    assert.deepStrictEqual(JSON.parse(JSON.stringify(rust.fileItems('a/src/lib.rs', rust.lexRust(SCHEMA)))).defs.length, 7);
});

test('variant wire names follow rename_all', () => {
    const flavour = schema().types.get('Flavour')[0];
    assert.deepStrictEqual(flavour.variants.map(variant => rust.variantWire(variant, flavour.renameAll)), ['plain', 'extra_hot', 'unknown']);
});

test('a matching document has no problems and lists every key it used', () => {
    const result = check('Root', { 'display-name': 'x', type: 'extra_hot', count: 3, tags: ['a'], depth: 2, items: [{ type: 'action', id: 'run' }, { type: 'separator' }], ratio: 1 });
    assert.deepStrictEqual(result.problems, []);
    assert.deepStrictEqual(result.used.map(entry => entry.path).sort(), ['count', 'depth', 'display-name', 'items', 'items[0].id', 'ratio', 'tags', 'type'].sort());
    assert.deepStrictEqual(check('Root', { 'display-name': 'x', kind: 'mild' }).problems, []);
});

test('unknown, missing, mistyped and misnamed values are reported', () => {
    const problems = check('Root', { display_name: 'x', type: 3, count: 'many', tags: 'a', items: [{ type: 'divider' }], ratio: 7n }).problems;
    const summary = problems.map(problem => [problem.kind, problem.missing ?? problem.path, problem.expected ?? problem.actual ?? null]);
    assert.deepStrictEqual(summary, [
        ['unknown', 'display_name', null],
        ['type', 'type', 'one of plain, extra_hot, unknown'],
        ['type', 'count', 'an integer'],
        ['type', 'tags', 'an array'],
        ['variant', 'items[0].type', 'divider'],
        ['missing', 'display-name', null],
    ]);
    const strict = check('Alias', { id: 'a', extra: 1 }).problems;
    assert.equal(strict.length, 1);
    assert.equal(strict[0].strict, true);
    assert.equal(check('Missing', {}), null);
});

test('a flattened map swallows unknown keys instead of rejecting them', () => {
    const content = `#[derive(serde::Deserialize)]\npub struct Open {\n    pub id: String,\n    #[serde(flatten)]\n    pub extras: std::collections::HashMap<String, toml::Value>,\n}\n`;
    const result = check('Open', { id: 'a', anything: 1 }, content);
    assert.deepStrictEqual(result.problems, []);
    const swallowed = result.used.find(entry => entry.key === 'anything');
    assert.equal(swallowed.swallowed, true);
    assert.equal(swallowed.field.rust, 'extras');
});

test('a hand-written Deserialize impl makes the type opaque', () => {
    const content = `${SCHEMA}\nimpl<'de> Deserialize<'de> for Strict {\n    fn deserialize<D>(d: D) -> Result<Self, D::Error> { todo!() }\n}\n`;
    assert.equal(check('Strict', { anything: 1 }, content), null);
    assert.deepStrictEqual(check('Root', { 'display-name': 'x', type: 'plain', items: [], cache: 1 }, content).problems.map(problem => problem.path), ['cache']);
});

test('field reads cover access, comparison and destructuring but not calls or paths', () => {
    const reads = rust.fieldReads([{ file: 'plugins/demo/src/lib.rs', content: [
        'fn f(c: &Config) {',
        '    let a = c.general.enabled;',
        '    if c.mode != Mode::Off {}',
        '    let Config { display_name, ref nested, .. } = c;',
        '    c.method();',
        '    c.mac!();',
        '    Mode::variant;',
        '}',
        '#[cfg(test)]',
        'mod tests { fn t(c: &Config) { c.only_tests; } }',
    ].join('\n') }]);
    for (const name of ['general', 'enabled', 'mode', 'display_name', 'nested']) assert.ok(reads.has(name), name);
    for (const name of ['method', 'mac', 'variant', 'only_tests']) assert.ok(!reads.has(name), name);
});
