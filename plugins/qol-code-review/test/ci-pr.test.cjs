'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { reviewReply, appliedFiles, refuseOutside, deniedReads, deniedWrites, parseArgs, lastVerdict, reviewJson, withoutJson, fixStatuses, patchHunks, renderComment, CONFIG } = require(path.join(__dirname, '..', 'skills', 'qol-code-review', 'scripts', 'ci-pr.cjs'));

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

const PATCH = [
    'diff --git a/.github/workflows/a.yml b/.github/workflows/a.yml',
    '--- a/.github/workflows/a.yml',
    '+++ b/.github/workflows/a.yml',
    '@@ -12,1 +12,1 @@',
    '-  old',
    '+  new',
    '',
].join('\n');
const FIX_REPLY = 'Done.\n\n```json\n{"fixes": [{"id": "security-1", "status": "fixed", "note": "Allowlisted tools"}, {"id": "release-ci-1", "status": "skipped", "note": "Low"}]}\n```\n';

test('renderComment draws severity lanes, a fold per finding and the fix diff in the open', () => {
    const body = renderComment({ ...BASE, markdown: REVIEW, fixSha: FIX, fixReply: FIX_REPLY, patch: PATCH });
    assert.ok(body.startsWith(`${CONFIG.commentMarker}\n\n## ⛔ Block\n\n1 high · 1 low · 1 fixed in [\`00a5966\`](https://github.com/o/r/commit/${FIX}), 0 left for you.`));
    assert.ok(body.includes('#### 🔴 High\n\n<details><summary>✅ Allow only | Read</summary>'));
    assert.ok(body.includes(`[\`a.yml:12\`](https://github.com/o/r/blob/${HEAD}/.github/workflows/a.yml#L12) · \`security-1\``));
    assert.ok(body.includes('**Fix:** Allowlisted tools'));
    assert.ok(body.includes('</details>\n\n```diff\n@@ a.yml:12 @@\n-  old\n+  new\n```'));
    assert.ok(body.includes('#### 🟡 Low\n\n<details><summary>⏭️ Scan more</summary>'));
    assert.ok(body.includes('<details><summary>Full review</summary>'));
    assert.ok(body.includes(`<sub>qol-code-review · ${CONFIG.model} · head \`177805c\``));
    assert.ok(!body.includes('```json'));
});

test('renderComment reports a failed fix, a pass and a failed review', () => {
    const failed = renderComment({ ...BASE, markdown: REVIEW, fixOutcome: 'failure', fixReply: FIX_REPLY });
    assert.ok(failed.includes('1 high · 1 low · Fixing failed, nothing was pushed.'));
    assert.ok(!failed.includes('✅') && !failed.includes('**Fix:**'));
    const pass = REVIEW.replace('"verdict": "block"', '"verdict": "pass"');
    assert.ok(renderComment({ ...BASE, markdown: pass }).includes('## ✅ Pass\n\n1 high · 1 low · Nothing to fix.'));
    assert.ok(renderComment({ ...BASE, markdown: '' }).includes('## ❌ Review failed\n\nThe review of `177805c` failed before it produced a result.'));
});

test('fixStatuses reads the fixes json, or id lines when there is none', () => {
    assert.deepStrictEqual(fixStatuses(FIX_REPLY).get('security-1'), { status: 'fixed', note: 'Allowlisted tools' });
    assert.deepStrictEqual(fixStatuses('- **adversarial-2:** skipped, low.').get('adversarial-2'), { status: 'skipped', note: 'low.' });
});

test('patchHunks keeps each hunk with its file and new line', () => {
    assert.deepStrictEqual(patchHunks(PATCH), [{ file: '.github/workflows/a.yml', line: 12, lines: ['-  old', '+  new'] }]);
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
        const rules = ['/runner/_temp', '/home/runner/.claude-seed'].flatMap((dir) => [`Edit(/${path.resolve(dir)}/**)`, `Write(/${path.resolve(dir)}/**)`]);
        for (const rule of rules) {
            assert.ok(denied.includes(rule), rule);
        }
        const gitDir = path.resolve(require('node:child_process').execFileSync('git', ['rev-parse', '--git-dir'], { encoding: 'utf8' }).trim());
        assert.ok(denied.includes(`Edit(/${gitDir}/**)`), gitDir);
    } finally {
        process.env = saved;
    }
});

test('the patch check uses the paths git actually applies on the pull request head', () => {
    const fs = require('node:fs');
    const { execFileSync } = require('node:child_process');
    const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ci-pr-patch-'));
    const run = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, encoding: 'utf8' });
    run('init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'kept.txt'), 'a\n');
    run('add', '.');
    run('commit', '-qm', 'base');
    run('branch', 'pr');
    run('symbolic-ref', 'HEAD', 'refs/heads/pr');
    run('reset', '-q', '--hard');
    fs.writeFileSync(path.join(dir, 'pr.txt'), 'a\n');
    run('add', '.');
    run('commit', '-qm', 'pr');
    run('symbolic-ref', 'HEAD', 'refs/heads/main');
    run('reset', '-q', '--hard');
    run('merge', '-q', '--no-ff', 'pr', '-m', 'merge');
    const patch = (name) => {
        const file = path.join(dir, `${name.replace(/\W/g, '-')}.patch`);
        fs.writeFileSync(file, [`diff --git a/${name} b/${name}`, 'new file mode 100644', '--- /dev/null', `+++ b/${name}`, '@@ -0,0 +1 @@', '+x', ''].join('\n'));
        return file;
    };
    const cwd = process.cwd();
    process.chdir(dir);
    try {
        fs.writeFileSync(path.join(dir, 'p.patch'), ['diff --git a/pr.txt b/pr.txt', '--- a/pr.txt', '+++ b/pr.txt', '@@ -1 +1 @@', '-a', '+b', ''].join('\n'));
        assert.deepStrictEqual(appliedFiles(path.join(dir, 'p.patch'), 'HEAD^2'), ['pr.txt']);
        assert.doesNotThrow(() => refuseOutside(['pr.txt'], { base: 'HEAD^1', head: 'HEAD' }));
        assert.throws(() => refuseOutside(appliedFiles(patch('.github/x.yml'), 'HEAD^2'), { base: 'HEAD^1', head: 'HEAD' }), /outside the pull request diff/);
        assert.throws(() => refuseOutside(appliedFiles(patch('other.txt'), 'HEAD^2'), { base: 'HEAD^1', head: 'HEAD' }), /other.txt/);
    } finally {
        process.chdir(cwd);
    }
});

test('reviewReply keeps the review message, not a later recap or a subagent message', () => {
    const line = (event) => JSON.stringify(event);
    const text = (t, parent = null) => line({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'text', text: t }] } });
    const stream = [
        text('starting'),
        text('agent says ```json\n{"verdict": "pass"}\n```', 'toolu_1'),
        text(REVIEW),
        text('Recap: the verdict is block.'),
        line({ type: 'result', subtype: 'success', is_error: false, result: 'Recap: the verdict is block.', permission_denials: [] }),
    ].join('\n');
    const { reply } = reviewReply(stream);
    assert.strictEqual(reply, REVIEW);
    assert.strictEqual(reviewReply(line({ type: 'result', subtype: 'error_max_turns', result: 'x' })).reply, '');
    assert.strictEqual(reviewReply(line({ type: 'result', subtype: 'success', result: 'plain' })).reply, 'plain');
});
