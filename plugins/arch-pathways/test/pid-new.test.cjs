'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const pidNew = require('../bin/pid-new.cjs');

function makeWorkspace(repos = ['qol-tray']) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pid-new-test-'));
    fs.mkdirSync(path.join(root, 'qol-skills'), { recursive: true });
    for (const repo of repos) {
        fs.mkdirSync(path.join(root, repo, '.git'), { recursive: true });
    }
    return root;
}

function makeRunner(responses) {
    const calls = [];
    function runner(opts) {
        calls.push({
            cmd: opts.cmd,
            args: opts.args.slice(),
            cwd: opts.cwd,
        });
        for (const r of responses) {
            if (r.match(opts)) return r.respond ? r.respond(opts) : r.result;
        }
        return { stdout: '', stderr: '', code: 0 };
    }
    runner.calls = calls;
    return runner;
}

function captureLog() {
    const lines = [];
    return { log: msg => lines.push(msg), lines };
}

test('parseArgs reads positional + flags', () => {
    const cases = [
        [['qol-tray', 'Foo Bar'], { positional: ['qol-tray', 'Foo Bar'] }],
        [['--dry-run', 'qol-tray', 'Foo'], { positional: ['qol-tray', 'Foo'], dryRun: true }],
        [['qol-tray', 'Foo', '--issue', '42'], { positional: ['qol-tray', 'Foo'], issue: 42 }],
        [['qol-tray', 'Foo', '--base', 'develop'], { positional: ['qol-tray', 'Foo'], base: 'develop' }],
        [['qol-tray', 'Foo', '--workspace', '/x'], { positional: ['qol-tray', 'Foo'], workspace: '/x' }],
        [['--help'], { positional: [], help: true }],
        [['-h'], { positional: [], help: true }],
    ];
    for (const [argv, expected] of cases) {
        assert.deepStrictEqual(pidNew.parseArgs(argv), expected, `argv: ${argv.join(' ')}`);
    }
});

test('parseArgs throws on unknown flag', () => {
    assert.throws(() => pidNew.parseArgs(['--bogus']), /unknown flag/);
});

test('resolveWorkspace prefers explicit, then env, then walk-up', () => {
    const root = makeWorkspace();
    const sub = path.join(root, 'qol-tray', 'src', 'deep');
    fs.mkdirSync(sub, { recursive: true });

    assert.strictEqual(pidNew.resolveWorkspace('/explicit', {}, root, fs), '/explicit');
    assert.strictEqual(pidNew.resolveWorkspace(null, { QOL_WORKSPACE_ROOT: '/from-env' }, root, fs), '/from-env');
    assert.strictEqual(pidNew.resolveWorkspace(null, {}, sub, fs), root);

    const orphan = fs.mkdtempSync(path.join(os.tmpdir(), 'pid-new-orphan-'));
    assert.throws(() => pidNew.resolveWorkspace(null, {}, orphan, fs), /cannot resolve workspace/);
});

test('renderAdr substitutes placeholders globally', () => {
    const template = `# {PID} {Title Case Slug}

- **Closes:** #{issue_number}
- **Date:** {YYYY-MM-DD}

| ID | smell |
|----|-------|
| {PID}.1 | foo |
| {PID}.2 | bar |
`;
    const out = pidNew.renderAdr(template, {
        pidStr: 'TRAY-42',
        issueNumber: 42,
        slug: 'fold-installs',
        title: 'Fold Installs',
        today: '2026-05-03',
    });
    assert.match(out, /^# TRAY-42 Fold Installs/);
    assert.match(out, /\*\*Closes:\*\* #42/);
    assert.match(out, /\*\*Date:\*\* 2026-05-03/);
    assert.match(out, /\| TRAY-42\.1 \|/);
    assert.match(out, /\| TRAY-42\.2 \|/);
    assert.doesNotMatch(out, /\{PID\}/);
    assert.doesNotMatch(out, /\{issue_number\}/);
});

test('buildIssueBody falls back to a placeholder when no problem statement is given', () => {
    const body = pidNew.buildIssueBody('TRAY-42', 'fold-installs');
    assert.match(body, /docs\/adr\/TRAY-42-fold-installs\.md/);
    assert.doesNotMatch(body, /---/);
});

test('buildIssueBody includes the problem statement above the ADR link', () => {
    const problem = '## Problem\n\nSupervisor crashes on cold boot.\n\n```mermaid\ngraph LR\n    A --> B\n```';
    const body = pidNew.buildIssueBody('TRAY-42', 'fold-installs', problem);
    assert.ok(body.startsWith('## Problem'), 'problem statement must lead the body');
    assert.match(body, /```mermaid/);
    assert.match(body, /---/);
    assert.match(body, /docs\/adr\/TRAY-42-fold-installs\.md/);
});

test('buildIssueBody and buildPrBody are wired to PID + slug', () => {
    assert.match(pidNew.buildIssueBody('TRAY-42', 'fold-installs'), /docs\/adr\/TRAY-42-fold-installs\.md/);
    const body = pidNew.buildPrBody('TRAY-42', 'fold-installs', 42);
    assert.match(body, /Closes #42/);
    assert.match(body, /docs\/adr\/TRAY-42-fold-installs\.md/);
});

test('buildPrBody emits an absolute branch-pinned URL when ownerRepo+branch are provided', () => {
    const body = pidNew.buildPrBody('TRAY-42', 'boot', 42, 'qol-tools/qol-tray', 'tray-42-boot');
    assert.match(body, /Closes #42/);
    assert.match(body, /https:\/\/github\.com\/qol-tools\/qol-tray\/blob\/tray-42-boot\/docs\/adr\/TRAY-42-boot\.md/);
    assert.doesNotMatch(body, /\(docs\/adr\/TRAY-42-boot\.md\)/);
});

test('buildPrBody falls back to relative path when ownerRepo or branch is missing', () => {
    const body = pidNew.buildPrBody('TRAY-42', 'boot', 42);
    assert.match(body, /\(docs\/adr\/TRAY-42-boot\.md\)/);
});

test('formatDryRunPlan and formatSummary include all key fields', () => {
    const plan = pidNew.formatDryRunPlan({
        repo: 'qol-tray',
        pidStr: 'TRAY-999',
        branch: 'tray-999-foo',
        worktreePath: '/ws/worktrees/qol-tray/tray-999-foo',
        adrPath: '/ws/worktrees/qol-tray/tray-999-foo/docs/adr/TRAY-999-foo.md',
        prTitle: 'TRAY-999 Foo',
        baseBranch: 'main',
    });
    for (const needle of ['qol-tray', 'TRAY-999', 'tray-999-foo', '/docs/adr/TRAY-999-foo.md', 'main']) {
        assert.ok(plan.includes(needle), `dry-run plan missing: ${needle}`);
    }
    const summary = pidNew.formatSummary({
        pidStr: 'TRAY-42',
        worktreePath: '/ws/worktrees/qol-tray/tray-42-foo',
        prUrl: 'https://github.com/x/y/pull/123',
    });
    for (const needle of ['TRAY-42', 'tray-42-foo', 'pull/123']) {
        assert.ok(summary.includes(needle), `summary missing: ${needle}`);
    }
});

test('today returns YYYY-MM-DD', () => {
    assert.match(pidNew.today(), /^\d{4}-\d{2}-\d{2}$/);
});

test('run --dry-run plans without invoking gh issue create', () => {
    const root = makeWorkspace();
    const { log, lines } = captureLog();
    const runner = makeRunner([
        {
            match: o => o.cmd === 'git' && o.args[0] === 'symbolic-ref',
            result: { stdout: 'origin/main\n', stderr: '', code: 0 },
        },
    ]);
    const code = pidNew.run({
        argv: ['--dry-run', 'qol-tray', 'Fold Installs Into Config Dir'],
        env: {},
        cwd: root,
        runner,
        fs,
        log,
    });
    assert.strictEqual(code, 0);
    assert.ok(lines.join('\n').includes('TRAY-999'), 'dry-run uses placeholder issue 999');
    assert.ok(lines.join('\n').includes('tray-999-fold-installs-into-config-dir'));
    const ghCalls = runner.calls.filter(c => c.cmd === 'gh');
    assert.deepStrictEqual(ghCalls, [], 'dry-run must not invoke gh');
});

test('run executes full pipeline in correct order with mocked runner', () => {
    const root = makeWorkspace();
    const { log, lines } = captureLog();
    const runner = makeRunner([
        {
            match: o => o.cmd === 'git' && o.args[0] === 'symbolic-ref',
            result: { stdout: 'origin/main\n', stderr: '', code: 0 },
        },
        {
            match: o => o.cmd === 'gh' && o.args[0] === 'issue' && o.args[1] === 'create',
            result: { stdout: 'https://github.com/foo/qol-tray/issues/42\n', stderr: '', code: 0 },
        },
        {
            match: o => o.cmd === 'gh' && o.args[0] === 'pr' && o.args[1] === 'create',
            result: { stdout: 'https://github.com/foo/qol-tray/pull/77\n', stderr: '', code: 0 },
        },
    ]);

    const code = pidNew.run({
        argv: ['qol-tray', 'Fold Installs Into Config Dir'],
        env: {},
        cwd: root,
        runner,
        fs,
        log,
    });
    assert.strictEqual(code, 0);

    const sequence = runner.calls.map(c => {
        if (c.cmd === 'gh') return `gh ${c.args[0]} ${c.args[1]}`;
        if (c.cmd === 'git') return c.args[0] === 'worktree'
            ? `git worktree ${c.args[1]}`
            : `git ${c.args[0]}`;
        return c.cmd;
    });
    assert.deepStrictEqual(sequence, [
        'git symbolic-ref',
        'gh issue create',
        'git fetch',
        'git worktree add',
        'git add',
        'git commit',
        'git push',
        'git remote',
        'gh pr create',
    ], 'pipeline must run in fixed order');

    const expectedBranch = 'tray-42-fold-installs-into-config-dir';
    const expectedWorktree = path.join(root, 'worktrees', 'qol-tray', expectedBranch);
    const expectedAdr = path.join(expectedWorktree, 'docs', 'adr', `TRAY-42-${expectedBranch.split('-').slice(2).join('-')}.md`);

    assert.ok(fs.existsSync(expectedAdr), `ADR not written at ${expectedAdr}`);
    const adrBody = fs.readFileSync(expectedAdr, 'utf8');
    assert.match(adrBody, /^# TRAY-42 Fold Installs Into Config Dir/);
    assert.match(adrBody, /\*\*Closes:\*\* #42/);
    assert.match(adrBody, /TRAY-42\.1/);

    const summary = lines.join('\n');
    assert.ok(summary.includes('TRAY-42'), 'summary should include PID');
    assert.ok(summary.includes('pull/77'), 'summary should include PR URL');
});

test('run with --issue skips gh issue create', () => {
    const root = makeWorkspace();
    const { log } = captureLog();
    const runner = makeRunner([
        {
            match: o => o.cmd === 'git' && o.args[0] === 'symbolic-ref',
            result: { stdout: 'origin/main\n', stderr: '', code: 0 },
        },
        {
            match: o => o.cmd === 'gh' && o.args[0] === 'pr' && o.args[1] === 'create',
            result: { stdout: 'https://github.com/foo/qol-tray/pull/99\n', stderr: '', code: 0 },
        },
    ]);
    pidNew.run({
        argv: ['--issue', '42', 'qol-tray', 'Foo Bar'],
        env: {},
        cwd: root,
        runner,
        fs,
        log,
    });
    const issueCreates = runner.calls.filter(c => c.cmd === 'gh' && c.args[0] === 'issue' && c.args[1] === 'create');
    assert.strictEqual(issueCreates.length, 0, '--issue must skip issue creation');
    const prCreate = runner.calls.find(c => c.cmd === 'gh' && c.args[0] === 'pr' && c.args[1] === 'create');
    assert.ok(prCreate, 'pr create still happens');
    const titleIdx = prCreate.args.indexOf('--title');
    assert.strictEqual(prCreate.args[titleIdx + 1], 'TRAY-42 Foo Bar');
});

test('run errors on non-git repo dir', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pid-new-empty-'));
    fs.mkdirSync(path.join(root, 'qol-skills'), { recursive: true });
    fs.mkdirSync(path.join(root, 'qol-tray'), { recursive: true });
    const runner = makeRunner([]);
    assert.throws(
        () => pidNew.run({
            argv: ['--dry-run', 'qol-tray', 'Foo'],
            env: {},
            cwd: root,
            runner,
            fs,
            log: () => {},
        }),
        /not a git repo/,
    );
});

test('run errors when title is missing', () => {
    const root = makeWorkspace();
    assert.throws(
        () => pidNew.run({
            argv: ['qol-tray'],
            env: {},
            cwd: root,
            runner: makeRunner([]),
            fs,
            log: () => {},
        }),
        /two positional args/,
    );
});

test('run errors when repo not in prefixes.json', () => {
    const root = makeWorkspace(['unknown-repo']);
    assert.throws(
        () => pidNew.run({
            argv: ['--dry-run', 'unknown-repo', 'Foo'],
            env: {},
            cwd: root,
            runner: makeRunner([]),
            fs,
            log: () => {},
        }),
        /unknown repo/,
    );
});

test('run executes .qol/worktree-init.sh when present', () => {
    const root = makeWorkspace();
    fs.mkdirSync(path.join(root, 'qol-tray', '.qol'), { recursive: true });
    fs.writeFileSync(path.join(root, 'qol-tray', '.qol', 'worktree-init.sh'), '#!/usr/bin/env bash\necho ok\n');
    const runner = makeRunner([
        {
            match: o => o.cmd === 'git' && o.args[0] === 'symbolic-ref',
            result: { stdout: 'origin/main\n', stderr: '', code: 0 },
        },
        {
            match: o => o.cmd === 'gh' && o.args[0] === 'issue' && o.args[1] === 'create',
            result: { stdout: 'https://github.com/foo/qol-tray/issues/42\n', stderr: '', code: 0 },
        },
        {
            match: o => o.cmd === 'gh' && o.args[0] === 'pr' && o.args[1] === 'create',
            result: { stdout: 'https://github.com/foo/qol-tray/pull/77\n', stderr: '', code: 0 },
        },
    ]);
    pidNew.run({
        argv: ['qol-tray', 'Foo Bar'],
        env: {}, cwd: root, runner, fs, log: () => {},
    });
    const initCall = runner.calls.find(c => c.cmd === 'bash' && c.args[0].endsWith('worktree-init.sh'));
    assert.ok(initCall, 'should invoke .qol/worktree-init.sh when present');
});

test('run does not invoke init hook when .qol/worktree-init.sh is absent', () => {
    const root = makeWorkspace();
    const runner = makeRunner([
        {
            match: o => o.cmd === 'git' && o.args[0] === 'symbolic-ref',
            result: { stdout: 'origin/main\n', stderr: '', code: 0 },
        },
        {
            match: o => o.cmd === 'gh' && o.args[0] === 'issue' && o.args[1] === 'create',
            result: { stdout: 'https://github.com/foo/qol-tray/issues/42\n', stderr: '', code: 0 },
        },
        {
            match: o => o.cmd === 'gh' && o.args[0] === 'pr' && o.args[1] === 'create',
            result: { stdout: 'https://github.com/foo/qol-tray/pull/77\n', stderr: '', code: 0 },
        },
    ]);
    pidNew.run({
        argv: ['qol-tray', 'Foo Bar'],
        env: {}, cwd: root, runner, fs, log: () => {},
    });
    const initCall = runner.calls.find(c => c.cmd === 'bash');
    assert.strictEqual(initCall, undefined);
});

test('run propagates failure when gh issue create returns malformed url', () => {
    const root = makeWorkspace();
    const runner = makeRunner([
        {
            match: o => o.cmd === 'git' && o.args[0] === 'symbolic-ref',
            result: { stdout: 'origin/main\n', stderr: '', code: 0 },
        },
        {
            match: o => o.cmd === 'gh' && o.args[0] === 'issue' && o.args[1] === 'create',
            result: { stdout: 'oops not a url\n', stderr: '', code: 0 },
        },
    ]);
    assert.throws(
        () => pidNew.run({
            argv: ['qol-tray', 'Foo Bar'],
            env: {},
            cwd: root,
            runner,
            fs,
            log: () => {},
        }),
        /could not extract issue number/,
    );
});
