#!/usr/bin/env node
/*
 * PreToolUse hook (Bash matcher): when the agent runs `git checkout <ref>` or
 * `git switch <branch>`, force a user-approval prompt instead of letting the
 * tool call run automatically. Complements `branch-deny-checkout-in-main-clone`
 * (which blocks outright in qol-* main clones with a bypass marker) by
 * adding a milder, always-on confirmation everywhere else.
 *
 * Allowed silently:
 *   - file reverts: `git checkout -- <file>`, `git checkout HEAD -- <file>`,
 *     `git checkout <ref> -- <file>` (anything with `--` separator)
 *   - `git worktree add -b <branch> <path>` (the regex matches only the
 *     `checkout`/`switch` verbs, not `worktree`)
 *   - bare `git checkout` with no args
 *
 * Asks (permissionDecision = "ask"): every other `git checkout` / `git switch`
 * form, including `git checkout main`. The user sees a permission prompt and
 * can approve or deny. Approving runs the command; denying lets the agent
 * decide what to do next.
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

function emitAsk(verb, target, command) {
    const reason = `The agent is asking to switch branches. Approve only if this is what you want.

Command: ${command.trim()}

If you (the user) want this, approve. The agent should not switch branches autonomously — only the user should.`;

    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'ask',
            permissionDecisionReason: reason,
        },
    }));
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

    emitAsk(verb, cls.target || '', cmd);
    return 0;
}

module.exports = {};

if (require.main === module) {
    process.exit(main());
}
