'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

const { classify, parseReview, parseArgs, parseTarget, attachLogs, cleanLogLine, render, watch, followUps, EXIT } = require('../bin/pr-watch.cjs');

const fingerprintOf = (shape) => createHash('sha256').update(`review\n${shape}`).digest('hex').slice(0, 16);

function pr({ state = 'OPEN', draft = false, checks = [], merge = 'BLOCKED', auto = true, armed = '2026-10-08T10:00:00Z', queued = false, events = [], committed = '2026-10-08T10:00:00Z', comments = [] } = {}) {
    return {
        number: 7,
        url: 'https://github.com/o/r/pull/7',
        state,
        isDraft: draft,
        isInMergeQueue: queued,
        mergeStateStatus: merge,
        autoMergeRequest: auto ? { enabledAt: armed } : null,
        commits: { nodes: [{ commit: { oid: 'abcdef1234567', committedDate: committed, statusCheckRollup: { contexts: { nodes: checks } } } }] },
        timelineItems: { nodes: events },
        comments: { nodes: comments },
    };
}

const run = (name, status, conclusion = null, id = 1) => ({
    __typename: 'CheckRun', name, status, conclusion, detailsUrl: `https://github.com/o/r/actions/runs/9/job/${id}`,
});
const inRun = (check, workflow, runId) => ({ ...check, checkSuite: { workflowRun: { databaseId: runId, workflow: { databaseId: workflow } } } });
const status = (context, state, createdAt = '2026-10-08T10:30:00Z') => ({ __typename: 'StatusContext', context, state, targetUrl: 'https://x', createdAt });
const enqueued = (createdAt) => ({ __typename: 'AddedToMergeQueueEvent', createdAt });

const cases = [
    ['merged', pr({ state: 'MERGED' }), 'merged'],
    ['closed', pr({ state: 'CLOSED' }), 'failed'],
    ['no checks yet', pr(), 'pending'],
    ['running', pr({ checks: [run('lint', 'IN_PROGRESS')] }), 'pending'],
    ['failed check run', pr({ checks: [run('lint', 'COMPLETED', 'FAILURE'), run('test', 'IN_PROGRESS')] }), 'failed'],
    ['cancelled check run', pr({ checks: [run('lint', 'COMPLETED', 'CANCELLED')] }), 'failed'],
    ['cancelled run superseded by a running rerun', pr({ checks: [run('review', 'COMPLETED', 'CANCELLED', 1), run('review', 'IN_PROGRESS', null, 2)] }), 'pending'],
    ['cancelled run superseded by a green rerun', pr({ auto: false, checks: [run('review', 'COMPLETED', 'CANCELLED', 1), run('review', 'COMPLETED', 'SUCCESS', 2)] }), 'idle'],
    ['cancelled run beside a failed rerun', pr({ checks: [run('review', 'COMPLETED', 'CANCELLED', 1), run('review', 'COMPLETED', 'FAILURE', 2)] }), 'failed'],
    ['failed checks of a run a newer run of the workflow replaced', pr({ checks: [inRun(run('Publish the review', 'COMPLETED', 'FAILURE', 1), 50, 100), inRun(run('claude review', 'COMPLETED', 'FAILURE', 2), 50, 100), inRun(run('Review with qol-code-review', 'IN_PROGRESS', null, 3), 50, 101)] }), 'pending'],
    ['a newer run of another workflow replaces nothing', pr({ checks: [inRun(run('Wait for the review', 'COMPLETED', 'FAILURE', 1), 60, 100), inRun(run('Wait for the review', 'IN_PROGRESS', null, 2), 70, 101)] }), 'failed'],
    ['a failure in the newest run still counts', pr({ checks: [inRun(run('claude review', 'COMPLETED', 'SUCCESS', 1), 50, 100), inRun(run('claude review', 'COMPLETED', 'FAILURE', 2), 50, 101)] }), 'failed'],
    ['skipped is fine', pr({ checks: [run('lint', 'COMPLETED', 'SKIPPED'), run('test', 'IN_PROGRESS')] }), 'pending'],
    ['failed status context', pr({ checks: [status('queue', 'FAILURE')] }), 'failed'],
    ['errored status context', pr({ checks: [status('queue', 'ERROR')] }), 'failed'],
    ['pending status context', pr({ checks: [run('lint', 'COMPLETED', 'SUCCESS'), status('queue', 'PENDING')] }), 'pending'],
    ['merge queue status of a run before the pull request was queued again', pr({ queued: true, checks: [run('lint', 'COMPLETED', 'SUCCESS'), status('merge queue', 'FAILURE')] }), 'pending'],
    ['merge queue status of the run that holds the queued pull request', pr({ queued: true, events: [enqueued('2026-10-08T10:20:00Z')], checks: [run('lint', 'COMPLETED', 'SUCCESS'), status('merge queue', 'FAILURE')] }), 'failed'],
    ['merge queue status of a run before the latest enqueue', pr({ queued: true, events: [enqueued('2026-10-08T10:40:00Z')], checks: [run('lint', 'COMPLETED', 'SUCCESS'), status('merge queue', 'FAILURE')] }), 'pending'],
    ['merge queue status while the pull request is out of the queue', pr({ auto: false, checks: [run('lint', 'COMPLETED', 'SUCCESS'), status('merge queue', 'FAILURE')] }), 'failed'],
    ['merge conflict', pr({ merge: 'DIRTY' }), 'failed'],
    ['green and armed', pr({ checks: [run('lint', 'COMPLETED', 'SUCCESS')] }), 'pending'],
    ['green and queued', pr({ auto: false, queued: true, checks: [run('lint', 'COMPLETED', 'SUCCESS')] }), 'pending'],
    ['green, not armed', pr({ auto: false, checks: [run('lint', 'COMPLETED', 'SUCCESS')] }), 'idle'],
    ['removed from queue after head', pr({ auto: false, events: [{ __typename: 'RemovedFromMergeQueueEvent', reason: 'failed checks', createdAt: '2026-10-08T11:00:00Z' }] }), 'failed'],
    ['removal older than head', pr({ events: [{ __typename: 'RemovedFromMergeQueueEvent', reason: 'x', createdAt: '2026-10-08T09:00:00Z' }] }), 'pending'],
    ['removal superseded by a later auto-merge arm', pr({ armed: '2026-10-08T12:00:00Z', events: [{ __typename: 'RemovedFromMergeQueueEvent', reason: 'manual', createdAt: '2026-10-08T11:00:00Z' }] }), 'pending'],
    ['removal because the queue merged it, before the state flips', pr({ auto: false, events: [{ __typename: 'RemovedFromMergeQueueEvent', reason: 'merged', createdAt: '2026-10-08T11:00:00Z' }] }), 'pending'],
    ['removal after the auto-merge arm', pr({ events: [{ __typename: 'RemovedFromMergeQueueEvent', reason: 'failed checks', createdAt: '2026-10-08T11:00:00Z' }] }), 'failed'],
    ['re-added after removal', pr({ queued: true, events: [{ __typename: 'AddedToMergeQueueEvent' }] }), 'pending'],
];

for (const [name, input, expected] of cases) {
    test(`classify: ${name}`, () => {
        assert.equal(classify(input).outcome, expected);
    });
}

test('classify tells a green draft to stay unarmed', () => {
    const verdict = classify(pr({ draft: true, auto: false, checks: [run('lint', 'COMPLETED', 'SUCCESS')] }));
    assert.equal(verdict.outcome, 'idle');
    assert.equal(verdict.live_test, null);
    assert.match(verdict.reasons[0], /no live test check: design work waiting for the user's approval; leave auto-merge off, report it to your parent, then park again with --until-ready/);
    assert.equal(classify(pr({ draft: true, auto: false, checks: [run('lint', 'IN_PROGRESS')] })).outcome, 'pending');
});

const liveTest = (title, status = 'COMPLETED') => ({ ...run('live test', status, status === 'COMPLETED' ? 'SUCCESS' : null), title });

test('classify reads the live test check on a green draft', () => {
    const lint = run('lint', 'COMPLETED', 'SUCCESS');
    const draft = (checks, untilReady = false) => classify(pr({ draft: true, auto: false, checks }), null, untilReady);
    const plain = draft([lint, liveTest('No live test needed')]);
    assert.equal(plain.outcome, 'idle');
    assert.equal(plain.live_test, 'not needed');
    assert.match(plain.reasons[0], /mark it ready with gh pr ready/);
    const ui = draft([lint, liveTest('Live test needed')]);
    assert.equal(ui.live_test, 'needed');
    assert.match(ui.reasons[0], /qol pr try <number>/);
    assert.equal(draft([lint, liveTest('No live test needed'), liveTest('Live test needed')]).live_test, 'needed');
    assert.equal(draft([lint, liveTest('Something else')]).live_test, null);
    assert.equal(draft([lint, liveTest('Live test needed', 'IN_PROGRESS')]).outcome, 'pending');
    assert.equal(draft([lint, liveTest('Live test needed')], true).outcome, 'pending');
    assert.equal(classify(pr({ draft: true, auto: false, checks: [run('lint', 'COMPLETED', 'FAILURE'), liveTest('No live test needed')] })).outcome, 'failed');
});

test('classify keeps a reported draft pending until it is marked ready, then asks to arm it', () => {
    const green = [run('lint', 'COMPLETED', 'SUCCESS')];
    assert.equal(classify(pr({ draft: true, auto: false, checks: green }), null, true).outcome, 'pending');
    const ready = classify(pr({ auto: false, checks: green }), null, true);
    assert.equal(ready.outcome, 'idle');
    assert.match(ready.reasons[0], /ready pull request but auto-merge is not armed; arm it with gh pr merge --auto/);
});

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
    assert.deepEqual(parseArgs(['7', '--pretty']), { target: '7', pretty: true, interval: 30, timeout: 120, untilReady: false });
    assert.equal(parseArgs(['7', '--until-ready']).untilReady, true);
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
    assert.equal(result.report.elapsed_s, 120);
    assert.equal(result.report.failures[0].log, 'error: it broke');
    assert.match(render(result.report), /PR #7 failed at abcdef123 after 120s[\s\S]*error: it broke/);
});

test('watch lets a failure a rerun replaces settle instead of ending at once', () => {
    const { now, sleep } = clock();
    const stale = pr({ checks: [run('Wait for the review', 'COMPLETED', 'FAILURE', 5)] });
    const rerun = pr({ checks: [run('Wait for the review', 'IN_PROGRESS', null, 6)] });
    const result = watch(
        { target: 'https://github.com/o/r/pull/7', interval: 30, timeout: 120 },
        { run: fakeGh([stale, stale, rerun, pr({ state: 'MERGED' })]), now, sleep },
    );
    assert.equal(result.code, EXIT.merged);
    assert.equal(result.report.elapsed_s, 90);
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

test('parseReview marks the findings a decision settled', () => {
    const review = parseReview(`${REVIEW_PASS.trimEnd()}\n\n#### Settled · 1\n\n<details><summary>Rail rows squeeze</summary>\n\nbody\n\n</details>\n`, 'https://c');
    assert.deepEqual(review.findings, [{ severity: 'settled', title: 'Rail rows squeeze', status: 'settled' }]);
    assert.equal(review.needs_you, false);
});

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

const REVIEW_SHAPES = `${REVIEW_LEFT.trimEnd()}

#### High · 2

<details><summary>Unwrap in the daemon loop</summary>

\`correctness-1\`

**Shape:** \`unwrap-in-daemon-loop\`

**Action:** use the error path

</details>

<details><summary>Wrong default</summary>

\`correctness-2\`

**Action:** change it

</details>

#### Settled · 1

<details><summary>Rail rows squeeze</summary>

\`ui-2\`

**Shape:** \`rail-rows\`

</details>
`;

test('parseReview attaches a shape to the finding it sits in and leaves the others bare', () => {
    const review = parseReview(REVIEW_SHAPES, 'https://c');
    assert.deepEqual(review.findings, [
        { severity: 'high', title: 'Unwrap in the daemon loop', status: 'open', shape: 'unwrap-in-daemon-loop' },
        { severity: 'high', title: 'Wrong default', status: 'open' },
        { severity: 'settled', title: 'Rail rows squeeze', status: 'settled', shape: 'rail-rows' },
    ]);
});

test('followUps fingerprints are stable per shape and differ between shapes, so a rule lane forks only after two pull requests', () => {
    const line = (shape, url) => followUps(EXIT.review, { url, review: { findings: [{ severity: 'high', title: 't', status: 'open', shape }] } })[0];
    const fingerprint = (text) => /--fingerprint ([0-9a-f]{16}) /.exec(text)[1];
    assert.equal(fingerprint(line('rail-rows', 'https://u/1')), fingerprint(line('rail-rows', 'https://u/2')));
    assert.notEqual(fingerprint(line('rail-rows', 'https://u/1')), fingerprint(line('other-shape', 'https://u/1')));
    assert.doesNotMatch(line('rail-rows', 'https://u/1'), /qac slip --from/);
});

test('followUps on a review prints one qac slip line per shaped finding and none for settled ones', () => {
    const verdict = classify(pr({ comments: [bot(REVIEW_SHAPES)] }), SINCE);
    const report = { pr: 7, url: 'https://github.com/o/r/pull/7', ...verdict };
    assert.equal(verdict.outcome, 'review');
    assert.deepEqual(followUps(EXIT.review, report), [
        `qac slip --fingerprint ${fingerprintOf('unwrap-in-daemon-loop')} --from https://github.com/o/r/pull/7 --route qac-check --judge review --rule "unwrap-in-daemon-loop" --message "unwrap-in-daemon-loop"`,
    ]);
});

test('followUps strips quoting characters from a shape and stays silent without shapes', () => {
    const review = { findings: [{ severity: 'high', title: 't', status: 'open', shape: 'a"b$(c)`d' }] };
    assert.deepEqual(followUps(EXIT.review, { url: 'https://u', review }), [
        `qac slip --fingerprint ${fingerprintOf('a"b$(c)`d')} --from https://u --route qac-check --judge review --rule "ab(c)d" --message "ab(c)d"`,
    ]);
    assert.deepEqual(followUps(EXIT.review, { url: 'https://u', review: { findings: [{ severity: 'high', title: 't', status: 'open' }] } }), []);
    assert.deepEqual(followUps(EXIT.review, { url: 'https://u' }), []);
});

test('followUps on a failed CI run asks the architect to record a miss from the run url', () => {
    const failures = [
        { name: 'gate', url: 'https://github.com/o/r/actions/runs/1/job/2' },
        { name: 'lint', url: 'https://github.com/o/r/actions/runs/1/job/3' },
    ];
    assert.deepEqual(
        followUps(EXIT.failed, { url: 'https://u', failures }),
        ['If the local gate had passed, record the miss: qac slip --from https://github.com/o/r/actions/runs/1/job/3 "<what slipped>"'],
    );
    assert.equal(followUps(EXIT.failed, { failures: [failures[0]] })[0].includes('/job/2'), true);
    assert.deepEqual(followUps(EXIT.failed, { failures: [] }), []);
    assert.deepEqual(followUps(EXIT.failed, { failures: [{ name: 'lint' }] }), []);
});

test('followUps prints nothing for any other exit', () => {
    for (const code of [EXIT.merged, EXIT.usage, EXIT.missing, EXIT.gh, EXIT.timeout, EXIT.idle]) {
        assert.deepEqual(followUps(code, { url: 'u', failures: [{ name: 'x', url: 'y' }], review: { findings: [{ severity: 'high', shape: 's' }] } }), []);
    }
});
