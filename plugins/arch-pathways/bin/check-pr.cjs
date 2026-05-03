#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const pid = require('../lib/pid.cjs');
const shell = require('../lib/shell-tokens.cjs');

const INSPECTED_TOOLS = new Set(['Bash']);
const BYPASS_MARKER = '.claude/bypass-arch-pathways';

function readStdin() {
    try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function consumeBypass(cwd) {
    const marker = path.join(cwd, BYPASS_MARKER);
    if (!fs.existsSync(marker) || !fs.statSync(marker).isFile()) return false;
    try {
        const raw = fs.readFileSync(marker, 'utf8').trim();
        const count = /^\d+$/.test(raw) ? Number(raw) : 1;
        if (count > 1) fs.writeFileSync(marker, String(count - 1));
        else fs.unlinkSync(marker);
    } catch { /* ignore */ }
    return true;
}

function resolveWorkspace(env, cwd) {
    if (env.QOL_WORKSPACE_ROOT) return path.resolve(env.QOL_WORKSPACE_ROOT);
    let dir = path.resolve(cwd);
    while (true) {
        if (fs.existsSync(path.join(dir, 'qol-skills'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

function inspectGhPr(tokens) {
    const violations = [];
    const subcmd = tokens[2];
    if (subcmd !== 'create' && subcmd !== 'edit') return violations;
    const title = shell.flagValue(tokens, '--title');
    if (title == null) return violations;
    if (!pid.parsePrTitle(title)) {
        violations.push(
            `gh pr ${subcmd} --title ${JSON.stringify(title)} does not match "<PREFIX>-<N> Title Case Slug" ` +
            `(e.g. "TRAY-42 Fold Installs Into Config Dir"). Run bin/pid-new to auto-generate, or edit the title to match.`,
        );
    }
    return violations;
}

function inspectGitBranchCreate(tokens) {
    const violations = [];
    const verb = tokens[1];
    let branch = null;
    if (verb === 'checkout') {
        const idx = tokens.indexOf('-b');
        if (idx === -1) return violations;
        branch = tokens[idx + 1];
    } else if (verb === 'switch') {
        const idx = tokens.indexOf('-c');
        if (idx === -1) return violations;
        branch = tokens[idx + 1];
    } else {
        return violations;
    }
    if (!branch) return violations;
    if (!pid.parseBranchName(branch)) {
        violations.push(
            `branch "${branch}" does not match "<prefix>-<n>-<slug>" (e.g. "tray-42-fold-installs"). ` +
            `Use bin/pid-new instead of raw git so the branch is linked to a real GitHub issue.`,
        );
    }
    return violations;
}

function inspectGitWorktreeAdd(tokens, workspace) {
    const violations = [];
    if (tokens[2] !== 'add') return violations;

    const valueFlags = new Set(['-b', '-B', '--reason']);
    const skip = new Set();
    let branch = null;
    for (let i = 3; i < tokens.length; i++) {
        if (valueFlags.has(tokens[i])) {
            if (tokens[i] === '-b' || tokens[i] === '-B') branch = tokens[i + 1];
            skip.add(i); skip.add(i + 1);
        }
    }
    let pathArg = null;
    for (let i = 3; i < tokens.length; i++) {
        if (skip.has(i)) continue;
        if (tokens[i].startsWith('-')) continue;
        pathArg = tokens[i];
        break;
    }
    if (branch && !pid.parseBranchName(branch)) {
        violations.push(
            `worktree branch "${branch}" does not match "<prefix>-<n>-<slug>". Use bin/pid-new.`,
        );
    }
    if (pathArg && workspace) {
        const expected = path.join(workspace, 'worktrees') + path.sep;
        const resolved = path.resolve(pathArg);
        if (!resolved.startsWith(expected)) {
            violations.push(
                `worktree path "${pathArg}" is not under "${expected}". ` +
                `Worktrees live in the central pool. Use bin/pid-new.`,
            );
        }
    }
    return violations;
}

function inspectCommand(cmd, workspace) {
    const subcommands = shell.splitCommands(cmd);
    const violations = [];
    for (const sub of subcommands) {
        const tokens = shell.tokenize(sub);
        if (tokens.length === 0) continue;
        if (tokens[0] === 'gh' && tokens[1] === 'pr') violations.push(...inspectGhPr(tokens));
        else if (tokens[0] === 'git' && (tokens[1] === 'checkout' || tokens[1] === 'switch')) {
            violations.push(...inspectGitBranchCreate(tokens));
        } else if (tokens[0] === 'git' && tokens[1] === 'worktree') {
            violations.push(...inspectGitWorktreeAdd(tokens, workspace));
        }
    }
    return violations;
}

function block(violations) {
    process.stderr.write(`arch-pathways convention violation:

${violations.map(v => `  - ${v}`).join('\n')}

Quick fixes:
  - PR title format:    "<PREFIX>-<N> Title Case Slug"  (e.g. "TRAY-42 Fold Installs Into Config Dir")
  - Branch name format: "<prefix>-<n>-<kebab-slug>"     (e.g. "tray-42-fold-installs-into-config-dir")
  - Worktree path:      "\${workspace}/worktrees/<repo>/<branch>"
  - Or just run:        node \${CLAUDE_PLUGIN_ROOT}/bin/pid-new.cjs <repo> "<Title>"

Bypass for one edit:
  touch .claude/bypass-arch-pathways
`);
}

function main() {
    const raw = readStdin().trim();
    if (!raw) return 0;
    let payload;
    try { payload = JSON.parse(raw); } catch { return 0; }
    const tool = payload.tool_name || payload.tool || '';
    if (!INSPECTED_TOOLS.has(tool)) return 0;
    const cmd = (payload.tool_input || {}).command;
    if (typeof cmd !== 'string' || !cmd.trim()) return 0;
    const cwd = payload.cwd || process.cwd();
    if (consumeBypass(cwd)) return 0;
    const workspace = resolveWorkspace(process.env, cwd);
    const violations = inspectCommand(cmd, workspace);
    if (violations.length > 0) {
        block(violations);
        return 2;
    }
    return 0;
}

if (require.main === module) {
    process.exit(main());
}

module.exports = {
    inspectCommand,
    inspectGhPr,
    inspectGitBranchCreate,
    inspectGitWorktreeAdd,
    resolveWorkspace,
};
