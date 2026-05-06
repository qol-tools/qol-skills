#!/usr/bin/env node
/*
 * PreToolUse hook (Bash matcher): block `git checkout -b`, `git checkout <other>`,
 * `git switch -c`, and `git switch <other>` when the current working directory is
 * a qol-tools repo's MAIN clone (not a worktree).
 *
 * Rule: in qol-tools we develop on worktrees, not feature branches inside the
 * main clone. Branching from main clone leaves the workstation stuck on a
 * feature branch after the PR merges, qol-sync silently reports "ok" against
 * the wrong tracking branch, and the next `make dev` runs out of date.
 *
 * Bypass: append ` # intentional` to the command (matches the convention used
 * by other qol-host hooks).
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CHECKOUT_OR_SWITCH = /(^|[\s;&|`(])git\s+(?:\S+\s+)*?(checkout|switch)\b([^\n;&|`)]*)/;
const CREATE_FLAGS = /(^|\s)(-b|-B|--branch|-c|-C|--create)\s+/;
const PATH_SEP = /(^|\s)--\s/;
const SHA_LIKE = /^[0-9a-f]{4,40}$/i;
const REVISION_LIKE = /[~^@]/;
const ALLOWED_BRANCHES = new Set(['main', 'master']);
const QOL_REPO_RE = /\/qol-tools\/(?!worktrees\/)([^/]+)\/?$/;

// Match an opening `cd <path> [&&|;]` group anchored at the start of the
// command (after any whitespace or opening paren). Captures the path.
const CD_PREFIX = /^[\s(]*cd\s+(?:--\s+)?(?:"([^"]+)"|'([^']+)'|(\S+))\s*(?:&&|;)/;
// Match `git -C <path>` form anywhere before checkout/switch.
const GIT_DASH_C = /git\s+(?:[a-z-]+\s+)*-C(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/;

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function isMainClone(cwd) {
    let dir = cwd;
    while (dir && dir !== '/') {
        const gitPath = path.join(dir, '.git');
        try {
            const stat = fs.lstatSync(gitPath);
            return { repoRoot: dir, mainClone: stat.isDirectory() };
        } catch {
            dir = path.dirname(dir);
        }
    }
    return { repoRoot: null, mainClone: false };
}

function isQolToolsMainClone(cwd) {
    const info = isMainClone(cwd);
    if (!info.repoRoot || !info.mainClone) return false;
    return QOL_REPO_RE.test(info.repoRoot);
}

function resolveEffectiveCwd(cmd, baseCwd) {
    // `git -C <path>` overrides cd because git resolves it inside its own
    // process regardless of the shell's cwd.
    const dashC = cmd.match(GIT_DASH_C);
    if (dashC) {
        const target = dashC[1] || dashC[2] || dashC[3];
        return path.isAbsolute(target) ? target : path.resolve(baseCwd, target);
    }
    // Walk through leading `cd <path> &&|;` chains.
    let remaining = cmd;
    let cwd = baseCwd;
    let depth = 0;
    while (depth < 10) {
        const cd = remaining.match(CD_PREFIX);
        if (!cd) break;
        const target = cd[1] || cd[2] || cd[3];
        cwd = path.isAbsolute(target) ? target : path.resolve(cwd, target);
        remaining = remaining.slice(cd[0].length);
        depth += 1;
    }
    return cwd;
}

function classify(matchedArgs) {
    const args = matchedArgs.trim();
    if (!args) return { kind: 'noop' };
    if (CREATE_FLAGS.test(' ' + args)) return { kind: 'create' };
    if (PATH_SEP.test(' ' + args)) return { kind: 'path' };
    const tokens = args.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return { kind: 'noop' };
    const first = tokens[0];
    if (first.startsWith('-')) return { kind: 'flag-only' };
    if (SHA_LIKE.test(first) || REVISION_LIKE.test(first)) return { kind: 'revision' };
    if (first === 'HEAD') return { kind: 'revision' };
    if (ALLOWED_BRANCHES.has(first)) return { kind: 'allowed-branch', target: first };
    return { kind: 'branch', target: first };
}

function emitBlock(reason, command) {
    process.stderr.write(`git branch switch BLOCKED by qol-workflow:branch-deny-checkout-in-main-clone hook.

${reason}

Command: ${command.trim()}

qol-tools rule (plugin:qol-workflow:git-trees skill):
  Develop on worktrees, never on feature branches inside the main clone.
  The main clone of every qol-* repo MUST stay on main. Switching it leaves
  the workstation stuck on a feature branch after PR merge — the next
  qol-sync silently reports "ok" against the wrong tracking branch, and
  \`make dev\` runs out of date code.

Use a worktree instead:

  git -C <repo> worktree add \\
    /Users/kaho/repos/private/qol-tools/worktrees/<feature>/<repo> \\
    -b <branch-name>
  cd /Users/kaho/repos/private/qol-tools/worktrees/<feature>/<repo>
  # work, commit, push, open PR from here

Bypass (rare, e.g. recovery): append \` # intentional\` to the command.
`);
}

function main() {
    const raw = readStdin().trim();
    if (!raw) return 0;

    let payload;
    try {
        payload = JSON.parse(raw);
    } catch {
        return 0;
    }

    if ((payload.tool_name || payload.tool || '') !== 'Bash') return 0;
    const cmd = (payload.tool_input && payload.tool_input.command) || '';
    if (!cmd) return 0;
    if (/#\s*intentional\b/.test(cmd)) return 0;

    const m = cmd.match(CHECKOUT_OR_SWITCH);
    if (!m) return 0;
    const verb = m[2];
    const cls = classify(m[3] || '');
    if (cls.kind === 'noop' || cls.kind === 'path' || cls.kind === 'flag-only' || cls.kind === 'revision') return 0;
    if (cls.kind === 'allowed-branch') return 0;

    const baseCwd = (payload.tool_input && payload.tool_input.cwd) || process.cwd();
    const cwd = resolveEffectiveCwd(cmd, baseCwd);
    if (!isQolToolsMainClone(cwd)) return 0;

    if (cls.kind === 'create') {
        emitBlock(
            `\`git ${verb}\` is creating a new branch inside the main clone (effective cwd: ${cwd}).`,
            cmd,
        );
    } else {
        emitBlock(
            `\`git ${verb} ${cls.target}\` is switching the main clone away from main (effective cwd: ${cwd}).`,
            cmd,
        );
    }
    return 2;
}

module.exports = {
    CHECKOUT_OR_SWITCH,
    classify,
    isQolToolsMainClone,
    isMainClone,
    resolveEffectiveCwd,
};

if (require.main === module) {
    process.exit(main());
}
