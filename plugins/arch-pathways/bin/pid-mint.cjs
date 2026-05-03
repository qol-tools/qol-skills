#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const survey = require('../lib/html-survey.cjs');
const pid = require('../lib/pid.cjs');

function printHelp(log) {
    log(`Usage: pid-mint <area-id> <repo> [options]

Reads an arch-pathways HTML survey, finds the named area, creates ONE GitHub
issue using the area's <h2> title, and prints the resulting PID.

Required:
  <area-id>           Section id from the HTML survey (e.g. "boot", "path").
  <repo>              Repo name from lib/prefixes.json (e.g. qol-tray).

Options:
  --in <html>         Path to the HTML survey doc. Default: /tmp/qol-tray-pathways.html
  --workspace <dir>   Workspace root. Defaults to \$QOL_WORKSPACE_ROOT or auto-detect.
  --title <text>      Override the area title used as the issue title.
  --json              Emit a JSON object {pid, issue, url, repo, area, title}.
                      Default: print PID only on stdout.
  --dry-run           Print the planned action without calling gh; uses #999 as a placeholder.
  -h, --help          Show this help.

Output: PID on stdout (e.g. "TRAY-42"); JSON if --json. URL on stderr.`);
}

function parseArgs(argv) {
    const opts = { positional: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') opts.help = true;
        else if (a === '--in') opts.input = argv[++i];
        else if (a === '--workspace') opts.workspace = argv[++i];
        else if (a === '--title') opts.title = argv[++i];
        else if (a === '--json') opts.json = true;
        else if (a === '--dry-run') opts.dryRun = true;
        else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
        else opts.positional.push(a);
    }
    return opts;
}

function defaultRunner({ cmd, args, cwd }) {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    return { stdout: r.stdout || '', stderr: r.stderr || '', code: r.status };
}

function resolveWorkspace(explicit, env, cwd, fsLike) {
    if (explicit) return path.resolve(explicit);
    if (env.QOL_WORKSPACE_ROOT) return path.resolve(env.QOL_WORKSPACE_ROOT);
    let dir = path.resolve(cwd);
    while (true) {
        if (fsLike.existsSync(path.join(dir, 'qol-skills'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

function cleanAreaTitle(raw) {
    const stripped = String(raw).replace(/^\s*\d+(?:[.)])?\s+/, '').trim();
    if (!stripped) return raw.trim();
    return stripped
        .split(/\s+/)
        .map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
        .join(' ');
}

function ghCreateIssue(runner, repoRoot, title, body) {
    const r = runner({
        cmd: 'gh',
        args: ['issue', 'create', '--title', title, '--body', body],
        cwd: repoRoot,
    });
    if (r.code !== 0) throw new Error(`gh issue create failed (exit ${r.code}):\n${r.stderr || r.stdout}`);
    const url = r.stdout.trim();
    const m = url.match(/\/issues\/(\d+)\s*$/);
    if (!m) throw new Error(`could not extract issue number from gh output: ${JSON.stringify(url)}`);
    return { url, number: Number(m[1]) };
}

function run({ argv, env, cwd, runner, fs: fsLike, log, error }) {
    const opts = parseArgs(argv);
    if (opts.help) { printHelp(log); return 0; }
    if (opts.positional.length !== 2) throw new Error('expected exactly two positional args: <area-id> <repo>');
    const [areaId, repo] = opts.positional;

    const inputPath = opts.input || '/tmp/qol-tray-pathways.html';
    if (!fsLike.existsSync(inputPath)) throw new Error(`input file not found: ${inputPath}`);
    const html = fsLike.readFileSync(inputPath, 'utf8');
    const areas = survey.parseAreas(html);
    if (!areas.has(areaId)) {
        const known = [...areas.keys()].join(', ');
        throw new Error(`area "${areaId}" not found in ${inputPath}. Known: ${known}`);
    }
    const sec = survey.parseSection(areas.get(areaId));
    const rawTitle = opts.title || sec.title;
    if (!rawTitle) throw new Error(`area "${areaId}" has no <h2> title and no --title given`);
    const issueTitle = cleanAreaTitle(rawTitle);

    const prefix = pid.prefixForRepo(repo);

    const workspace = resolveWorkspace(opts.workspace, env, cwd, fsLike);
    const repoRoot = workspace ? path.join(workspace, repo) : null;
    if (!opts.dryRun && (!repoRoot || !fsLike.existsSync(path.join(repoRoot, '.git')))) {
        throw new Error(`cannot resolve git repo for "${repo}" (workspace: ${workspace || 'unresolved'})`);
    }

    let issueNumber, issueUrl;
    if (opts.dryRun) {
        issueNumber = 999;
        issueUrl = `dry-run://${repo}/issues/999`;
    } else {
        const body = `Survey area: \`#${areaId}\` in \`${path.basename(inputPath)}\`.

This issue is the canonical address for the smells listed under that area. The full analysis lives in \`docs/adr/<PID>-<slug>.md\` once the PR is opened.`;
        const created = ghCreateIssue(runner, repoRoot, issueTitle, body);
        issueNumber = created.number;
        issueUrl = created.url;
    }

    const pidStr = pid.formatPid(prefix, issueNumber);
    if (opts.json) {
        log(JSON.stringify({ pid: pidStr, issue: issueNumber, url: issueUrl, repo, area: areaId, title: issueTitle }));
    } else {
        log(pidStr);
    }
    error(issueUrl);
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
            error: msg => process.stderr.write(msg + '\n'),
        });
        process.exit(code);
    } catch (err) {
        process.stderr.write(`pid-mint: ${err.message}\n`);
        process.exit(1);
    }
}

if (require.main === module) main();

module.exports = { run, parseArgs, resolveWorkspace, cleanAreaTitle };
