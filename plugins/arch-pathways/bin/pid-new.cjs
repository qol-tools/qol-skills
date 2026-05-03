#!/usr/bin/env node
'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const pid = require('../lib/pid.cjs');

const TEMPLATE_PATH = path.join(__dirname, '..', 'skills', 'arch-pathways', 'template.adr.md');

function printHelp(log) {
    log(`Usage: pid-new <repo> "<Title>" [options]

Mints a GitHub issue, creates a worktree on a new branch, seeds an ADR file at
docs/adr/<PID>-<slug>.md, and opens a draft PR linking to the ADR.

Required:
  <repo>            Repo name (must be in lib/prefixes.json), e.g. qol-tray.
  <Title>           Quoted human-readable problem title, Title Case.

Options:
  --workspace <dir> Workspace root containing the repos. Defaults to
                    \$QOL_WORKSPACE_ROOT or auto-detect by walking up from cwd
                    looking for a sibling qol-skills/ directory.
  --base <branch>   Base branch for the new branch + PR. Defaults to the
                    repo's default branch (origin/HEAD).
  --issue <N>       Skip issue creation and use existing issue number.
  --issue-body-file <path>
                    Read the GitHub Issue body (problem statement, including
                    Mermaid blocks) from <path>. The same content seeds the
                    ADR's "## Problem" section so reviewers see the diagram
                    on either surface.
  --adr-content-file <path>
                    Use the contents of <path> as the ADR body instead of
                    rendering from template.adr.md. Used by pathway-pr to seed
                    the ADR from an extracted HTML survey area.
  --dry-run         Print the planned actions without touching the network or
                    filesystem (uses issue #999 as a placeholder).
  -h, --help        Show this help.

Output: prints PID, worktree path, and PR URL on success.`);
}

function parseArgs(argv) {
    const opts = { positional: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') opts.help = true;
        else if (a === '--dry-run') opts.dryRun = true;
        else if (a === '--workspace') opts.workspace = argv[++i];
        else if (a === '--base') opts.base = argv[++i];
        else if (a === '--issue') opts.issue = Number(argv[++i]);
        else if (a === '--issue-body-file') opts.issueBodyFile = argv[++i];
        else if (a === '--slug') opts.slug = argv[++i];
        else if (a === '--adr-content-file') opts.adrContentFile = argv[++i];
        else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
        else opts.positional.push(a);
    }
    return opts;
}

function resolveWorkspace(explicit, env, cwd, fsLike) {
    if (explicit) return path.resolve(explicit);
    if (env.QOL_WORKSPACE_ROOT) return path.resolve(env.QOL_WORKSPACE_ROOT);
    let dir = path.resolve(cwd);
    while (true) {
        if (fsLike.existsSync(path.join(dir, 'qol-skills'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    throw new Error(
        'cannot resolve workspace root. Set $QOL_WORKSPACE_ROOT, pass --workspace, or run from inside the workspace.',
    );
}

function defaultRunner({ cmd, args, cwd, input, env }) {
    const result = spawnSync(cmd, args, {
        cwd,
        input,
        env: env ? { ...process.env, ...env } : undefined,
        encoding: 'utf8',
    });
    return {
        stdout: result.stdout || '',
        stderr: result.stderr || '',
        code: result.status,
    };
}

function runOrThrow(runner, { cmd, args, cwd, input, label }) {
    const r = runner({ cmd, args, cwd, input });
    if (r.code !== 0) {
        const desc = label || `${cmd} ${args.join(' ')}`;
        throw new Error(`${desc} failed (exit ${r.code}):\n${r.stderr || r.stdout}`);
    }
    return r;
}

function ghIssueCreate(runner, repoRoot, title, body) {
    const r = runOrThrow(runner, {
        cmd: 'gh',
        args: ['issue', 'create', '--title', title, '--body', body],
        cwd: repoRoot,
        label: 'gh issue create',
    });
    const url = r.stdout.trim();
    const m = url.match(/\/issues\/(\d+)\s*$/);
    if (!m) throw new Error(`could not extract issue number from gh output: ${JSON.stringify(url)}`);
    return Number(m[1]);
}

function detectDefaultBranch(runner, repoRoot) {
    const r = runner({
        cmd: 'git',
        args: ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
        cwd: repoRoot,
    });
    if (r.code === 0) {
        const ref = r.stdout.trim();
        const m = ref.match(/^origin\/(.+)$/);
        if (m) return m[1];
    }
    return 'main';
}

function gitFetch(runner, repoRoot, baseBranch) {
    runOrThrow(runner, {
        cmd: 'git',
        args: ['fetch', 'origin', baseBranch],
        cwd: repoRoot,
        label: `git fetch origin ${baseBranch}`,
    });
}

function gitWorktreeAdd(runner, repoRoot, branch, worktreePath, baseBranch, fsLike) {
    fsLike.mkdirSync(path.dirname(worktreePath), { recursive: true });
    runOrThrow(runner, {
        cmd: 'git',
        args: ['worktree', 'add', '-b', branch, worktreePath, `origin/${baseBranch}`],
        cwd: repoRoot,
        label: `git worktree add ${worktreePath}`,
    });
}

function runWorktreeInit(runner, fsLike, repoRoot, worktreePath, pidStr, branch) {
    const initScript = path.join(repoRoot, '.qol', 'worktree-init.sh');
    if (!fsLike.existsSync(initScript)) return null;
    return runOrThrow(runner, {
        cmd: 'bash',
        args: [initScript],
        cwd: worktreePath,
        env: {
            QOL_WORKTREE_PATH: worktreePath,
            QOL_REPO_ROOT: repoRoot,
            QOL_PID: pidStr,
            QOL_BRANCH: branch,
        },
        label: '.qol/worktree-init.sh',
    });
}

function renderAdr(template, { pidStr, issueNumber, slug, title, today }) {
    return template
        .replace(/\{PID\}/g, pidStr)
        .replace(/\{Title Case Slug\}/g, title)
        .replace(/\{issue_number\}/g, String(issueNumber))
        .replace(/\{YYYY-MM-DD\}/g, today);
}

function mintAdr(fsLike, worktreePath, pidStr, issueNumber, slug, title, today, contentOverride) {
    const adrPath = pid.adrPath(worktreePath, pidStr, slug);
    fsLike.mkdirSync(path.dirname(adrPath), { recursive: true });
    const body = contentOverride !== undefined
        ? contentOverride
        : renderAdr(fsLike.readFileSync(TEMPLATE_PATH, 'utf8'), { pidStr, issueNumber, slug, title, today });
    fsLike.writeFileSync(adrPath, body);
    return adrPath;
}

function gitAddCommitPush(runner, worktreePath, branch, pidStr, title, adrRelPath) {
    runOrThrow(runner, {
        cmd: 'git', args: ['add', adrRelPath], cwd: worktreePath, label: 'git add',
    });
    runOrThrow(runner, {
        cmd: 'git', args: ['commit', '-m', `docs(adr): seed ${pidStr} ${title}`],
        cwd: worktreePath, label: 'git commit',
    });
    runOrThrow(runner, {
        cmd: 'git', args: ['push', '-u', 'origin', branch],
        cwd: worktreePath, label: `git push -u origin ${branch}`,
    });
}

function ghPrCreate(runner, worktreePath, prTitle, prBody, baseBranch) {
    const r = runOrThrow(runner, {
        cmd: 'gh',
        args: [
            'pr', 'create',
            '--draft',
            '--title', prTitle,
            '--body', prBody,
            '--base', baseBranch,
        ],
        cwd: worktreePath,
        label: 'gh pr create',
    });
    return r.stdout.trim();
}

function buildIssueBody(pidStr, slug, problemStatement) {
    const link = `Decision record: \`docs/adr/${pidStr}-${slug}.md\` (seeded by the linked PR).`;
    if (!problemStatement || !problemStatement.trim()) {
        return link;
    }
    return `${problemStatement.trim()}\n\n---\n\n${link}`;
}

function buildPrBody(pidStr, slug, issueNumber, ownerRepo, branch) {
    const filePath = `docs/adr/${pidStr}-${slug}.md`;
    const link = (ownerRepo && branch)
        ? `https://github.com/${ownerRepo}/blob/${branch}/${filePath}`
        : filePath;
    return `Closes #${issueNumber}

ADR (rendered on this branch): [\`${filePath}\`](${link})`;
}

function detectOwnerRepo(runner, repoRoot) {
    const r = runner({ cmd: 'git', args: ['remote', 'get-url', 'origin'], cwd: repoRoot });
    if (r.code !== 0) return null;
    const url = r.stdout.trim();
    const m = url.match(/[:/]([^/:]+)\/([^/]+?)(?:\.git)?\s*$/);
    if (!m) return null;
    return `${m[1]}/${m[2]}`;
}

function today() {
    return new Date().toISOString().slice(0, 10);
}

function formatDryRunPlan({ repo, pidStr, branch, worktreePath, adrPath, prTitle, baseBranch }) {
    return [
        '[dry-run] would perform:',
        `  repo:        ${repo}`,
        `  pid:         ${pidStr}`,
        `  branch:      ${branch}`,
        `  base branch: ${baseBranch}`,
        `  worktree:    ${worktreePath}`,
        `  adr file:    ${adrPath}`,
        `  pr title:    ${prTitle}`,
    ].join('\n');
}

function formatSummary({ pidStr, worktreePath, prUrl }) {
    return [
        `pid:      ${pidStr}`,
        `worktree: ${worktreePath}`,
        `pr:       ${prUrl}`,
    ].join('\n');
}

function run({ argv, env, cwd, runner, fs: fsLike, log }) {
    const opts = parseArgs(argv);
    if (opts.help) {
        printHelp(log);
        return 0;
    }
    if (opts.positional.length !== 2) {
        throw new Error('expected exactly two positional args: <repo> "<Title>"');
    }
    const [repo, title] = opts.positional;
    if (!title.trim()) throw new Error('title cannot be empty');

    const workspace = resolveWorkspace(opts.workspace, env, cwd, fsLike);
    const prefix = pid.prefixForRepo(repo);
    const slug = opts.slug ? opts.slug : pid.slugify(title);
    if (!pid.isValidSlug(slug)) throw new Error(`invalid --slug "${opts.slug}" (must be lowercase kebab)`);
    const titleCase = opts.slug ? title.trim() : pid.titleCaseFromSlug(slug);

    const repoRoot = path.join(workspace, repo);
    if (!fsLike.existsSync(path.join(repoRoot, '.git'))) {
        throw new Error(`${repoRoot} is not a git repo (no .git directory)`);
    }

    const baseBranch = opts.base || detectDefaultBranch(runner, repoRoot);

    const problemStatement = opts.issueBodyFile
        ? fsLike.readFileSync(opts.issueBodyFile, 'utf8')
        : '';

    const issueNumber = opts.dryRun
        ? 999
        : (Number.isInteger(opts.issue) && opts.issue > 0
            ? opts.issue
            : ghIssueCreate(runner, repoRoot, titleCase, buildIssueBody('PLACEHOLDER', slug, problemStatement)));

    const pidStr = pid.formatPid(prefix, issueNumber);
    const branch = pid.formatBranchName(prefix, issueNumber, slug);
    const worktreePath = pid.worktreePath(workspace, repo, branch);
    const adrFilePath = pid.adrPath(worktreePath, pidStr, slug);
    const prTitle = pid.formatPrTitle(prefix, issueNumber, titleCase);

    if (opts.dryRun) {
        log(formatDryRunPlan({
            repo, pidStr, branch, worktreePath, adrPath: adrFilePath, prTitle, baseBranch,
        }));
        return 0;
    }

    gitFetch(runner, repoRoot, baseBranch);
    gitWorktreeAdd(runner, repoRoot, branch, worktreePath, baseBranch, fsLike);
    runWorktreeInit(runner, fsLike, repoRoot, worktreePath, pidStr, branch);
    const contentOverride = opts.adrContentFile
        ? fsLike.readFileSync(opts.adrContentFile, 'utf8')
        : undefined;
    mintAdr(fsLike, worktreePath, pidStr, issueNumber, slug, titleCase, today(), contentOverride);
    const adrRelPath = path.relative(worktreePath, adrFilePath);
    gitAddCommitPush(runner, worktreePath, branch, pidStr, titleCase, adrRelPath);
    const ownerRepo = detectOwnerRepo(runner, repoRoot);
    const prUrl = ghPrCreate(runner, worktreePath, prTitle, buildPrBody(pidStr, slug, issueNumber, ownerRepo, branch), baseBranch);

    log(formatSummary({ pidStr, worktreePath, prUrl }));
    return 0;
}

function main() {
    try {
        const code = run({
            argv: process.argv.slice(2),
            env: process.env,
            cwd: process.cwd(),
            runner: defaultRunner,
            fs,
            log: msg => process.stdout.write(msg + '\n'),
        });
        process.exit(code);
    } catch (err) {
        process.stderr.write(`pid-new: ${err.message}\n`);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}

module.exports = {
    run,
    parseArgs,
    resolveWorkspace,
    renderAdr,
    buildIssueBody,
    buildPrBody,
    detectOwnerRepo,
    formatDryRunPlan,
    formatSummary,
    today,
    TEMPLATE_PATH,
};
