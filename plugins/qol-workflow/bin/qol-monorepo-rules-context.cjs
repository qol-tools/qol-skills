#!/usr/bin/env node
/*
 * UserPromptSubmit hook: inject the `qol-monorepo-rules` skill body on every
 * prompt submitted from a qol-tools repository path.
 *
 * Unlike qol-cicd-context, this hook has NO topic pattern. The rules it carries
 * (PR opt-in, standards evolution, guest-VM verification, the build/test gate)
 * used to live in the monorepo root CLAUDE.md and fired unconditionally. A
 * skill fires on description match; a hook fires always. That difference is the
 * whole reason this file exists - do not add a topic gate.
 *
 * Silent on errors - a failing reminder must never block the prompt.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const QOL_WORKSPACE_PATTERN =
    /(?:^|[\\/])(?:qol-tools|qol-[a-z0-9][a-z0-9-]*|plugin-[a-z0-9][a-z0-9-]*)(?:[\\/]|$)/i;

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

    const event = payload.hook_event_name || payload.event || '';
    if (event && event !== 'UserPromptSubmit') return 0;

    const cwd = payload.cwd || process.env.PWD || '';
    if (!QOL_WORKSPACE_PATTERN.test(cwd)) return 0;

    const skillFile = path.join(resolvePluginRoot(), 'skills', 'qol-monorepo-rules', 'SKILL.md');
    if (!fs.existsSync(skillFile)) return 0;

    let skillContent;
    try {
        skillContent = fs.readFileSync(skillFile, 'utf8');
    } catch {
        return 0;
    }

    const body = stripFrontmatter(skillContent).trim();
    if (!body) return 0;

    const context = `REMINDER from qol-monorepo-rules-context hook (plugin:qol-workflow:qol-monorepo-rules skill):

${body}`;

    const out = {
        hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: context,
        },
    };
    process.stdout.write(JSON.stringify(out));
    return 0;
}

module.exports = { stripFrontmatter, QOL_WORKSPACE_PATTERN };

if (require.main === module) {
    process.exit(main());
}
