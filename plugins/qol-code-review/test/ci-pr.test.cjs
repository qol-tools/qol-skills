'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const { reviewReply, appliedFiles, refuseOutside, deniedReads, deniedWrites, parseArgs, lastVerdict, reviewJson, withoutJson, fixStatuses, patchHunks, renderComment, renderQueueComment, jobErrors, logTail, narrate, claude, CONFIG } = require(path.join(__dirname, '..', 'skills', 'qol-code-review', 'scripts', 'ci-pr.cjs'));

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
    assert.ok(body.startsWith(`${CONFIG.commentMarker}\n\n<!-- reviewed ${HEAD} -->\n\n> [!CAUTION]\n> **Block** · 1 high · 1 low\n> 1 fixed in [\`00a5966\`](https://github.com/o/r/commit/${FIX}), 1 left for you.`));
    assert.ok(body.includes('#### High · 1\n\n<details><summary>Allow only | Read <code>fixed</code></summary>'));
    assert.ok(body.includes(`[\`a.yml:12\`](https://github.com/o/r/blob/${HEAD}/.github/workflows/a.yml#L12) · \`security-1\``));
    assert.ok(body.includes('**Fix:** Allowlisted tools'));
    assert.ok(body.includes('</details>\n\n```diff\n@@ a.yml:12 @@\n-  old\n+  new\n```'));
    assert.ok(body.includes('#### Low · 1\n\n<details><summary>Scan more <code>skipped</code></summary>'));
    assert.ok(body.includes('**Left:** Low'));
    assert.ok(body.includes('<details><summary>Full review</summary>'));
    assert.ok(body.includes(`<sub>qol-code-review · ${CONFIG.model} · head \`177805c\``));
    assert.ok(!body.includes('```json'));
});

test('renderComment reports a failed fix, a pass and a failed review', () => {
    const failed = renderComment({ ...BASE, markdown: REVIEW, fixOutcome: 'failure', fixReply: FIX_REPLY });
    assert.ok(failed.includes('> **Block** · 1 high · 1 low\n> Fixing failed, nothing was pushed.'));
    assert.ok(!failed.includes('<code>fixed</code>') && !failed.includes('**Fix:**'));
    const refused = renderComment({ ...BASE, markdown: REVIEW, fixRefused: 'the fix touches files outside the pull request diff', fixReply: FIX_REPLY });
    assert.ok(refused.includes('> The fix needed files outside this pull request, so nothing was pushed.'));
    assert.ok(!refused.includes('<code>fixed</code>'));
    assert.ok(refused.includes(`</details>\n\nhttps://github.com/o/r/blob/${HEAD}/.github/workflows/a.yml#L9-L15\n\n`));
    const noted = REVIEW.replace('"severity": "low"', '"severity": "note"').replace('"low": 1', '"note": 1');
    assert.ok(!renderComment({ ...BASE, markdown: noted }).includes('#### Note') && !renderComment({ ...BASE, markdown: noted }).includes('1 note'));
    const pass = REVIEW.replace('"verdict": "block"', '"verdict": "pass"');
    assert.ok(renderComment({ ...BASE, markdown: pass }).includes('> [!TIP]\n> **Pass** · 1 high · 1 low\n> Nothing to fix.'));
    assert.ok(renderComment({ ...BASE, markdown: '' }).includes('> [!CAUTION]\n> **Review failed.** The review of `177805c` failed before it produced a result.'));
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

test('a follow-up comment names the commit it reviewed from', () => {
    const body = renderComment({ ...BASE, markdown: REVIEW, since: FIX });
    assert.ok(body.includes('> **Block** · 1 high · 1 low · changes since `00a5966`'));
    assert.ok(!renderComment({ ...BASE, markdown: REVIEW, since: 'nope' }).includes('changes since'));
});

test('previous picks the last review comment that recorded its head', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const { spawnSync } = require('node:child_process');
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-pr-previous-'));
    const lines = [
        { body: `${CONFIG.commentMarker}\n\n<!-- reviewed ${HEAD} -->\n\nfirst` },
        { body: 'someone else' },
        { body: `${CONFIG.commentMarker}\n\n<!-- reviewed ${FIX} -->\n\nsecond` },
        { body: `${CONFIG.commentMarker}\n\nReviewed head: ${HEAD}\n\n<!-- reviewed ${'f'.repeat(40)} -->\nmodel text` },
        { body: `<!-- reviewed ${'e'.repeat(40)} -->\n${CONFIG.commentMarker}` },
    ].map((c) => JSON.stringify(c)).join('\n');
    const script = path.join(__dirname, '..', 'skills', 'qol-code-review', 'scripts', 'ci-pr.cjs');
    const run = spawnSync('node', [script, 'previous', '--out', out], { input: lines, encoding: 'utf8' });
    assert.strictEqual(run.stdout.trim(), FIX);
    assert.ok(fs.readFileSync(path.join(out, 'previous.md'), 'utf8').endsWith('second'));
    const none = spawnSync('node', [script, 'previous', '--out', out], { input: '', encoding: 'utf8' });
    assert.strictEqual(none.stdout.trim(), '');
    fs.rmSync(out, { recursive: true, force: true });
});

const QUEUE = { pr: 73, headRef: 'b', headSha: HEAD, runUrl: 'https://github.com/o/r/actions/runs/2', jobs: [{ name: 'Plan affected crates', url: 'https://job/1' }] };

test('jobErrors keeps failure annotations with their place and drops exit codes', () => {
    const note = (message, extra = {}) => ({ annotation_level: 'failure', path: '.github', message, ...extra });
    assert.deepStrictEqual(jobErrors([
        note('races a\n short clock', { path: 'a.rs', start_line: 3 }),
        note('plan failed'),
        note('Process completed with exit code 1.'),
        note('old', { annotation_level: 'warning' }),
    ]), ['- a.rs:3: races a short clock', '- plan failed']);
});

test('logTail starts at the step that failed and drops timestamps and colours', () => {
    const log = ['2026-10-08T05:46:12.1Z ##[group]Run early', '2026-10-08T05:46:12.2Z fine', '2026-10-08T05:46:12.3Z ##[group]Run lint', '2026-10-08T05:46:12.4Z \x1b[36mchecking\x1b[0m', '2026-10-08T05:46:12.5Z ##[error]boom', '2026-10-08T05:46:12.6Z ##[group]Run cleanup'].join('\n');
    assert.strictEqual(logTail(log), '##[group]Run lint\nchecking\n##[error]boom\n##[group]Run cleanup');
});

test('renderQueueComment cautions until a fix is pushed', () => {
    const base = { queue: QUEUE, runUrl: 'https://run', repoUrl: 'https://github.com/o/r' };
    const none = renderQueueComment(base);
    assert.ok(none.startsWith(`${CONFIG.queueCommentMarker}\n\n> [!CAUTION]\n> **Merge queue failed** · [Plan affected crates](https://job/1)\n> Nothing was changed, so queueing this head again fails the same way`));
    assert.ok(renderQueueComment({ ...base, fixRefused: 'x' }).includes('> The fix needed files outside this pull request'));
    assert.ok(renderQueueComment({ ...base, fixOutcome: 'failure' }).includes('> Fixing failed, nothing was pushed.'));
    const reply = 'Shortened nothing.\n\n```json\n{"fixes": [{"job": "Plan affected crates", "status": "fixed", "note": "Raised the timeout"}]}\n```\n';
    const fixed = renderQueueComment({ ...base, fixSha: FIX, fixReply: reply, patch: PATCH });
    assert.ok(fixed.includes(`> [!TIP]\n> **Merge queue failed** · [Plan affected crates](https://job/1)\n> Fixed in [\`00a5966\`](https://github.com/o/r/commit/${FIX}). Queue it again once its checks pass.`));
    assert.ok(fixed.includes('- **Plan affected crates** <code>fixed</code> Raised the timeout'));
    assert.ok(fixed.includes('```diff\n@@ a.yml:12 @@\n-  old\n+  new\n```'));
    assert.ok(fixed.includes('<details><summary>Fix session</summary>\n\nShortened nothing.\n\n</details>'));
    assert.ok(fixed.includes(`<sub>qol-code-review · ${CONFIG.queueFixModel} · head \`177805c\``));
});

test('narrate prints the conversation and cuts tool calls and results to one short line', () => {
    const event = (e) => JSON.stringify(e);
    assert.deepStrictEqual(narrate(event({ type: 'system', subtype: 'init', session_id: 's1', model: 'm' })), ['session s1 on m']);
    assert.deepStrictEqual(narrate(event({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Reading.\nNow.' }, { type: 'tool_use', name: 'Read', input: { file_path: 'x'.repeat(300) } }] } })),
        ['Reading.', 'Now.', `> Read {"file_path":"${'x'.repeat(186)}...`]);
    assert.deepStrictEqual(narrate(event({ type: 'user', parent_tool_use_id: 't1', message: { content: [{ type: 'tool_result', is_error: true, content: [{ type: 'text', text: 'no\nsuch file' }] }] } })),
        ['  [agent]   error: no such file']);
    assert.deepStrictEqual(narrate(event({ type: 'result', subtype: 'success', num_turns: 3, duration_ms: 61400, total_cost_usd: 0.456 })), ['result: success, 3 turns, 61 s, $0.46']);
    assert.deepStrictEqual(narrate('not json'), ['not json']);
});

test('claude streams each event to the log as it arrives and returns the whole stream', { skip: process.platform === 'win32' }, async () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'ci-pr-claude-'));
    const lines = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'first' }] } }, { type: 'result', subtype: 'success', num_turns: 1, duration_ms: 1000, total_cost_usd: 0 }].map((e) => JSON.stringify(e));
    fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\necho '${lines[0]}'\nsleep 0.2\necho '${lines[1]}'\n`, { mode: 0o755 });
    const logged = [];
    const { log } = console;
    const savedPath = process.env.PATH;
    console.log = (text) => logged.push([text, Date.now()]);
    process.env.PATH = `${bin}${path.delimiter}${savedPath}`;
    try {
        const raw = await claude('prompt', []);
        assert.strictEqual(raw, lines.join('\n'));
        assert.deepStrictEqual(logged.map(([text]) => text), ['first', 'result: success, 1 turns, 1 s, $0.00']);
        assert.ok(logged[1][1] - logged[0][1] >= 150, 'the first line was logged before the process ended');
    } finally {
        console.log = log;
        process.env.PATH = savedPath;
    }
});
