#!/usr/bin/env node
/*
 * UserPromptSubmit hook: when the user's message mentions CI, workflows, git
 * hooks, or repo bootstrap topics and the session is rooted in qol-tools,
 * inject the `qol-cicd-infra` skill content as additionalContext so the
 * repository workflow ownership and architecture constraints are in front of
 * Claude BEFORE the first reply.
 *
 * Fires on prompt submit, not on tool calls. Design happens in prose, so the
 * trigger has to be the prose. Tool-call matchers fire after the design
 * decision is already made.
 *
 * Silent on errors - a failing reminder must never block the prompt.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const CICD_TOPIC_PATTERN = /\b(CI|CI\/CD|pipeline|workflow|workflows|github actions|reusable workflow|workflow_call|workflow_dispatch|git hook|git hooks|pre-commit|pre-push|commit-msg|cargo-husky|lefthook|husky|cargo-assist|qol-cicd|qol-install-hooks|qol-sync|rustfmt|cargo fmt|cargo clippy|bootstrap|repo setup)\b/i;
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

    const prompt = payload.prompt || payload.user_prompt || '';
    if (!prompt) return 0;

    const cwd = payload.cwd || process.env.PWD || '';

    if (!CICD_TOPIC_PATTERN.test(prompt)) return 0;
    if (!QOL_WORKSPACE_PATTERN.test(cwd)) return 0;

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

The user's message touches CI/workflow/git-hook territory in a qol-* or plugin-* repository path. Route the change from the current repository root. In qol-monorepo, read qol-project:qol-cicd and qol-project:qol-arch-cicd and treat its .github workflows and scripts as product CI. In qol-skills, inspect its own .github workflows, scripts, hooks, and tests. Don't introduce a separate workflow repository or parallel hook manager.`;

    const out = {
        hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: context,
        },
    };
    process.stdout.write(JSON.stringify(out));
    return 0;
}

module.exports = { stripFrontmatter, CICD_TOPIC_PATTERN, QOL_WORKSPACE_PATTERN };

if (require.main === module) {
    process.exit(main());
}
