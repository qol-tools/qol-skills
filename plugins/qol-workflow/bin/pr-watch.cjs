#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

const EXIT = { merged: 0, failed: 1, usage: 2, missing: 3, gh: 4, timeout: 5, idle: 6, review: 7 };
const FAILED_CONCLUSIONS = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const FAILED_STATES = new Set(['FAILURE', 'ERROR']);
const AGGREGATE_JOB = /gate/i;
const LOG_LINES = 40;
const LOG_JOBS = 3;
const GH_RETRIES = 5;
const ANSI = /\x1b\[[0-9;]*m/g;
const LOG_NOISE = /^##\[(end)?group\]/;
const REVIEW_MARKERS = { '<!-- qol-code-review -->': 'review', '<!-- qol-queue-fix -->': 'queue fix' };
const REVIEW_AUTHOR = 'github-actions';
const FIX_COMMIT = /\/commit\/([0-9a-f]{40})\)/;
const LEFT_FOR_YOU = /(\d+) left for you/;
const REVIEW_FAILED = /Review failed|Fixing failed|outside this pull request|Nothing was changed/;

const QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
number url state isInMergeQueue mergeStateStatus autoMergeRequest{enabledAt}
commits(last:1){nodes{commit{oid committedDate statusCheckRollup{contexts(first:100){nodes{__typename
... on CheckRun{name status conclusion detailsUrl}
... on StatusContext{context state targetUrl}}}}}}}
timelineItems(last:1,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT]){nodes{__typename
... on RemovedFromMergeQueueEvent{reason createdAt}}}
comments(last:20){nodes{author{__typename login} body createdAt url}}}}}`;

const HELP = `usage: pr-watch [<pr-url-or-number>] [--pretty] [--interval <s>] [--timeout <min>]
Blocks until the pull request merges or fails, then exits once.
Exit: 0 merged, 1 failed, 2 usage, 3 no pull request, 4 gh error, 5 timeout, 6 idle, 7 review needs you.`;

function gh(args) {
    const result = spawnSync('gh', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
        return { ok: false, error: (result.stderr || String(result.error || '')).trim() };
    }
    return { ok: true, stdout: result.stdout };
}

function parseArgs(argv) {
    const opts = { target: null, pretty: false, interval: 30, timeout: 120 };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--pretty') opts.pretty = true;
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

function checksOf(commit) {
    const nodes = commit?.statusCheckRollup?.contexts?.nodes ?? [];
    return nodes.map((node) => (node.__typename === 'CheckRun'
        ? {
            name: node.name,
            url: node.detailsUrl,
            done: node.status === 'COMPLETED',
            failed: node.status === 'COMPLETED' && FAILED_CONCLUSIONS.has(node.conclusion),
        }
        : {
            name: node.context,
            url: node.targetUrl,
            done: node.state !== 'PENDING' && node.state !== 'EXPECTED',
            failed: FAILED_STATES.has(node.state),
        }));
}

function queueRemoval(pr, commit) {
    const event = pr.timelineItems?.nodes?.[0];
    if (event?.__typename !== 'RemovedFromMergeQueueEvent' || pr.isInMergeQueue) return null;
    if (commit.committedDate && event.createdAt < commit.committedDate) return null;
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
            findings.push({ severity, title: unescapeHtml(item[1]), status: item[2] || 'open' });
        }
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

function classify(pr, since = null) {
    const commit = pr.commits?.nodes?.[0]?.commit ?? {};
    const base = { head: commit.oid ?? null, reasons: [], failures: [] };
    if (pr.state === 'MERGED') return { ...base, outcome: 'merged' };
    if (pr.state === 'CLOSED') return { ...base, outcome: 'failed', reasons: ['closed without merging'] };

    const checks = checksOf(commit);
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
    if (settled && !pr.autoMergeRequest && !pr.isInMergeQueue) {
        return { ...base, outcome: 'idle', reasons: ['checks are green but auto-merge is not armed'] };
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
            const verdict = classify(snapshot.pr, since);
            if (verdict.outcome !== 'pending') {
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
    return code;
}

module.exports = { classify, parseReview, parseArgs, parseTarget, resolveTarget, attachLogs, cleanLogLine, render, watch, EXIT };

if (require.main === module) {
    process.exit(main(process.argv.slice(2)));
}
