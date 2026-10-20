#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const lintMode = require('./hook-lint-mode.cjs');
const { readExistingFile, prospectiveContent } = require('./hook-edit-content.cjs');
const { inQolRepo } = require('./qol-repo.cjs');

const INSPECTED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const MANIFEST = 'plugin.toml';
const SKILL_SECTION = 'qol-project:qol-arch-code, "Enforcement: plugin data guard"';

const OPENS_WITHOUT_LAUNCHER_ENTRY = new Set(['qol-launcher', 'qol-alt-tab']);

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function parseValue(text) {
    const quoted = /^"([^"]*)"/.exec(text);
    if (quoted) return quoted[1];
    if (/^true\b/.test(text)) return true;
    if (/^false\b/.test(text)) return false;
    return text;
}

function parseManifest(content) {
    const manifest = { plugin: null, actions: new Map(), shortcuts: [], launcher: false };
    let table = null;
    content.split(/\r?\n/).forEach((raw, index) => {
        const line = raw.trim();
        const header = /^(\[\[?)\s*([^\]]+?)\s*\]\]?$/.exec(line);
        if (header) {
            const name = header[2];
            const array = header[1] === '[[';
            table = { line: index + 1, values: {} };
            const action = /^action\.(?:"([^"]+)"|([\w-]+))$/.exec(name);
            if (array && name === 'shortcuts') manifest.shortcuts.push(table);
            else if (array) return;
            else if (name === 'plugin') manifest.plugin = table;
            else if (name === 'launcher') manifest.launcher = true;
            else if (action) manifest.actions.set(action[1] ?? action[2], table);
            return;
        }
        const pair = /^([\w-]+)\s*=\s*(.+)$/.exec(line);
        if (pair && table) table.values[pair[1]] = parseValue(pair[2].trim());
    });
    return manifest;
}

function reachesOpenFromLauncher(manifest) {
    if (manifest.launcher) return true;
    return manifest.shortcuts.some(shortcut =>
        (shortcut.values.action ?? 'open') === 'open' && shortcut.values.export_to_launcher !== false);
}

function dataGaps(content, dir) {
    if (!content) return [];
    const manifest = parseManifest(content);
    if (!manifest.plugin) return [];
    const gaps = [];
    const open = manifest.actions.get('open');
    const runs = open && (open.values.kind ?? 'run') === 'run';
    if (runs && !OPENS_WITHOUT_LAUNCHER_ENTRY.has(manifest.plugin.values.id) && !reachesOpenFromLauncher(manifest)) {
        gaps.push({
            rule: 'launcher',
            text: `Open action has no launcher entry in ${MANIFEST}: line ${open.line} declares [action.open], but no [[shortcuts]] entry exports it and there is no [launcher] flow, so the launcher cannot start this plugin and only its Open row in qol settings can. Add [[shortcuts]] with id = "open", name = "<what the launcher lists>", action = "open", export_to_launcher = true.`,
        });
    }
    const settings = [...manifest.actions.values()].some(action => action.values.kind === 'settings');
    if (!settings && fs.existsSync(path.join(dir, 'qol-config.toml'))) {
        gaps.push({
            rule: 'settings',
            text: `Settings contract has no settings action in ${MANIFEST}: line ${manifest.plugin.line} starts a plugin that ships qol-config.toml but declares no action with kind = "settings", so the launcher lists no "Settings > ${manifest.plugin.values.name ?? 'plugin'}" entry. Add [action.settings] with label = "Settings", kind = "settings", args = ["--settings"]; the tray hosts that page itself only with [capabilities] gpui = true.`,
        });
    }
    return gaps;
}

function newGaps(filePath, before, after) {
    const dir = path.dirname(filePath);
    const known = new Set(dataGaps(before, dir).map(gap => gap.rule));
    return dataGaps(after, dir).filter(gap => !known.has(gap.rule));
}

function reason(gap) {
    return `${gap.text}\n[qol-plugin-data] ship the missing entry in the same edit (${SKILL_SECTION})`;
}

function deny(gaps) {
    if (lintMode.active()) {
        for (const gap of gaps) lintMode.report(process.stderr, reason(gap));
        return;
    }
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: gaps.map(reason).join('\n\n'),
        },
    }) + '\n');
}

function evaluate(payload) {
    const tool = payload.tool_name || '';
    if (!INSPECTED_TOOLS.has(tool)) return 0;
    const input = payload.tool_input || {};
    const filePath = input.file_path || '';
    if (path.basename(filePath) !== MANIFEST || !inQolRepo(filePath)) return 0;
    const existing = readExistingFile(filePath);
    const gaps = newGaps(filePath, existing, prospectiveContent(tool, input, existing));
    if (gaps.length === 0) return 0;
    deny(gaps);
    return 2;
}

function main() {
    let payload;
    try {
        payload = JSON.parse(readStdin() || '{}');
    } catch {
        return;
    }
    evaluate(payload);
}

function lintFile(filePath, content, baseline = null) {
    return lintMode.run(filePath, () => evaluate({
        tool_name: 'Write',
        tool_input: { file_path: filePath, content },
    }), baseline);
}

module.exports = { lintFile };

if (require.main === module) {
    try {
        main();
    } catch {}
    process.exit(0);
}
