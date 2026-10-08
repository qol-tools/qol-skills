'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { classify, parseReview, parseArgs, parseTarget, attachLogs, cleanLogLine, render, watch, EXIT } = require('../bin/pr-watch.cjs');

function pr({ state = 'OPEN', checks = [], merge = 'BLOCKED', auto = true, queued = false, events = [], committed = '2026-10-08T10:00:00Z', comments = [] } = {}) {
    return {
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        state,
        isInMergeQueue: queued,
        mergeStateStatus: merge,
        autoMergeRequest: auto ? { enabledAt: '2026-10-08T10:00:00Z' } : null,
        commits: { nodes: [{ commit: { oid: 'abcdef1234567', committedDate: committed, statusCheckRollup: { contexts: { nodes: checks } } } }] },
        timelineItems: { nodes: events },
        comments: { nodes: comments },
    };
}

const run = (name, status, conclusion = null, id = 1) => ({
    __typename: 'CheckRun', name, status, conclusion, detailsUrl: `https://github.com/o/r/actions/runs/9/job/${id}`,
});
const status = (context, state) => ({ __typename: 'StatusContext', context, state, targetUrl: 'https://x' });

const cases = [
    ['merged', pr({ state: 'MERGED' }), 'merged'],
    ['closed', pr({ state: 'CLOSED' }), 'failed'],
    ['no checks yet', pr(), 'pending'],
    ['running', pr({ checks: [run('lint', 'IN_PROGRESS')] }), 'pending'],
    ['failed check run', pr({ checks: [run('lint', 'COMPLETED', 'FAILURE'), run('test', 'IN_PROGRESS')] }), 'failed'],
    ['cancelled check run', pr({ checks: [run('lint', 'COMPLETED', 'CANCELLED')] }), 'failed'],
    ['skipped is fine', pr({ checks: [run('lint', 'COMPLETED', 'SKIPPED'), run('test', 'IN_PROGRESS')] }), 'pending'],
    ['failed status context', pr({ checks: [status('queue', 'FAILURE')] }), 'failed'],
    ['errored status context', pr({ checks: [status('queue', 'ERROR')] }), 'failed'],
    ['pending status context', pr({ checks: [run('lint', 'COMPLETED', 'SUCCESS'), status('queue', 'PENDING')] }), 'pending'],
    ['merge conflict', pr({ merge: 'DIRTY' }), 'failed'],
    ['green and armed', pr({ checks: [run('lint', 'COMPLETED', 'SUCCESS')] }), 'pending'],
    ['green and queued', pr({ auto: false, queued: true, checks: [run('lint', 'COMPLETED', 'SUCCESS')] }), 'pending'],
    ['green, not armed', pr({ auto: false, checks: [run('lint', 'COMPLETED', 'SUCCESS')] }), 'idle'],
    ['removed from queue after head', pr({ auto: false, events: [{ __typename: 'RemovedFromMergeQueueEvent', reason: 'failed checks', createdAt: '2026-10-08T11:00:00Z' }] }), 'failed'],
    ['removal older than head', pr({ events: [{ __typename: 'RemovedFromMergeQueueEvent', reason: 'x', createdAt: '2026-10-08T09:00:00Z' }] }), 'pending'],
    ['re-added after removal', pr({ queued: true, events: [{ __typename: 'AddedToMergeQueueEvent' }] }), 'pending'],
];

for (const [name, input, expected] of cases) {
    test(`classify: ${name}`, () => {
        assert.equal(classify(input).outcome, expected);
    });
}

test('classify names every failed check and the conflict', () => {
    const verdict = classify(pr({ merge: 'DIRTY', checks: [run('lint', 'COMPLETED', 'FAILURE'), status('queue', 'FAILURE')] }));
    assert.deepEqual(verdict.reasons, ['check failed: lint', 'check failed: queue', 'merge conflict with the base branch']);
    assert.equal(verdict.failures.length, 2);
    assert.equal(verdict.head, 'abcdef1234567');
});

test('parseTarget reads URLs and numbers', () => {
    assert.deepEqual(parseTarget('https://github.com/qol-tools/qol/pull/78'), { owner: 'qol-tools', name: 'qol', number: 78 });
    assert.deepEqual(parseTarget('#12'), { number: 12 });
    assert.deepEqual(parseTarget('12'), { number: 12 });
    assert.equal(parseTarget('feature-branch'), null);
});

test('parseArgs takes one target and rejects the rest', () => {
    assert.deepEqual(parseArgs(['7', '--pretty']), { target: '7', pretty: true, interval: 30, timeout: 120 });
    assert.match(parseArgs(['7', '8']).error, /unexpected/);
    assert.match(parseArgs(['--interval', '0']).error, /positive/);
    assert.deepEqual(parseArgs(['--help']), { help: true });
});

test('cleanLogLine drops the job, step, timestamp and colour codes', () => {
    assert.equal(cleanLogLine('job\tstep\t﻿2026-10-08T09:47:40.1234567Z \x1b[36;1mboom\x1b[0m'), 'boom');
});

test('attachLogs skips the aggregate gate job unless it is the only failure', () => {
    const calls = [];
    const runner = (args) => {
        calls.push(args[2]);
        return { ok: true, stdout: 'a\tb\tline\n' };
    };
    const both = attachLogs([
        { name: 'merge gate', url: 'https://github.com/o/r/actions/runs/1/job/2' },
        { name: 'lint', url: 'https://github.com/o/r/actions/runs/3/job/4' },
    ], runner);
    assert.deepEqual(calls, ['3']);
    assert.equal(both[0].log, undefined);
    assert.equal(both[1].log, 'line');
    const gateOnly = attachLogs([{ name: 'merge gate', url: 'https://github.com/o/r/actions/runs/1/job/2' }], runner);
    assert.equal(gateOnly[0].log, 'line');
});

function fakeGh(snapshots) {
    let index = 0;
    return (args) => {
        if (args[0] === 'api') {
            const next = snapshots[Math.min(index, snapshots.length - 1)];
            index += 1;
            if (next === null) return { ok: false, error: 'network' };
            return { ok: true, stdout: JSON.stringify({ data: { repository: { pullRequest: next } } }) };
        }
        if (args[0] === 'run') return { ok: true, stdout: 'j\ts\terror: it broke\n' };
        return { ok: false, error: 'unexpected' };
    };
}

function clock() {
    let t = 0;
    return { now: () => t, sleep: (s) => { t += s * 1000; } };
}

test('watch waits through pending polls and a transient error, then reports the failure', () => {
    const { now, sleep } = clock();
    const result = watch(
        { target: 'https://github.com/o/r/pull/7', interval: 30, timeout: 120 },
        { run: fakeGh([pr({ checks: [run('lint', 'IN_PROGRESS', null, 5)] }), null, pr({ checks: [run('lint', 'COMPLETED', 'FAILURE', 5)] })]), now, sleep },
    );
    assert.equal(result.code, EXIT.failed);
    assert.equal(result.report.elapsed_s, 60);
    assert.equal(result.report.failures[0].log, 'error: it broke');
    assert.match(render(result.report), /PR #7 failed at abcdef123 after 60s[\s\S]*error: it broke/);
});

test('watch exits 0 on merge', () => {
    const { now, sleep } = clock();
    const result = watch({ target: 'https://github.com/o/r/pull/7', interval: 30, timeout: 120 }, { run: fakeGh([pr({ state: 'MERGED' })]), now, sleep });
    assert.equal(result.code, EXIT.merged);
});

test('watch times out on a pull request that never settles', () => {
    const { now, sleep } = clock();
    const result = watch({ target: 'https://github.com/o/r/pull/7', interval: 60, timeout: 2 }, { run: fakeGh([pr()]), now, sleep });
    assert.equal(result.code, EXIT.timeout);
});

test('watch gives up after repeated gh failures', () => {
    const { now, sleep } = clock();
    const result = watch({ target: 'https://github.com/o/r/pull/7', interval: 1, timeout: 120 }, { run: fakeGh([null]), now, sleep });
    assert.equal(result.code, EXIT.gh);
});

test('watch reports a branch with no pull request', () => {
    const result = watch({ target: null, interval: 1, timeout: 1 }, { run: () => ({ ok: false, error: 'no pull requests found' }) });
    assert.equal(result.code, EXIT.missing);
});

const FIX = '9b28de83c99ea8259e22491da46ad591bbb06130';
const REVIEW_FIXED = `<!-- qol-code-review -->

<!-- reviewed 6129040aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->

> [!WARNING]
> **Conditional** · 1 medium · 1 low · changes since \`946e83e\`
> 1 fixed in [\`9b28de8\`](https://github.com/o/r/commit/${FIX}), 0 left for you.

#### Medium · 1

<details><summary>Restore guard &lt;armed&gt; too late <code>fixed</code></summary>

body

</details>

#### Low · 1

<details><summary>Raw mode left on</summary>

</details>

<details><summary>Full review</summary>

text

</details>
`;
const REVIEW_LEFT = `<!-- qol-code-review -->

<!-- reviewed 6129040aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->

> [!CAUTION]
> **Block** · 2 high
> Nothing was fixed, 2 left for you.
`;
const REVIEW_PASS = `<!-- qol-code-review -->

<!-- reviewed 6129040aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->

> [!TIP]
> **Pass** · no findings
> Nothing to fix.
`;
const REVIEW_FAILED = `<!-- qol-code-review -->
> [!CAUTION]
> **Review failed.** The review of \`6129040\` failed before it produced a result. See [the run](https://x).
`;
const QUEUE_FIX = `<!-- qol-queue-fix -->

> [!TIP]
> **Merge queue failed** · [lint](https://job/1)
> Fixed in [\`9b28de8\`](https://github.com/o/r/commit/${FIX}). Queue it again once its checks pass.
`;

const reviewCases = [
    ['bot fix pushed', REVIEW_FIXED, { needs_you: true, left: 0, fix_commit: FIX }],
    ['findings left', REVIEW_LEFT, { needs_you: true, left: 2, fix_commit: null }],
    ['clean pass', REVIEW_PASS, { needs_you: false, left: 0, fix_commit: null }],
    ['review failed', REVIEW_FAILED, { needs_you: true, left: 0, fix_commit: null }],
    ['queue fix pushed', QUEUE_FIX, { needs_you: true, left: 0, fix_commit: FIX }],
];

for (const [name, body, expected] of reviewCases) {
    test(`parseReview: ${name}`, () => {
        const review = parseReview(body, 'https://c');
        assert.deepEqual({ needs_you: review.needs_you, left: review.left, fix_commit: review.fix_commit }, expected);
    });
}

test('parseReview reads the summary and every finding with its lane and status', () => {
    const review = parseReview(REVIEW_FIXED, 'https://c');
    assert.equal(review.kind, 'review');
    assert.deepEqual(review.summary, ['Conditional · 1 medium · 1 low · changes since `946e83e`', '1 fixed in 9b28de8, 0 left for you.']);
    assert.deepEqual(review.findings, [
        { severity: 'medium', title: 'Restore guard <armed> too late', status: 'fixed' },
        { severity: 'low', title: 'Raw mode left on', status: 'open' },
    ]);
    assert.equal(parseReview('a human comment', 'u'), null);
});

const bot = (body, createdAt = '2026-10-08T12:00:00Z') => ({ author: { __typename: 'Bot', login: 'github-actions' }, body, createdAt, url: 'https://c' });
const SINCE = '2026-10-08T11:00:00Z';

test('classify wakes on a new review that needs the agent', () => {
    const verdict = classify(pr({ checks: [run('lint', 'IN_PROGRESS')], comments: [bot(REVIEW_LEFT)] }), SINCE);
    assert.equal(verdict.outcome, 'review');
    assert.equal(verdict.review.left, 2);
});

test('classify ignores reviews from before the watcher started, clean reviews and human comments', () => {
    assert.equal(classify(pr({ comments: [bot(REVIEW_LEFT, '2026-10-08T10:30:00Z')] }), SINCE).outcome, 'pending');
    assert.equal(classify(pr({ comments: [bot(REVIEW_LEFT), bot(REVIEW_PASS, '2026-10-08T12:30:00Z')] }), SINCE).outcome, 'pending');
    assert.equal(classify(pr({ comments: [{ ...bot(REVIEW_LEFT), author: { __typename: 'User', login: 'KMRH47' } }] }), SINCE).outcome, 'pending');
    assert.equal(classify(pr({ comments: [{ ...bot(REVIEW_LEFT), author: { __typename: 'User', login: 'github-actions' } }] }), SINCE).outcome, 'pending');
    assert.equal(classify(pr({ comments: [{ ...bot(REVIEW_LEFT), author: { __typename: 'Bot', login: 'github-actions-lookalike' } }] }), SINCE).outcome, 'pending');
});

test('a failed check wins over a review and still carries it', () => {
    const verdict = classify(pr({ checks: [run('lint', 'COMPLETED', 'FAILURE')], comments: [bot(REVIEW_FIXED)] }), SINCE);
    assert.equal(verdict.outcome, 'failed');
    assert.equal(verdict.review.fix_commit, FIX);
    assert.match(render({ pr: 7, ...verdict, failures: [] }), /pull it before your next push/);
});
