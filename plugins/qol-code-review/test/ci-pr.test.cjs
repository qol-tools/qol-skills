'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { patchFiles, deniedReads, deniedWrites, parseArgs, lastVerdict, reviewJson, withoutJson, renderComment, CONFIG } = require(path.join(__dirname, '..', 'skills', 'qol-code-review', 'scripts', 'ci-pr.cjs'));

const HEAD = '177805ca3d66cc5c451f77336320b891bb3ee303';
const FIX = '00a59666596d3fd41327ce1d3c0ed14b4c13a1ad';
const BASE = { headSha: HEAD, runUrl: 'https://github.com/o/r/actions/runs/1', repoUrl: 'https://github.com/o/r' };

const REVIEW = [
    '## Review board result',
    '',
    '- **Verdict:** block',
    '',
    '```json',
    JSON.stringify({
        verdict: 'block',
        counts: { blocker: 0, high: 1, medium: 0, low: 1 },
        must_fix: [{ id: 'security-1', severity: 'high', file: '.github/workflows/a.yml', line: 12, required_action: 'Allow only | Read' }],
        deferred_followups: [{ id: 'release-ci-1', severity: 'low', file: 'b.txt', required_action: 'Scan\nmore' }],
    }, null, 2),
    '```',
    '',
].join('\n');

test('parseArgs reads the command and camel-cases flags', () => {
    assert.deepStrictEqual(parseArgs(['comment', '--head-sha', 'abc', '--out', 'x']), { command: 'comment', headSha: 'abc', out: 'x' });
    assert.throws(() => parseArgs(['review', '--pr']), /Expected --flag value/);
});

test('lastVerdict takes the final verdict in the reply', () => {
    assert.strictEqual(lastVerdict('"verdict": "pass" then "verdict":"block"'), 'block');
    assert.strictEqual(lastVerdict('no block here'), 'unknown');
});

test('reviewJson reads the last json fence and withoutJson drops it', () => {
    assert.strictEqual(reviewJson(REVIEW).verdict, 'block');
    assert.strictEqual(reviewJson('```json\n{nope\n```\n'), null);
    assert.ok(!withoutJson(REVIEW).includes('```json'));
    assert.ok(withoutJson(REVIEW).includes('## Review board result'));
});

test('renderComment leads with the verdict, tables and the pushed fix, and folds the prose', () => {
    const body = renderComment({ ...BASE, markdown: REVIEW, fixSha: FIX, fixReply: '- security-1: fixed' });
    assert.ok(body.startsWith(`${CONFIG.commentMarker}\n## ⛔ Code review: block`));
    assert.ok(body.includes('Head `177805c` · 1 high · 1 low'));
    assert.ok(body.includes(`| high | security-1 | [\`a.yml:12\`](https://github.com/o/r/blob/${HEAD}/.github/workflows/a.yml#L12) | Allow only \\| Read |`));
    assert.ok(body.includes('| low | release-ci-1 | [`b.txt`](https://github.com/o/r/blob/' + HEAD + '/b.txt) | Scan more |'));
    assert.ok(body.includes(`Pushed [\`00a5966\`](https://github.com/o/r/commit/${FIX}).`));
    assert.ok(body.includes('<details><summary>Fix notes</summary>'));
    assert.ok(!body.includes('```json'));
});

test('renderComment reports a failed fix and a failed review', () => {
    assert.ok(renderComment({ ...BASE, markdown: REVIEW, fixOutcome: 'failure' }).includes('Fixing failed, nothing was pushed.'));
    const failed = renderComment({ ...BASE, markdown: '' });
    assert.ok(failed.includes('The review of `177805c` failed before it produced a result.'));
});

test('renderComment posts a review without a json block as it is', () => {
    const body = renderComment({ ...BASE, markdown: 'plain review' });
    assert.ok(body.includes(`Reviewed head: ${HEAD}\n\nplain review`));
});

test('the sessions cannot read /proc and the fix cannot write where later steps read', () => {
    assert.deepStrictEqual(deniedReads(), ['Read(//proc/**)']);
    const saved = { ...process.env };
    Object.assign(process.env, { RUNNER_TEMP: '/runner/_temp', CLAUDE_CODE_PLUGIN_SEED_DIR: '/home/runner/.claude-seed' });
    try {
        const denied = deniedWrites();
        for (const rule of ['Edit(//runner/_temp/**)', 'Write(//runner/_temp/**)', 'Edit(//home/runner/.claude-seed/**)', 'Write(//home/runner/.claude-seed/**)']) {
            assert.ok(denied.includes(rule), rule);
        }
        const gitDir = path.resolve(require('node:child_process').execFileSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' }).trim());
        assert.ok(denied.includes(`Edit(/${gitDir}/**)`), gitDir);
    } finally {
        process.env = saved;
    }
});

test('patchFiles reads paths the way git apply does and refuses renames', () => {
    const dir = require('node:fs').mkdtempSync(path.join(require('node:os').tmpdir(), 'ci-pr-patch-'));
    const file = path.join(dir, 'fix.patch');
    require('node:fs').writeFileSync(file, [
        'diff --git a/src/x.rs b/src/x.rs', '--- a/src/x.rs', '+++ b/src/x.rs', '@@ -0,0 +1 @@', '+a',
        'diff --git a/old.txt b/old.txt', 'deleted file mode 100644', '--- a/old.txt', '+++ /dev/null', '@@ -1 +0,0 @@', '-a', '',
    ].join('\n'));
    assert.deepStrictEqual(patchFiles(file), ['src/x.rs', 'old.txt']);
    require('node:fs').writeFileSync(file, ['diff --git a/old.txt b/.github/new.yml', 'similarity index 100%', 'rename from old.txt', 'rename to .github/new.yml', ''].join('\n'));
    assert.throws(() => patchFiles(file), /renames or copies/);
});
