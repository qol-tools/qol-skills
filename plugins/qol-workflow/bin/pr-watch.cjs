#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');

const EXIT = { merged: 0, failed: 1, usage: 2, missing: 3, gh: 4, timeout: 5, idle: 6 };
const FAILED_CONCLUSIONS = new Set(['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']);
const FAILED_STATES = new Set(['FAILURE', 'ERROR']);
const AGGREGATE_JOB = /gate/i;
const LOG_LINES = 40;
const LOG_JOBS = 3;
const GH_RETRIES = 5;
const ANSI = /\x1b\[[0-9;]*m/g;
const LOG_NOISE = /^##\[(end)?group\]/;

const QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){
number url state isInMergeQueue mergeStateStatus autoMergeRequest{enabledAt}
commits(last:1){nodes{commit{oid committedDate statusCheckRollup{contexts(first:100){nodes{__typename
... on CheckRun{name status conclusion detailsUrl}
... on StatusContext{context state targetUrl}}}}}}}
timelineItems(last:1,itemTypes:[ADDED_TO_MERGE_QUEUE_EVENT,REMOVED_FROM_MERGE_QUEUE_EVENT]){nodes{__typename
... on RemovedFromMergeQueueEvent{reason createdAt}}}}}}`;

const HELP = `usage: pr-watch [<pr-url-or-number>] [--pretty] [--interval <s>] [--timeout <min>]
Blocks until the pull request merges or fails, then exits once.
Exit: 0 merged, 1 failed, 2 usage, 3 no pull request, 4 gh error, 5 timeout, 6 idle.`;

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

function classify(pr) {
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
    if (reasons.length > 0) return { ...base, outcome: 'failed', reasons, failures };

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
    if (report.error) lines.push(report.error);
    return lines.join('\n');
}

function wait(seconds) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, seconds * 1000);
}

function watch(opts, { run = gh, sleep = wait, now = Date.now } = {}) {
    const started = now();
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
            const verdict = classify(snapshot.pr);
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

module.exports = { classify, parseArgs, parseTarget, resolveTarget, attachLogs, cleanLogLine, render, watch, EXIT };

if (require.main === module) {
    process.exit(main(process.argv.slice(2)));
}
