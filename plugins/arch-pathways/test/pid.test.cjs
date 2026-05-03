'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const pid = require('../lib/pid.cjs');

test('parsePid accepts canonical form', () => {
    const cases = [
        ['TRAY-42', { prefix: 'TRAY', number: 42 }],
        ['LIGHTS-1', { prefix: 'LIGHTS', number: 1 }],
        ['ALTTAB-9999', { prefix: 'ALTTAB', number: 9999 }],
        ['A-1', { prefix: 'A', number: 1 }],
    ];
    for (const [input, expected] of cases) {
        assert.deepStrictEqual(pid.parsePid(input), expected, `input: ${input}`);
    }
});

test('parsePid rejects malformed input', () => {
    const cases = [
        'tray-42',
        'TRAY 42',
        'TRAY-',
        '-42',
        '42',
        'TRAY-42-foo',
        'tray42',
        'TRAY-0a',
        '',
        '1TRAY-42',
        'TRAY--42',
    ];
    for (const input of cases) {
        assert.strictEqual(pid.parsePid(input), null, `input: ${JSON.stringify(input)}`);
    }
});

test('formatPid composes valid PIDs and rejects bad input', () => {
    assert.strictEqual(pid.formatPid('TRAY', 42), 'TRAY-42');
    assert.strictEqual(pid.formatPid('LIGHTS', 1), 'LIGHTS-1');
    assert.throws(() => pid.formatPid('tray', 42), /invalid prefix/);
    assert.throws(() => pid.formatPid('1TRAY', 42), /invalid prefix/);
    assert.throws(() => pid.formatPid('TRAY', 0), /invalid issue number/);
    assert.throws(() => pid.formatPid('TRAY', -1), /invalid issue number/);
    assert.throws(() => pid.formatPid('TRAY', 1.5), /invalid issue number/);
    assert.throws(() => pid.formatPid('TRAY', '42'), /invalid issue number/);
});

test('parsePid and formatPid round-trip', () => {
    const cases = ['TRAY-42', 'LIGHTS-1', 'ALTTAB-9999'];
    for (const input of cases) {
        const parsed = pid.parsePid(input);
        assert.strictEqual(pid.formatPid(parsed.prefix, parsed.number), input, `input: ${input}`);
    }
});

test('parseBranchName accepts lowercase prefix-N-slug', () => {
    const cases = [
        ['tray-42-fold-installs', { prefix: 'TRAY', number: 42, slug: 'fold-installs' }],
        ['lights-1-add-zigbee-adapter', { prefix: 'LIGHTS', number: 1, slug: 'add-zigbee-adapter' }],
        ['alttab-7-fix-x11-preview', { prefix: 'ALTTAB', number: 7, slug: 'fix-x11-preview' }],
        ['a-1-x', { prefix: 'A', number: 1, slug: 'x' }],
    ];
    for (const [input, expected] of cases) {
        assert.deepStrictEqual(pid.parseBranchName(input), expected, `input: ${input}`);
    }
});

test('parseBranchName rejects malformed branches', () => {
    const cases = [
        'TRAY-42-fold-installs',
        'tray-42-Fold-Installs',
        'tray-42-',
        'tray-42',
        'tray--42-foo',
        '-tray-42-foo',
        'tray-42-foo--bar',
        'tray-42-foo-',
        '',
        '42-foo',
        'tray-foo',
    ];
    for (const input of cases) {
        assert.strictEqual(pid.parseBranchName(input), null, `input: ${JSON.stringify(input)}`);
    }
});

test('formatBranchName composes lowercase kebab branch', () => {
    assert.strictEqual(pid.formatBranchName('TRAY', 42, 'fold-installs'), 'tray-42-fold-installs');
    assert.strictEqual(pid.formatBranchName('LIGHTS', 1, 'add-zigbee-adapter'), 'lights-1-add-zigbee-adapter');
    assert.throws(() => pid.formatBranchName('TRAY', 42, 'Fold-Installs'), /invalid slug/);
    assert.throws(() => pid.formatBranchName('TRAY', 42, '-foo'), /invalid slug/);
    assert.throws(() => pid.formatBranchName('TRAY', 42, 'foo-'), /invalid slug/);
    assert.throws(() => pid.formatBranchName('TRAY', 42, 'foo--bar'), /invalid slug/);
    assert.throws(() => pid.formatBranchName('TRAY', 42, ''), /invalid slug/);
    assert.throws(() => pid.formatBranchName('tray', 42, 'foo'), /invalid prefix/);
});

test('branch and PID round-trip via branchFromPid + pidFromBranch', () => {
    const cases = [
        ['TRAY-42', 'fold-installs'],
        ['LIGHTS-1', 'add-zigbee-adapter'],
        ['ALTTAB-9999', 'x'],
    ];
    for (const [pidStr, slug] of cases) {
        const branch = pid.branchFromPid(pidStr, slug);
        assert.strictEqual(pid.pidFromBranch(branch), pidStr, `pid: ${pidStr}, slug: ${slug}`);
    }
});

test('parsePrTitle extracts pid + title', () => {
    const cases = [
        [
            'TRAY-42 Fold Installs Into Config Dir',
            { pid: 'TRAY-42', prefix: 'TRAY', number: 42, title: 'Fold Installs Into Config Dir' },
        ],
        [
            'LIGHTS-1 Add Zigbee Adapter',
            { pid: 'LIGHTS-1', prefix: 'LIGHTS', number: 1, title: 'Add Zigbee Adapter' },
        ],
    ];
    for (const [input, expected] of cases) {
        assert.deepStrictEqual(pid.parsePrTitle(input), expected, `input: ${input}`);
    }
});

test('parsePrTitle rejects malformed PR titles', () => {
    const cases = [
        'tray-42 Fold Installs',
        'TRAY-42-Fold-Installs',
        'TRAY-42  ',
        'Fold Installs Into Config',
        '',
        'TRAY 42 Fold',
    ];
    for (const input of cases) {
        assert.strictEqual(pid.parsePrTitle(input), null, `input: ${JSON.stringify(input)}`);
    }
});

test('formatPrTitle composes title', () => {
    assert.strictEqual(
        pid.formatPrTitle('TRAY', 42, 'Fold Installs Into Config Dir'),
        'TRAY-42 Fold Installs Into Config Dir',
    );
    assert.strictEqual(
        pid.formatPrTitle('TRAY', 42, '  Fold  '),
        'TRAY-42 Fold',
    );
    assert.throws(() => pid.formatPrTitle('TRAY', 42, ''), /empty/);
    assert.throws(() => pid.formatPrTitle('TRAY', 42, '   '), /empty/);
});

test('slugify normalizes titles to kebab case', () => {
    const cases = [
        ['Fold Installs Into Config Dir', 'fold-installs-into-config-dir'],
        ['  Many   Spaces  ', 'many-spaces'],
        ['Café déjà vu', 'cafe-deja-vu'],
        ['Foo Bar! Baz?', 'foo-bar-baz'],
        ['One', 'one'],
        ['Mixed-CASE_Stuff', 'mixed-case-stuff'],
        ['Trailing punct!!!', 'trailing-punct'],
        ['Issue #42 Reopened', 'issue-42-reopened'],
        ['UTF-8 Symbols © 2026', 'utf-8-symbols-2026'],
    ];
    for (const [input, expected] of cases) {
        assert.strictEqual(pid.slugify(input), expected, `input: ${JSON.stringify(input)}`);
    }
});

test('slugify caps slug length and trims trailing dashes', () => {
    const long = 'word '.repeat(40).trim();
    const slug = pid.slugify(long);
    assert.ok(slug.length <= pid.SLUG_MAX, `slug "${slug}" exceeds cap ${pid.SLUG_MAX}`);
    assert.ok(!/-$/.test(slug), `slug "${slug}" ends with dash`);
});

test('slugify throws on input that produces empty slug', () => {
    const cases = ['', '   ', '!!!', '---'];
    for (const input of cases) {
        assert.throws(() => pid.slugify(input), /empty slug|empty/, `input: ${JSON.stringify(input)}`);
    }
});

test('isValidSlug accepts kebab and rejects everything else', () => {
    const valid = ['foo', 'foo-bar', 'foo-bar-baz', 'a1-b2', 'x'];
    const invalid = ['Foo', 'foo_bar', '-foo', 'foo-', 'foo--bar', '', 'foo bar'];
    for (const s of valid) {
        assert.strictEqual(pid.isValidSlug(s), true, `expected valid: ${JSON.stringify(s)}`);
    }
    for (const s of invalid) {
        assert.strictEqual(pid.isValidSlug(s), false, `expected invalid: ${JSON.stringify(s)}`);
    }
});

test('titleCaseFromSlug capitalizes words and lowercases minor words mid-title', () => {
    const cases = [
        ['fold-installs-into-config-dir', 'Fold Installs Into Config Dir'],
        ['add-zigbee-adapter', 'Add Zigbee Adapter'],
        ['fix-x11-preview', 'Fix X11 Preview'],
        ['the-quick-brown-fox', 'The Quick Brown Fox'],
        ['one', 'One'],
        ['a-tale-of-two-things', 'A Tale of Two Things'],
        ['walk-the-line', 'Walk the Line'],
        ['end-with-the', 'End With The'],
    ];
    for (const [input, expected] of cases) {
        assert.strictEqual(pid.titleCaseFromSlug(input), expected, `input: ${input}`);
    }
});

test('titleCaseFromSlug throws on invalid slug', () => {
    assert.throws(() => pid.titleCaseFromSlug('Foo-Bar'), /invalid slug/);
    assert.throws(() => pid.titleCaseFromSlug(''), /invalid slug/);
});

test('prefixForRepo returns the configured prefix for known repos', () => {
    const cases = [
        ['qol-tray', 'TRAY'],
        ['plugin-lights', 'LIGHTS'],
        ['plugin-alt-tab', 'ALTTAB'],
        ['plugin-launcher', 'LAUNCHER'],
        ['qol-plugin-api', 'API'],
    ];
    for (const [repo, expected] of cases) {
        assert.strictEqual(pid.prefixForRepo(repo), expected, `repo: ${repo}`);
    }
});

test('prefixForRepo throws on unknown repo', () => {
    assert.throws(() => pid.prefixForRepo('does-not-exist'), /unknown repo/);
});

test('repoForPrefix is the inverse of prefixForRepo for all entries', () => {
    const { repoToPrefix } = pid.loadPrefixes();
    for (const [repo, prefix] of Object.entries(repoToPrefix)) {
        assert.strictEqual(pid.repoForPrefix(prefix), repo, `prefix: ${prefix}`);
    }
});

test('repoForPrefix throws on unknown prefix', () => {
    assert.throws(() => pid.repoForPrefix('NOTAPREFIX'), /unknown prefix/);
});

test('loadPrefixes returns both forward and reverse maps with no duplicates', () => {
    const { repoToPrefix, prefixToRepo } = pid.loadPrefixes();
    assert.strictEqual(
        Object.keys(repoToPrefix).length,
        Object.keys(prefixToRepo).length,
        'forward and reverse maps must have same size (no duplicate prefixes)',
    );
    for (const [repo, prefix] of Object.entries(repoToPrefix)) {
        assert.strictEqual(prefixToRepo[prefix], repo, `prefix ${prefix} should map back to repo ${repo}`);
    }
});

test('adrPath composes docs/adr/<PID>-<slug>.md', () => {
    assert.strictEqual(
        pid.adrPath('/repo/qol-tray', 'TRAY-42', 'fold-installs'),
        path.join('/repo/qol-tray', 'docs', 'adr', 'TRAY-42-fold-installs.md'),
    );
    assert.throws(() => pid.adrPath('/repo', 'tray-42', 'foo'), /invalid pid/);
    assert.throws(() => pid.adrPath('/repo', 'TRAY-42', 'Foo'), /invalid slug/);
});

test('worktreePath composes <workspace>/worktrees/<repo>/<branch>', () => {
    assert.strictEqual(
        pid.worktreePath('/ws', 'qol-tray', 'tray-42-fold-installs'),
        path.join('/ws', 'worktrees', 'qol-tray', 'tray-42-fold-installs'),
    );
    assert.throws(() => pid.worktreePath('/ws', 'unknown-repo', 'foo-1-bar'), /unknown repo/);
    assert.throws(() => pid.worktreePath('/ws', 'qol-tray', 'TRAY-42-foo'), /invalid branch/);
});

test('pidFromBranch returns null for invalid branches', () => {
    const cases = ['main', 'feature/x', 'tray-42', 'TRAY-42-foo', ''];
    for (const input of cases) {
        assert.strictEqual(pid.pidFromBranch(input), null, `input: ${JSON.stringify(input)}`);
    }
});

test('branchFromPid composes branch from PID + slug', () => {
    assert.strictEqual(pid.branchFromPid('TRAY-42', 'fold-installs'), 'tray-42-fold-installs');
    assert.throws(() => pid.branchFromPid('tray-42', 'foo'), /invalid pid/);
    assert.throws(() => pid.branchFromPid('TRAY-42', 'Foo'), /invalid slug/);
});

test('end-to-end: title -> slug -> branch -> pid -> pr title', () => {
    const repo = 'qol-tray';
    const issueNumber = 42;
    const userTitle = 'Fold Installs Into Config Dir';

    const prefix = pid.prefixForRepo(repo);
    const pidStr = pid.formatPid(prefix, issueNumber);
    const slug = pid.slugify(userTitle);
    const branch = pid.formatBranchName(prefix, issueNumber, slug);
    const prTitle = pid.formatPrTitle(prefix, issueNumber, pid.titleCaseFromSlug(slug));

    assert.strictEqual(pidStr, 'TRAY-42');
    assert.strictEqual(slug, 'fold-installs-into-config-dir');
    assert.strictEqual(branch, 'tray-42-fold-installs-into-config-dir');
    assert.strictEqual(prTitle, 'TRAY-42 Fold Installs Into Config Dir');
    assert.strictEqual(pid.pidFromBranch(branch), pidStr);
    assert.strictEqual(pid.parsePrTitle(prTitle).pid, pidStr);
});
