#!/usr/bin/env node
/*
 * PreToolUse hook (Bash matcher): when Claude is about to run `git commit`,
 * inject the qol-tools `commit` skill content as additionalContext so Claude
 * is reminded of the conventions BEFORE forming the commit message.
 *
 * Proactive half. The reactive half is `commit-deny-coauthor.cjs`, which
 * blocks commits whose message already contains an AI attribution.
 *
 * Silent on errors — a failing reminder must never block a commit.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const COMMIT_INVOCATION = /(^|[\s;&|`])git\s+([a-z-]+\s+)*commit(\s|$)/;

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function stripFrontmatter(skillContent) {
    const lines = skillContent.split(/\r?\n/);
    let dashCount = 0;
    let bodyStart = -1;
    for (let i = 0; i < lines.length; i++) {
        if (/^---\s*$/.test(lines[i])) {
            dashCount++;
            if (dashCount === 2) {
                bodyStart = i + 1;
                break;
            }
        }
    }
    // Match the bash original: require both delimiters. No frontmatter → empty.
    if (bodyStart === -1) return '';
    return lines.slice(bodyStart).join('\n');
}

function resolvePluginRoot() {
    if (process.env.CLAUDE_PLUGIN_ROOT) return process.env.CLAUDE_PLUGIN_ROOT;
    return path.resolve(__dirname, '..');
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

    const tool = payload.tool_name || payload.tool || '';
    if (tool !== 'Bash') return 0;

    const cmd = (payload.tool_input && payload.tool_input.command) || '';
    if (!cmd || !COMMIT_INVOCATION.test(cmd)) return 0;

    const skillFile = path.join(resolvePluginRoot(), 'skills', 'commit', 'SKILL.md');
    if (!fs.existsSync(skillFile)) return 0;

    let skillContent;
    try {
        skillContent = fs.readFileSync(skillFile, 'utf8');
    } catch {
        return 0;
    }

    const body = stripFrontmatter(skillContent).trim();
    if (!body) return 0;

    const context = `REMINDER from pre-commit hook (plugin:qol-host:commit skill):

${body}

Apply these rules to the commit you are about to make. The hard rule on no
AI attribution is enforced by a separate deny hook — do not test it.`;

    const out = {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: context,
        },
    };
    process.stdout.write(JSON.stringify(out));
    return 0;
}

module.exports = { stripFrontmatter, COMMIT_INVOCATION };

if (require.main === module) {
    process.exit(main());
}
