'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'skills', 'qol-code-review', 'scripts', 'shallow-wrappers.cjs');
const { addedLinesFromDiff, scanFile } = require(SCRIPT);

const SOURCE = [
    'use qol_color;',
    '',
    'pub fn normalize_color(value: Option<&str>) -> Option<String> {',
    '    qol_color::normalize_hex(value?.trim())',
    '}',
    '',
    'pub fn real_work(value: &str) -> Option<String> {',
    '    let raw = value.trim();',
    '    if raw.is_empty() { return None; }',
    '    Some(raw.to_string())',
    '}',
    '',
    'pub fn macro_body() -> String {',
    '    format!("{}", 1)',
    '}',
    '',
    'impl Display for Thing {',
    '    fn fmt(&self, f: &mut Formatter) -> Result {',
    '        self.inner.fmt(f)',
    '    }',
    '}',
    '',
    'pub use runtime_gpui::normalize_color as normalize_ghost_debug_color;',
    '',
    '#[cfg(test)]',
    'mod tests {',
    '    fn helper() -> u32 {',
    '        compute(1)',
    '    }',
    '}',
    '',
];

function writeFixture() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cr-shallow-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'lib.rs'), SOURCE.join('\n'));
    return dir;
}

function run(args) {
    const result = spawnSync('node', [SCRIPT, ...args], { encoding: 'utf8' });
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

test('whole-file scan reports the one-call wrapper, the trait delegation and the renamed re-export, not real bodies, macros or tests', () => {
    const found = scanFile('src/lib.rs', SOURCE, { includeTests: false }, null);
    assert.deepStrictEqual(found.wrappers.map((w) => [w.name, w.callee, w.trait_impl]), [
        ['normalize_color', 'qol_color::normalize_hex', false],
        ['fmt', 'self.inner.fmt', true],
    ]);
    assert.deepStrictEqual(found.reexports.map((r) => r.alias), ['normalize_ghost_debug_color']);
});

test('diff mode reports only functions touched by added lines', () => {
    const diff = [
        'diff --git a/src/lib.rs b/src/lib.rs',
        '--- a/src/lib.rs',
        '+++ b/src/lib.rs',
        '@@ -3,3 +3,3 @@',
        ' pub fn normalize_color(value: Option<&str>) -> Option<String> {',
        '-    let raw = value?.trim();',
        '+    qol_color::normalize_hex(value?.trim())',
        ' }',
    ].join('\n');
    const added = addedLinesFromDiff(diff);
    assert.deepStrictEqual([...added.get('src/lib.rs')], [4]);
    const found = scanFile('src/lib.rs', SOURCE, { includeTests: false }, added.get('src/lib.rs'));
    assert.deepStrictEqual(found.wrappers.map((w) => w.name), ['normalize_color']);
    assert.deepStrictEqual(found.reexports, []);
});

test('cli prints one line per entry, writes the json report, and --strict exits 1', () => {
    const dir = writeFixture();
    const json = path.join(dir, 'out', 'shallow.json');
    const result = run(['--root', dir, '--files', 'src/lib.rs', '--json', json, '--strict']);
    assert.strictEqual(result.exitCode, 1, result.stderr);
    assert.match(result.stdout, /src\/lib\.rs:3  fn normalize_color -> qol_color::normalize_hex/);
    assert.match(result.stdout, /shallow-wrappers: 3 entries in 1 scanned file/);
    const report = JSON.parse(fs.readFileSync(json, 'utf8'));
    assert.strictEqual(report.count, 3);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('cli refuses to run without a scope', () => {
    const result = run([]);
    assert.strictEqual(result.exitCode, 2);
    assert.match(result.stderr, /--diff|--files/);
});
