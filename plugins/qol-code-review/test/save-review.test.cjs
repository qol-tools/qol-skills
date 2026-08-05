'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'skills', 'qol-code-review', 'scripts', 'save-review.cjs');
const { sanitizeSlug, buildRunId, assertSafeSegment, parseArgs } = require(SCRIPT);

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cr-save-test-'));
}

function run(args, input) {
    const result = spawnSync('node', [SCRIPT, ...args], {
        input: input === undefined ? '' : input,
        encoding: 'utf8',
    });
    return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr };
}

function reviewPathFrom(stdout) {
    const line = stdout.split('\n').find((entry) => entry.trim().startsWith('review:'));
    return line ? line.replace(/^\s*review:\s*/, '').trim() : null;
}

test('sanitizeSlug normalizes to kebab and clamps length', () => {
    const cases = [
        ['Emu Paths!!', 'emu-paths'],
        ['  ___  ', 'review'],
        ['', 'review'],
        ['a'.repeat(80), 'a'.repeat(48)],
    ];
    for (const [input, expected] of cases) {
        assert.strictEqual(sanitizeSlug(input), expected, `input: ${JSON.stringify(input)}`);
    }
});

test('buildRunId embeds a UTC stamp, slug, and suffix', () => {
    const now = new Date(Date.UTC(2026, 5, 15, 9, 8, 7));
    assert.strictEqual(buildRunId('Emu Paths', now, 'ab12'), '20260615-090807-emu-paths-ab12');
});

test('assertSafeSegment rejects traversal and separators', () => {
    for (const bad of ['../x', 'a/b', 'a\\b', '..']) {
        assert.throws(() => assertSafeSegment(bad, '--run-id'), /must not contain/, `bad: ${bad}`);
    }
    assert.doesNotThrow(() => assertSafeSegment('safe-run-1', '--run-id'));
});

test('parseArgs reads modifiers and rejects unknown flags', () => {
    const options = parseArgs(['--verdict', 'BLOCK', '--slug', 'X', '--in', '/tmp/r.md']);
    assert.strictEqual(options.verdict, 'block');
    assert.strictEqual(options.slug, 'X');
    assert.strictEqual(options.in, '/tmp/r.md');
    assert.throws(() => parseArgs(['--nope']), /Unknown argument/);
    assert.throws(() => parseArgs(['--slug']), /requires a value/);
});

test('writes review.md and report.json into the temp run dir from --in', () => {
    const out = tempDir();
    const src = path.join(out, 'src-review.md');
    fs.writeFileSync(src, '# Review\n\nVerdict: conditional\n');

    const { exitCode, stdout } = run(['--verdict', 'conditional', '--slug', 'emu-paths', '--in', src, '--out-dir', out]);
    assert.strictEqual(exitCode, 0, stdout);

    const reviewPath = reviewPathFrom(stdout);
    assert.ok(reviewPath, 'stdout should print the review path');
    assert.ok(reviewPath.startsWith(out), 'review path should live under --out-dir');
    assert.match(reviewPath, /[/\\]20\d{6}-\d{6}-emu-paths-[0-9a-f]{4}[/\\]review\.md$/);
    assert.strictEqual(fs.readFileSync(reviewPath, 'utf8'), '# Review\n\nVerdict: conditional\n');

    const reportPath = path.join(path.dirname(reviewPath), 'report.json');
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    assert.strictEqual(report.name, 'code-review');
    assert.strictEqual(report.status, 'conditional');
    assert.strictEqual(report.artifacts.review, reviewPath);
    assert.strictEqual(report.inputs.slug, 'emu-paths');
});

test('reads review markdown from stdin when --in is absent', () => {
    const out = tempDir();
    const { exitCode, stdout } = run(['--verdict', 'pass', '--slug', 'piped', '--out-dir', out], 'piped body\n');
    assert.strictEqual(exitCode, 0, stdout);

    const reviewPath = reviewPathFrom(stdout);
    assert.strictEqual(fs.readFileSync(reviewPath, 'utf8'), 'piped body\n');
    const report = JSON.parse(fs.readFileSync(path.join(path.dirname(reviewPath), 'report.json'), 'utf8'));
    assert.strictEqual(report.inputs.source, 'stdin');
});

test('persists the machine-parseable block as summary.json when --json is given', () => {
    const out = tempDir();
    const src = path.join(out, 'r.md');
    const jsonPath = path.join(out, 'summary-src.json');
    fs.writeFileSync(src, 'body\n');
    fs.writeFileSync(jsonPath, JSON.stringify({ verdict: 'block', counts: { blocker: 1 } }));

    const { exitCode, stdout } = run(['--verdict', 'block', '--slug', 's', '--in', src, '--json', jsonPath, '--out-dir', out]);
    assert.strictEqual(exitCode, 0, stdout);

    const summaryPath = path.join(path.dirname(reviewPathFrom(stdout)), 'summary.json');
    assert.deepStrictEqual(JSON.parse(fs.readFileSync(summaryPath, 'utf8')), { verdict: 'block', counts: { blocker: 1 } });
});

test('fails early on empty review content', () => {
    const out = tempDir();
    const src = path.join(out, 'empty.md');
    fs.writeFileSync(src, '   \n');
    const { exitCode, stderr } = run(['--slug', 's', '--in', src, '--out-dir', out]);
    assert.strictEqual(exitCode, 1);
    assert.match(stderr, /empty/);
});
