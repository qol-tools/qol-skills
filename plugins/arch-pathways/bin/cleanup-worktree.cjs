#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const pid = require('../lib/pid.cjs');
const shell = require('../lib/shell-tokens.cjs');

function readStdin() {
    try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function defaultRunner({ cmd, args, cwd }) {
    const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
    return { stdout: r.stdout || '', stderr: r.stderr || '', code: r.status };
}

function isMergeCommand(cmd) {
    const subcommands = shell.splitCommands(cmd);
    return subcommands.some(sub => {
        const tokens = shell.tokenize(sub);
        return tokens[0] === 'gh' && tokens[1] === 'pr' && tokens[2] === 'merge';
    });
}

function classifyWorktreePath(worktreePath) {
    const m = worktreePath.match(/^(.+)[\\/]worktrees[\\/]([^\\/]+)[\\/]([^\\/]+)$/);
    if (!m) return null;
    return { workspace: m[1], repo: m[2], branch: m[3] };
}

function isToolSuccess(payload) {
    const resp = payload.tool_response;
    if (!resp) return true;
    if (typeof resp.success === 'boolean') return resp.success;
    if (typeof resp.exit_code === 'number') return resp.exit_code === 0;
    if (typeof resp.code === 'number') return resp.code === 0;
    return true;
}

function run({ payload, runner, fs: fsLike, log, warn }) {
    if ((payload.tool_name || payload.tool || '') !== 'Bash') return 0;
    if (!isToolSuccess(payload)) return 0;
    const cmd = (payload.tool_input || {}).command;
    if (typeof cmd !== 'string' || !isMergeCommand(cmd)) return 0;

    const cwd = payload.cwd || process.cwd();
    const top = runner({ cmd: 'git', args: ['rev-parse', '--show-toplevel'], cwd });
    if (top.code !== 0) return 0;
    const worktreePath = top.stdout.trim();

    const meta = classifyWorktreePath(worktreePath);
    if (!meta) {
        warn(`worktree ${worktreePath} is not under <workspace>/worktrees/<repo>/<branch>. Skipping cleanup.`);
        return 0;
    }
    if (!pid.parseBranchName(meta.branch)) {
        warn(`branch "${meta.branch}" doesn't match arch-pathways convention. Skipping cleanup.`);
        return 0;
    }
    const mainRepo = path.join(meta.workspace, meta.repo);
    if (!fsLike.existsSync(path.join(mainRepo, '.git'))) {
        warn(`main repo ${mainRepo} not found. Skipping cleanup.`);
        return 0;
    }

    const remove = runner({
        cmd: 'git',
        args: ['-C', mainRepo, 'worktree', 'remove', worktreePath],
        cwd: mainRepo,
    });
    if (remove.code === 0) {
        log(`arch-pathways: removed worktree ${worktreePath}`);
    } else {
        warn(`arch-pathways: git worktree remove failed: ${(remove.stderr || remove.stdout).trim()}`);
    }
    return 0;
}

function main() {
    const raw = readStdin().trim();
    if (!raw) return 0;
    let payload;
    try { payload = JSON.parse(raw); } catch { return 0; }
    return run({
        payload,
        runner: defaultRunner,
        fs,
        log: msg => process.stdout.write(msg + '\n'),
        warn: msg => process.stderr.write(msg + '\n'),
    });
}

if (require.main === module) {
    process.exit(main());
}

module.exports = { run, isMergeCommand, classifyWorktreePath, isToolSuccess };
