'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'check-qol-arch-code.cjs');
const { lintFile } = require(HOOK);
const { newViolations, formatViolations } = require('../bin/qol-enum-match-guard.cjs');

const KIND = 'pub enum Kind {\n    Alpha,\n    Beta(u8),\n    Gamma { level: u8 },\n}\n';

function workspace(files = { 'libs/kinds/src/lib.rs': KIND }) {
    const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qac-enum-')), 'qol-monorepo');
    fs.mkdirSync(root, { recursive: true });
    spawnSync('git', ['init', '-q'], { cwd: root });
    for (const [relative, content] of Object.entries(files)) {
        const file = path.join(root, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
    return root;
}

const ROOT = workspace({
    'libs/kinds/src/lib.rs': KIND,
    'libs/kinds/src/sealed.rs': '#[non_exhaustive]\npub enum Sealed {\n    Open,\n    Shut,\n}\n',
    'libs/kinds/src/ordering.rs': 'pub enum Ordering {\n    First,\n    Last,\n}\n',
    'vendor/other/src/lib.rs': 'pub enum Vendored {\n    One,\n    Two,\n}\n',
});
const FILE = path.join(ROOT, 'plugins/demo/src/lib.rs');

const found = (content, baseline = null, file = FILE) => newViolations(file, baseline, content)
    .map(violation => `${violation.line}: ${violation.hidden.map(variant => `${violation.enumName}::${variant}`).join(', ')}`);

const LABEL = (arms = '        Kind::Alpha => "alpha",\n        _ => "other",\n') =>
    `pub fn label(kind: &Kind) -> &'static str {\n    match kind {\n${arms}    }\n}\n`;

test('a new wildcard over a workspace enum names the variants it stands for', () => {
    assert.deepEqual(found(LABEL()), ['4: Kind::Beta, Kind::Gamma']);
});

test('variants read through a path, a reference, a binding or an alternative all count as named', () => {
    const arms = '        &crate::kinds::Kind::Alpha | Kind::Beta(_) => "early",\n        _ => "late",\n';
    assert.deepEqual(found(LABEL(arms)), ['4: Kind::Gamma']);
    const bound = '        named @ Kind::Gamma { .. } => "gamma",\n        _ => "other",\n';
    assert.deepEqual(found(LABEL(bound)), ['4: Kind::Alpha, Kind::Beta']);
});

const allowed = [
    ['Option', 'fn f(v: Option<Kind>) -> u8 {\n    match v {\n        Some(Kind::Alpha) => 1,\n        _ => 0,\n    }\n}\n'],
    ['string', 'fn f(s: &str) -> u8 {\n    match s {\n        "alpha" => 1,\n        _ => 0,\n    }\n}\n'],
    ['number', 'fn f(n: u8) -> u8 {\n    match n {\n        1 => 1,\n        _ => 0,\n    }\n}\n'],
    ['tuple', 'fn f(a: Kind, b: Kind) -> u8 {\n    match (a, b) {\n        (Kind::Alpha, Kind::Alpha) => 1,\n        _ => 0,\n    }\n}\n'],
    ['guarded wildcard', 'fn f(k: Kind, x: bool) -> u8 {\n    match k {\n        Kind::Alpha => 1,\n        _ if x => 2,\n        Kind::Beta(_) | Kind::Gamma { .. } => 0,\n    }\n}\n'],
    ['binding catch-all', 'fn f(k: Kind) -> Kind {\n    match k {\n        Kind::Alpha => Kind::Alpha,\n        other => other,\n    }\n}\n'],
    ['every variant named', 'fn f(k: Kind) -> u8 {\n    match k {\n        Kind::Alpha => 1,\n        Kind::Beta(_) => 2,\n        Kind::Gamma { .. } => 3,\n    }\n}\n'],
    ['enum outside the workspace', 'fn f(k: std::io::ErrorKind) -> u8 {\n    match k {\n        ErrorKind::NotFound => 1,\n        _ => 0,\n    }\n}\n'],
    ['outside enum named like a workspace one', 'fn f(o: std::cmp::Ordering) -> u8 {\n    match o {\n        Ordering::Less => 1,\n        _ => 0,\n    }\n}\n'],
    ['non_exhaustive enum', 'fn f(s: Sealed) -> u8 {\n    match s {\n        Sealed::Open => 1,\n        _ => 0,\n    }\n}\n'],
    ['enum under vendor/', 'fn f(v: Vendored) -> u8 {\n    match v {\n        Vendored::One => 1,\n        _ => 0,\n    }\n}\n'],
    ['test code', '#[cfg(test)]\nmod tests {\n    fn f(k: Kind) -> u8 {\n        match k {\n            Kind::Alpha => 1,\n            _ => 0,\n        }\n    }\n}\n'],
    ['matches! macro', 'fn f(k: &Kind) -> bool {\n    matches!(k, Kind::Alpha | Kind::Beta(_))\n}\n'],
];

for (const [name, content] of allowed) {
    test(`allowed: ${name}`, () => {
        assert.deepEqual(found(content), []);
    });
}

test('a test file is not judged', () => {
    assert.deepEqual(found(LABEL(), null, path.join(ROOT, 'plugins/demo/tests/labels.rs')), []);
});

test('Self resolves to the type of the enclosing impl block', () => {
    const content = 'impl Kind {\n    pub fn early(&self) -> bool {\n        match self {\n            Self::Alpha => true,\n            _ => false,\n        }\n    }\n}\n';
    assert.deepEqual(found(content), ['5: Kind::Beta, Kind::Gamma']);
    const traitImpl = "impl<'a> PartialEq<&'a Kind> for Kind {\n    fn eq(&self, other: &&'a Kind) -> bool {\n        match self {\n            Self::Alpha => matches!(other, Kind::Alpha),\n            _ => false,\n        }\n    }\n}\n";
    assert.deepEqual(found(traitImpl), ['5: Kind::Beta, Kind::Gamma']);
    const returned = 'impl Ordering {\n    fn kinds(&self) -> impl Iterator<Item = u8> {\n        match self {\n            Self::First => 1,\n            _ => 2,\n        };\n        std::iter::empty()\n    }\n}\n';
    assert.deepEqual(found(returned), ['5: Ordering::Last']);
});

test('an enum the edit declares itself is read from the edit', () => {
    const content = 'enum Local {\n    One,\n    Two,\n}\n\nfn f(l: Local) -> u8 {\n    match l {\n        Local::One => 1,\n        _ => 0,\n    }\n}\n';
    assert.deepEqual(found(content), ['9: Local::Two']);
});

test('arms whose block expressions end without a comma still split', () => {
    const arms = [
        '        Kind::Alpha => if true { "a" } else { "b" }',
        '        Kind::Beta(level) => match level {',
        '            0 => "zero",',
        '            _ => "some",',
        '        }',
        '        _ => { "other" }',
        '',
    ].join('\n');
    assert.deepEqual(found(LABEL(arms)), ['8: Kind::Gamma']);
    const turbofish = '        Kind::Alpha => std::collections::HashMap::<u8, u8>::new().len().to_string().leak(),\n        Kind::Beta(_) => "beta",\n        _ => "other",\n';
    assert.deepEqual(found(LABEL(turbofish)), ['5: Kind::Gamma']);
});

test('only wildcards the edit adds are judged', () => {
    const before = LABEL();
    assert.deepEqual(found(before, before), []);
    const moreArms = LABEL('        Kind::Alpha => "alpha",\n        Kind::Beta(_) => "beta",\n        _ => "other",\n');
    assert.deepEqual(found(moreArms, before), []);
    const second = `${before}\npub fn short(kind: &Kind) -> &'static str {\n    match kind {\n        Kind::Gamma { .. } => "g",\n        _ => "-",\n    }\n}\n`;
    assert.deepEqual(found(second, before), ['11: Kind::Alpha, Kind::Beta']);
    const above = `pub fn short(kind: &Kind) -> &'static str {\n    match kind {\n        Kind::Gamma { .. } => "g",\n        _ => "-",\n    }\n}\n\n${before}`;
    assert.deepEqual(found(above, before), ['4: Kind::Alpha, Kind::Beta']);
});

test('the message lists at most six variants', () => {
    const many = Array.from({ length: 9 }, (_, index) => `V${index}`);
    const text = formatViolations([{ line: 3, enumName: 'Wide', hidden: many }]);
    assert.equal(text, '  line 3: `_ =>` stands for Wide::V0, Wide::V1, Wide::V2, Wide::V3, Wide::V4, Wide::V5, and 3 more');
});

test('hook: an Edit that adds a wildcard is blocked, and lint judges it against the base', () => {
    const root = workspace();
    const file = path.join(root, 'libs/demo/src/lib.rs');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const exhaustive = LABEL('        Kind::Alpha => "alpha",\n        Kind::Beta(_) | Kind::Gamma { .. } => "other",\n');
    fs.writeFileSync(file, exhaustive);
    const result = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({
            tool_name: 'Edit',
            cwd: path.dirname(file),
            tool_input: { file_path: file, old_string: 'Kind::Beta(_) | Kind::Gamma { .. } =>', new_string: '_ =>' },
        }),
        encoding: 'utf8',
    });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /enum match violation/);
    assert.match(result.stderr, /line 4: `_ =>` stands for Kind::Beta, Kind::Gamma/);
    assert.match(result.stderr, /"Enforcement: enum match guard"/);

    assert.equal(lintFile(file, LABEL(), exhaustive).length, 1);
    assert.deepEqual(lintFile(file, LABEL(), LABEL()), []);
});
