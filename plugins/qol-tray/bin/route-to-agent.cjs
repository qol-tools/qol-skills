#!/usr/bin/env node
/*
 * PreToolUse hook: when editing qol-tray frontend/backend files, inject the
 * relevant skill context so the model has domain knowledge without needing a
 * subagent. Edits are never blocked; the hook only enriches context.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INSPECTED_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const HOOK_OWNED_SUFFIXES = ['/MEMORY.md', '/.reflect-last.log'];

// From CLAUDE_PLUGIN_ROOT (.../cache/qol-skills/qol-tray/<ver>), go up 4
// levels to reach the plugins root.
function marketplacePluginsDir(pluginRoot) {
    return path.resolve(pluginRoot, '../../../../marketplaces/qol-skills/plugins');
}

function readSkillFile(pluginsDir, pluginName, skillName) {
    const p = path.join(pluginsDir, pluginName, 'skills', skillName, 'SKILL.md');
    try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function buildContext(pluginsDir, scope) {
    const sections = [];

    if (scope === 'backend') {
        const rust = readSkillFile(pluginsDir, 'qol-tray', 'qol-tray-rust');
        const conv = readSkillFile(pluginsDir, 'qol-langs', 'rust-conventions');
        if (rust) sections.push(`# qol-tray-rust skill\n\n${rust}`);
        if (conv) sections.push(`# rust-conventions skill\n\n${conv}`);
    } else {
        const ui = readSkillFile(pluginsDir, 'qol-tray', 'qol-tray-ui-systems');
        const conv = readSkillFile(pluginsDir, 'qol-langs', 'preact-conventions');
        if (ui) sections.push(`# qol-tray-ui-systems skill\n\n${ui}`);
        if (conv) sections.push(`# preact-conventions skill\n\n${conv}`);
    }

    return sections.join('\n\n---\n\n');
}

function classifyScope(filePath) {
    if (filePath.includes('/qol-tray/ui/')) return 'frontend';
    if (filePath.includes('/qol-tray/src/')) return 'backend';
    return null;
}

function main() {
    const raw = (() => { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } })().trim();
    if (!raw) return 0;

    let payload;
    try { payload = JSON.parse(raw); } catch { return 0; }

    const tool = payload.tool_name || payload.tool || '';
    if (!INSPECTED_TOOLS.has(tool)) return 0;

    const input = payload.tool_input || {};
    const filePath = input.file_path || input.notebook_path || '';
    if (!filePath) return 0;

    if (HOOK_OWNED_SUFFIXES.some(s => filePath.endsWith(s))) return 0;

    const scope = classifyScope(filePath);
    if (!scope) return 0;

    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT || path.resolve(__dirname, '..');
    const pluginsDir = marketplacePluginsDir(pluginRoot);
    const context = buildContext(pluginsDir, scope);
    if (!context) return 0;

    const label = scope === 'backend' ? 'qol-tray-rust + rust-conventions' : 'qol-tray-ui-systems + preact-conventions';
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            additionalContext: `[scope: qol-tray ${scope} - skills loaded: ${label}]\n\n${context}`,
        },
    }));
    return 0;
}

module.exports = { classifyScope };

if (require.main === module) {
    process.exit(main());
}
