#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

const EXIT = { merged: 0, failed: 1, usage: 2, missing: 3, gh: 4, timeout: 5, idle: 6, review: 7 };
const FAILED_CONCLUSIONS = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const FAILED_STATES = new Set(['FAILURE', 'ERROR']);
const AGGREGATE_JOB = /gate/i;
const LOG_LINES = 40;
const LOG_JOBS = 3;
const GH_RETRIES = 5;
const SETTLE_SECONDS = 120;
const QUEUE_STATUS = 'merge queue';
const ANSI = /\x1b\[[0-9;]*m/g;
const LOG_NOISE = /^##\[(end)?group\]/;
const REVIEW_MARKERS = { '<!-- qol-code-review -->': 'review', '<!-- qol-queue-fix -->': 'queue fix' };
const REVIEW_AUTHOR = 'github-actions';
const FIX_COMMIT = /\/commit\/([0-9a-f]{40})\)/;
const LEFT_FOR_YOU = /(\d+) left for you/;
const REVIEW_FAILED = /Review failed|Fixing failed|outside this pull request|Nothing was changed/;
const SHAPE_LINE = /^\*\*Shape:\*\* `([^`]+)`/;
const LIVE_TEST_CHECK = 'live test';
const LIVE_TEST_TITLES = { 'Live test needed': 'needed', 'No live test needed': 'not needed' };
const DRAFT_REASONS = {
    'not needed': 'checks and review pass on a draft and the live test check found nothing to test by hand: mark it ready with gh pr ready, then watch it again',
    needed: 'checks and review pass on a draft and the live test check lists files a person must see working: test the change end to end in a guest (qol-project:qol-dev-environments); when it works, mark it ready with gh pr ready and watch it again; when it does not, fix it, push and watch again',
    unknown: 'checks are green on a draft with no live test check: design work waiting for the user\'s approval; leave auto-merge off, report it to your parent, then park again with --until-ready',
};

const QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
number url state isDraft isInMergeQueue mergeStateStatus autoMergeRequest{enabledAt}
commits(last:1){nodes{commit{oid committedDate statusCheckRollup{contexts(first:100){nodes{__typename
... on CheckRun{name title status conclusion detailsUrl checkSuite{workflowRun{databaseId workflow{databaseId}}}}
... on StatusContext{context state description targetUrl createdAt}}}}}}}
timelineItems(last:1,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT]){nodes{__typename
... on AddedToMergeQueueEvent{createdAt} ... on RemovedFromMergeQueueEvent{reason createdAt}}}
comments(last:20){nodes{author{__typename login} body createdAt url}}}}}`;

const HELP = `usage: pr-watch [<pr-url-or-number>] [--pretty] [--interval <s>] [--timeout <min>] [--until-ready]
Blocks until the pull request merges or fails, then exits once.
A draft with green checks exits 6 with live_test read from the "live test" check: "not needed"
says to mark it ready, "needed" says to test it end to end first, and null (no such check)
means design work waiting for the user; --until-ready keeps watching a draft until it is
marked ready, for a re-park after that report.
A failed merge queue status posted since the pull request was last queued ends the watch
even while GitHub still holds the entry. Checks from an older run of a workflow are ignored
once a newer run of it reports, and a failure seen in the first 120 s ends the watch only if
it still holds then, so checks a rerun is about to replace do not end it.
Exit: 0 merged, 1 failed, 2 usage, 3 no pull request, 4 gh error, 5 timeout, 6 idle, 7 review needs you.`;

function gh(args) {
    const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
        return { ok: false, error: (result.stderr || String(result.error || '')).trim() };
    }
    return { ok: true, stdout: result.stdout };
}

function parseArgs(argv) {
    const opts = { target: null, pretty: false, interval: 30, timeout: 120, untilReady: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--pretty') opts.pretty = true;
        else if (arg === '--until-ready') opts.untilReady = true;
        else if (arg === '--interval') opts.interval = Number(argv[++i]);
        else if (arg === '--timeout') opts.timeout = Number(argv[++i]);
        else if (arg === '-h' || arg === '--help') return { help: true };
        else if (arg.startsWith('-') || opts.target !== null) return { error: `unexpected argument: ${arg}` };
        else opts.target = arg;
    }
    if (!(opts.interval > 0) || !(opts.timeout > 0)) return { error: '--interval and --timeout take positive numbers' };
    return opts;
}

function parseTarget(target) {
    const url = /github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/.exec(target ?? '');
    if (url) return { owner: url[1], name: url[2], number: Number(url[3]) };
    if (/^#?\d+$/.test(target ?? '')) return { number: Number(target.replace('#', '')) };
    return null;
}

function resolveTarget(target, run) {
    if (target === null) {
        const view = run(['pr', 'view', '--json', 'url']);
        if (!view.ok) return { error: 'no pull request for the current branch', code: EXIT.missing };
        return resolveTarget(JSON.parse(view.stdout).url, run);
    }
    const parsed = parseTarget(target);
    if (!parsed) return { error: `not a pull request URL or number: ${target}`, code: EXIT.usage };
    if (parsed.owner) return parsed;
    const repo = run(['repo', 'view', '--json', 'owner,name']);
    if (!repo.ok) return { error: `cannot resolve the repository: ${repo.error}`, code: EXIT.gh };
    const { owner, name } = JSON.parse(repo.stdout);
    return { owner: owner.login, name, number: parsed.number };
}

function fetchSnapshot(target, run) {
    const result = run([
        'api', 'graphql', '-f', `query=${QUERY}`,
        '-F', `owner=${target.owner}`, '-F', `name=${target.name}`, '-F', `number=${target.number}`,
    ]);
    if (!result.ok) return { error: result.error };
    const pr = JSON.parse(result.stdout)?.data?.repository?.pullRequest;
    if (!pr) return { error: `pull request ${target.number} not found` };
    return { pr };
}

function checksOf(commit, queued, enqueuedAt) {
    const stale = (node) => queued && node.__typename === 'StatusContext' && node.context === QUEUE_STATUS
        && !(enqueuedAt && node.createdAt >= enqueuedAt);
    const nodes = (commit?.statusCheckRollup?.contexts?.nodes ?? []).filter((node) => !stale(node));
    const runOf = (node) => node.checkSuite?.workflowRun;
    const newest = new Map();
    for (const run of nodes.map(runOf).filter((run) => run?.workflow)) {
        newest.set(run.workflow.databaseId, Math.max(newest.get(run.workflow.databaseId) ?? 0, run.databaseId));
    }
    const replaced = (node) => Boolean(runOf(node)?.workflow) && runOf(node).databaseId < newest.get(runOf(node).workflow.databaseId);
    const superseded = (node) => node.__typename === 'CheckRun' && node.conclusion === 'CANCELLED'
        && nodes.some((other) => other.__typename === 'CheckRun' && other.name === node.name && other.conclusion !== 'CANCELLED');
    return nodes.filter((node) => !replaced(node) && !superseded(node)).map((node) => (node.__typename === 'CheckRun'
        ? {
            name: node.name,
            url: node.detailsUrl,
            done: node.status === 'COMPLETED',
            failed: node.status === 'COMPLETED' && FAILED_CONCLUSIONS.has(node.conclusion),
        }
        : {
            name: node.context === QUEUE_STATUS && node.description ? `${node.context} (${node.description})` : node.context,
            url: node.targetUrl,
            done: node.state !== 'PENDING' && node.state !== 'EXPECTED',
            failed: FAILED_STATES.has(node.state),
        }));
}

function queueRemoval(pr, commit) {
    const event = pr.timelineItems?.nodes?.[0];
    if (event?.__typename !== 'RemovedFromMergeQueueEvent' || pr.isInMergeQueue || /^merged$/i.test(event.reason || '')) return null;
    if (commit.committedDate && event.createdAt < commit.committedDate) return null;
    if (pr.autoMergeRequest?.enabledAt && event.createdAt < pr.autoMergeRequest.enabledAt) return null;
    return `removed from the merge queue: ${event.reason || 'no reason given'}`;
}

function unescapeHtml(text) {
    return text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function parseReview(body, url) {
    const marker = Object.keys(REVIEW_MARKERS).find((key) => body.startsWith(key));
    if (!marker) return null;
    const alert = body.split('\n').filter((line) => line.startsWith('> ') && !line.startsWith('> [!'));
    const summary = alert
        .map((line) => line.slice(2).replace(/\*\*/g, '').replace(/\[`([0-9a-f]+)`\]\([^)]*\)/g, '$1').trim());
    const findings = [];
    let severity = null;
    for (const line of body.split('\n')) {
        const lane = /^#### (\w+) · \d+$/.exec(line);
        if (lane) severity = lane[1].toLowerCase();
        const item = /^<details><summary>(.*?)(?: <code>(fixed|skipped)<\/code>)?<\/summary>/.exec(line);
        if (item && severity && item[1] !== 'Full review') {
            findings.push({ severity, title: unescapeHtml(item[1]), status: item[2] || (severity === 'settled' ? 'settled' : 'open') });
        }
        const shape = SHAPE_LINE.exec(line)?.[1];
        if (shape && findings.length > 0) findings[findings.length - 1].shape = shape;
    }
    const left = Number(LEFT_FOR_YOU.exec(body)?.[1] ?? 0);
    const fixCommit = FIX_COMMIT.exec(alert.join('\n'))?.[1] ?? null;
    const failed = REVIEW_FAILED.test(summary.join('\n'));
    return { kind: REVIEW_MARKERS[marker], url, summary, findings, left, fix_commit: fixCommit, needs_you: left > 0 || failed || fixCommit !== null };
}

function isReviewBot(author) {
    return author?.__typename === 'Bot' && author.login === REVIEW_AUTHOR;
}

function latestReview(pr, since) {
    const comments = (pr.comments?.nodes ?? [])
        .filter((node) => isReviewBot(node.author) && (!since || node.createdAt >= since));
    for (const node of comments.reverse()) {
        const review = parseReview(node.body ?? '', node.url);
        if (review) return review;
    }
    return null;
}

function liveTestOf(commit) {
    const runs = (commit?.statusCheckRollup?.contexts?.nodes ?? [])
        .filter((node) => node.__typename === 'CheckRun' && node.name === LIVE_TEST_CHECK && node.status === 'COMPLETED');
    return LIVE_TEST_TITLES[runs[runs.length - 1]?.title] ?? null;
}

function classify(pr, since = null, untilReady = false) {
    const commit = pr.commits?.nodes?.[0]?.commit ?? {};
    const base = { head: commit.oid ?? null, reasons: [], failures: [] };
    if (pr.state === 'MERGED') return { ...base, outcome: 'merged' };
    if (pr.state === 'CLOSED') return { ...base, outcome: 'failed', reasons: ['closed without merging'] };

    const event = pr.timelineItems?.nodes?.[0];
    const enqueuedAt = event?.__typename === 'AddedToMergeQueueEvent' ? event.createdAt : null;
    const checks = checksOf(commit, pr.isInMergeQueue, enqueuedAt);
    const failures = checks.filter((check) => check.failed).map(({ name, url }) => ({ name, url }));
    const reasons = failures.map((failure) => `check failed: ${failure.name}`);
    if (pr.mergeStateStatus === 'DIRTY') reasons.push('merge conflict with the base branch');
    const removal = queueRemoval(pr, commit);
    if (removal) reasons.push(removal);
    const review = latestReview(pr, since);
    const actionable = review?.needs_you ? { review } : {};
    if (reasons.length > 0) return { ...base, outcome: 'failed', reasons, failures, ...actionable };
    if (review?.needs_you) return { ...base, outcome: 'review', reasons: [`${review.kind}: ${review.summary.join(' ')}`], review };

    const settled = checks.length > 0 && checks.every((check) => check.done);
    if (settled && pr.isDraft && !untilReady) {
        const liveTest = liveTestOf(commit);
        return { ...base, outcome: 'idle', live_test: liveTest, reasons: [DRAFT_REASONS[liveTest ?? 'unknown']] };
    }
    if (settled && !pr.isDraft && !pr.autoMergeRequest && !pr.isInMergeQueue) {
        return { ...base, outcome: 'idle', reasons: ['checks are green on a ready pull request but auto-merge is not armed; arm it with gh pr merge --auto'] };
    }
    return { ...base, outcome: 'pending' };
}

function cleanLogLine(line) {
    const message = line.split('\t').pop();
    return message.replace(/^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(ANSI, '');
}

function failureLog(failure, run) {
    const job = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(failure.url ?? '');
    if (!job) return null;
    const result = run(['run', 'view', job[1], '--job', job[2], '--log-failed']);
    if (!result.ok) return null;
    const lines = result.stdout.split('\n').filter(Boolean).map(cleanLogLine)
        .filter((line) => !LOG_NOISE.test(line));
    return lines.slice(-LOG_LINES).join('\n');
}

function attachLogs(failures, run) {
    const informative = failures.filter((failure) => !AGGREGATE_JOB.test(failure.name));
    const chosen = new Set((informative.length > 0 ? informative : failures).slice(0, LOG_JOBS));
    return failures.map((failure) => (chosen.has(failure) ? { ...failure, log: failureLog(failure, run) } : failure));
}

function renderReview(review) {
    const lines = [`--- ${review.kind} comment: ${review.url}`, ...review.summary];
    for (const finding of review.findings) lines.push(`  [${finding.severity}, ${finding.status}] ${finding.title}`);
    if (review.fix_commit) lines.push(`The bot pushed ${review.fix_commit.slice(0, 9)} to the branch: pull it before your next push.`);
    return lines;
}

function render(report) {
    const head = report.head ? ` at ${report.head.slice(0, 9)}` : '';
    const lines = [`PR #${report.pr} ${report.outcome}${head} after ${report.elapsed_s ?? 0}s`];
    if (report.url) lines.push(report.url);
    for (const reason of report.reasons) lines.push(`- ${reason}`);
    for (const failure of report.failures) {
        if (failure.url) lines.push(`  ${failure.name}: ${failure.url}`);
    }
    for (const failure of report.failures) {
        if (failure.log) lines.push(`--- ${failure.name}, last lines of the failed steps`, failure.log);
    }
    if (report.review) lines.push(...renderReview(report.review));
    if (report.error) lines.push(report.error);
    return lines.join('\n');
}

function slipArgument(text) {
    return `"${String(text).replace(/["\\$`]/g, '').trim()}"`;
}

function shapeFingerprint(shape) {
    return createHash('sha256').update(`review\n${shape}`).digest('hex').slice(0, 16);
}

function followUps(code, report) {
    if (code === EXIT.review) {
        const from = report.url ?? report.review?.url;
        return (report.review?.findings ?? [])
            .filter((finding) => finding.shape && finding.severity !== 'settled')
            .map((finding) => `qac slip --fingerprint ${shapeFingerprint(finding.shape)} --from ${from} --route qac-check --judge review --rule ${slipArgument(finding.shape)} --message ${slipArgument(finding.shape)}`);
    }
    if (code === EXIT.failed) {
        const failures = (report.failures ?? []).filter((failure) => failure.url);
        const run = failures.find((failure) => !AGGREGATE_JOB.test(failure.name)) ?? failures[0];
        if (!run) return [];
        return [`If the local gate had passed, record the miss: qac slip --from ${run.url} "<what slipped>"`];
    }
    return [];
}

function wait(seconds) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

function watch(opts, { run = gh, sleep = wait, now = Date.now } = {}) {
    const started = now();
    const since = new Date(started).toISOString();
    const target = resolveTarget(opts.target, run);
    if (target.error) {
        return { code: target.code, report: { pr: opts.target, outcome: 'error', reasons: [], failures: [], error: target.error } };
    }

    let errors = 0;
    for (;;) {
        const elapsed = Math.round((now() - started) / 1000);
        const snapshot = fetchSnapshot(target, run);
        if (snapshot.error) {
            errors += 1;
            if (errors >= GH_RETRIES) {
                return {
                    code: EXIT.gh,
                    report: { pr: target.number, outcome: 'error', reasons: [], failures: [], error: snapshot.error, elapsed_s: elapsed },
                };
            }
        } else {
            errors = 0;
            const verdict = classify(snapshot.pr, since, opts.untilReady);
            const settling = verdict.outcome === 'failed' && elapsed < SETTLE_SECONDS;
            if (verdict.outcome !== 'pending' && !settling) {
                const failures = attachLogs(verdict.failures, run);
                return {
                    code: EXIT[verdict.outcome],
                    report: { pr: target.number, url: snapshot.pr.url, ...verdict, failures, elapsed_s: elapsed },
                };
            }
        }
        if (elapsed >= opts.timeout * 60) {
            return {
                code: EXIT.timeout,
                report: {
                    pr: target.number, outcome: 'timeout', head: null,
                    reasons: [`still pending after ${opts.timeout} minutes`], failures: [], elapsed_s: elapsed,
                },
            };
        }
        sleep(opts.interval);
    }
}

function main(argv) {
    const opts = parseArgs(argv);
    if (opts.help) {
        process.stdout.write(`${HELP}\n`);
        return 0;
    }
    if (opts.error) {
        process.stderr.write(`${opts.error}\n${HELP}\n`);
        return EXIT.usage;
    }
    const { code, report } = watch(opts);
    process.stdout.write(`${opts.pretty ? render(report) : JSON.stringify(report)}\n`);
    for (const line of followUps(code, report)) process.stderr.write(`${line}\n`);
    return code;
}

module.exports = { classify, parseReview, parseArgs, parseTarget, resolveTarget, attachLogs, cleanLogLine, render, watch, followUps, EXIT, SETTLE_SECONDS };

if (require.main === module) {
    process.exit(main(process.argv.slice(2)));
}
