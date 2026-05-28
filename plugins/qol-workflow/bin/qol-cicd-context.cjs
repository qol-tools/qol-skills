#!/usr/bin/env node
/*
 * PreToolUse hook (Bash matcher): when Claude is about to discuss or change
 * CI workflows, shared git hooks, or repo bootstrap inside qol-tools, inject
 * the `qol-cicd-infra` skill content as additionalContext so the existing
 * infrastructure in qol-cicd is in front of Claude BEFORE a design proposal.
 *
 * Silent on errors - a failing reminder must never block a command.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CI_HOOK_PATTERN = /\b(cargo-husky|lefthook|husky|cargo-assist|pre-push|pre-commit|workflow_call|workflow_dispatch|qol-install-hooks|qol-sync)\b|\.github\/workflows|\.git\/hooks/;
const QOL_WORKSPACE_PATTERN = /qol-tools/;

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
    if (!cmd) return 0;

    const cwd = payload.cwd || process.env.PWD || '';

    if (!CI_HOOK_PATTERN.test(cmd)) return 0;
    if (!QOL_WORKSPACE_PATTERN.test(cwd) && !QOL_WORKSPACE_PATTERN.test(cmd)) return 0;

    const skillFile = path.join(resolvePluginRoot(), 'skills', 'qol-cicd-infra', 'SKILL.md');
    if (!fs.existsSync(skillFile)) return 0;

    let skillContent;
    try {
        skillContent = fs.readFileSync(skillFile, 'utf8');
    } catch {
        return 0;
    }

    const body = stripFrontmatter(skillContent).trim();
    if (!body) return 0;

    const context = `REMINDER from qol-cicd-context hook (plugin:qol-workflow:qol-cicd-infra skill):

${body}

Apply these rules to the change you are about to make. Read qol-cicd first.`;

    const out = {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: context,
        },
    };
    process.stdout.write(JSON.stringify(out));
    return 0;
}

module.exports = { stripFrontmatter, CI_HOOK_PATTERN, QOL_WORKSPACE_PATTERN };

if (require.main === module) {
    process.exit(main());
}
