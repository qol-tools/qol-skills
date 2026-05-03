#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const survey = require('../lib/html-survey.cjs');
const pid = require('../lib/pid.cjs');
const pathwayExtract = require('./pathway-extract.cjs');
const pidNew = require('./pid-new.cjs');
const pidMint = require('./pid-mint.cjs');

function printHelp(log) {
    log(`Usage: pathway-pr <area-id> <repo> [options]

End-to-end: take an HTML survey area, mint a GitHub issue for it, generate the
markdown ADR for that area with sub-IDs, then create branch + worktree + draft PR
seeded with the rendered ADR.

Required:
  <area-id>           Section id from the HTML survey (e.g. "boot", "path").
  <repo>              Repo name from lib/prefixes.json (e.g. qol-tray).

Options:
  --in <html>         Path to the HTML survey doc. Default: /tmp/qol-tray-pathways.html
  --workspace <dir>   Workspace root. Defaults to \$QOL_WORKSPACE_ROOT or auto-detect.
  --base <branch>     Base branch for the PR. Default: repo's default branch.
  --dry-run           Plan only; uses #999 as a placeholder issue and does not touch GitHub.
  -h, --help          Show this help.

Output: PID, worktree path, PR URL on stdout (same shape as pid-new).`);
}

function parseArgs(argv) {
    const opts = { positional: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') opts.help = true;
        else if (a === '--in') opts.input = argv[++i];
        else if (a === '--workspace') opts.workspace = argv[++i];
        else if (a === '--base') opts.base = argv[++i];
        else if (a === '--dry-run') opts.dryRun = true;
        else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
        else opts.positional.push(a);
    }
    return opts;
}

function defaultRunner({ cmd, args, cwd, input }) {
    const r = spawnSync(cmd, args, { cwd, input, encoding: 'utf8' });
    return { stdout: r.stdout || '', stderr: r.stderr || '', code: r.status };
}

function run({ argv, env, cwd, runner, fs: fsLike, log, error }) {
    const opts = parseArgs(argv);
    if (opts.help) { printHelp(log); return 0; }
    if (opts.positional.length !== 2) throw new Error('expected exactly two positional args: <area-id> <repo>');
    const [areaId, repo] = opts.positional;
    const inputPath = opts.input || '/tmp/qol-tray-pathways.html';

    const mintArgv = [areaId, repo, '--in', inputPath, '--json'];
    if (opts.workspace) mintArgv.push('--workspace', opts.workspace);
    if (opts.dryRun) mintArgv.push('--dry-run');
    let mintLine = '';
    pidMint.run({
        argv: mintArgv,
        env, cwd, runner, fs: fsLike,
        log: s => { mintLine += s; },
        error: () => {},
    });
    const minted = JSON.parse(mintLine);

    const extractArgv = [areaId, '--in', inputPath, '--pid', minted.pid, '--issue', String(minted.issue)];
    let adrText = '';
    pathwayExtract.run({
        argv: extractArgv,
        fs: fsLike,
        log: s => { adrText += (s.endsWith('\n') ? s : s + '\n'); },
    });

    const tmpDir = fsLike.mkdtempSync(path.join(os.tmpdir(), 'pathway-pr-'));
    const adrFile = path.join(tmpDir, `${minted.pid}.md`);
    fsLike.writeFileSync(adrFile, adrText);

    const pidNewArgv = [
        repo, minted.title,
        '--issue', String(minted.issue),
        '--adr-content-file', adrFile,
    ];
    if (opts.workspace) pidNewArgv.push('--workspace', opts.workspace);
    if (opts.base) pidNewArgv.push('--base', opts.base);
    if (opts.dryRun) pidNewArgv.push('--dry-run');

    return pidNew.run({
        argv: pidNewArgv,
        env, cwd, runner, fs: fsLike, log,
    });
}

function main() {
    try {
        const code = run({
            argv: process.argv.slice(2),
            env: process.env,
            cwd: process.cwd(),
            runner: defaultRunner,
            fs: { ...fs, mkdtempSync: fs.mkdtempSync },
            log: msg => process.stdout.write(msg + '\n'),
            error: msg => process.stderr.write(msg + '\n'),
        });
        process.exit(code);
    } catch (err) {
        process.stderr.write(`pathway-pr: ${err.message}\n`);
        process.exit(1);
    }
}

if (require.main === module) main();

module.exports = { run, parseArgs };
