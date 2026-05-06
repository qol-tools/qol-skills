#!/usr/bin/env node
/*
 * PreToolUse hook (Bash matcher): block ANY agent-initiated `git checkout <ref>`
 * or `git switch <branch>`. Absolute — no main-clone scope check, no bypass
 * marker. Complements `branch-deny-checkout-in-main-clone` (which is scoped
 * to qol-* main clones and has a bypass) by enforcing the harder rule that
 * the agent is never allowed to switch branches, anywhere.
 *
 * Allowed:
 *   - file reverts: `git checkout -- <file>`, `git checkout HEAD -- <file>`,
 *     `git checkout <ref> -- <file>` (anything with `--` separator)
 *   - `git worktree add -b <branch> <path>` (the regex matches only the
 *     `checkout`/`switch` verbs, not `worktree`)
 *   - bare `git checkout` with no args
 *
 * Blocked: every other `git checkout` / `git switch` form, including
 * `git checkout main`. The user may run any of these themselves with the
 * `!` prefix in the Claude Code prompt (which bypasses PreToolUse(Bash)).
 */

'use strict';

const fs = require('node:fs');
const { CHECKOUT_OR_SWITCH, classify } = require('./branch-deny-checkout-in-main-clone.cjs');

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function emitBlock(verb, target, command) {
    process.stderr.write(`git branch switch BLOCKED by qol-workflow:branch-deny-agent-checkout hook.

The agent is not allowed to switch branches, period. Only the user may.

Command: ${command.trim()}

If the user actually wants this, they should run it themselves with the \`!\` prefix in the prompt:

  ! git ${verb} ${target || '<...>'}

If the agent thinks it needs to switch branches, it should ask the user instead.
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

    const m = cmd.match(CHECKOUT_OR_SWITCH);
    if (!m) return 0;
    const verb = m[2];
    const cls = classify(m[3] || '');

    if (cls.kind === 'noop' || cls.kind === 'path') return 0;

    emitBlock(verb, cls.target || '', cmd);
    return 2;
}

module.exports = {};

if (require.main === module) {
    process.exit(main());
}
