#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INSPECTED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const QOL_PATH_RE = /[\\/]qol-[^\\/]+[\\/]/;

const EXEMPT_PATH_RES = [
    /[\\/](tests|examples|benches)[\\/]/,
    /_tests?\.rs$/,
    /[\\/]build\.rs$/,
    /[\\/]cli\.rs$/,
    /[\\/]cli[\\/]/,
    /[\\/]qol-monorepo[\\/]tools[\\/]/,
    /[\\/]apps[\\/]tray[\\/]src[\\/]logging[\\/]/,
    /[\\/]libs[\\/]log[\\/]/,
    /[\\/]libs[\\/]runtime[\\/]src[\\/](probe|event_tap_trace)\.rs$/,
    /[\\/]libs[\\/]plugin-daemon[\\/]src[\\/]logger\.rs$/,
];

const MACROS = ['eprintln', 'eprint', 'dbg'];

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function readExistingFile(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return null;
    }
}

function applyEdit(content, oldString, newString, replaceAll) {
    if (!oldString || !content.includes(oldString)) return null;
    if (replaceAll) return content.split(oldString).join(newString || '');
    return content.replace(oldString, () => newString || '');
}

function prospectiveContent(tool, input, existing) {
    if (tool === 'Write') return input.content || '';
    const edits = tool === 'Edit' ? [input] : input.edits || [];
    if (existing === null) return edits.map(edit => edit.new_string || '').join('\n');
    let content = existing;
    for (const edit of edits) {
        const next = applyEdit(content, edit.old_string, edit.new_string, edit.replace_all);
        if (next === null) return edits.map(item => item.new_string || '').join('\n');
        content = next;
    }
    return content;
}

function productionView(content) {
    return content
        .split(/\n\s*#\[cfg\(test\)\]\s*\n\s*mod\s+\w+\s*\{/)[0]
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/\/\/.*$/gm, '');
}

function countMacros(content) {
    const view = productionView(content);
    return Object.fromEntries(
        MACROS.map(name => [name, (view.match(new RegExp(`\\b${name}!\\s*[(\\[{]`, 'g')) || []).length]),
    );
}

function addedMacros(before, after) {
    const was = countMacros(before);
    const now = countMacros(after);
    return MACROS.filter(name => now[name] > was[name]);
}

function consumeBypass(cwd) {
    const marker = path.join(cwd, '.claude', 'bypass-qol-logging');
    try {
        if (!fs.statSync(marker).isFile()) return false;
        const raw = fs.readFileSync(marker, 'utf8').trim();
        const count = /^\d+$/.test(raw) ? Number(raw) : 1;
        if (count > 1) fs.writeFileSync(marker, String(count - 1));
        else fs.unlinkSync(marker);
        return true;
    } catch {
        return false;
    }
}

function deny(filePath, added) {
    const names = added.map(name => `${name}!`).join(', ');
    const reason =
        `New ${names} in ${path.basename(filePath)}: qol code logs through log::error!/warn!/info!/debug!, ` +
        `or qol_runtime::probe! for qol trace, never raw stderr prints.\n` +
        `[qol-logging] swap it for log:: or probe! (qol-project:qol-arch-code, "Logging and tracing"); ` +
        `one-off bypass: touch .claude/bypass-qol-logging`;
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
        },
    }) + '\n');
}

function main() {
    let payload;
    try {
        payload = JSON.parse(readStdin() || '{}');
    } catch {
        return;
    }
    const tool = payload.tool_name || '';
    if (!INSPECTED_TOOLS.has(tool)) return;
    const input = payload.tool_input || {};
    const filePath = input.file_path || '';
    if (!filePath.endsWith('.rs') || !QOL_PATH_RE.test(filePath)) return;
    if (EXEMPT_PATH_RES.some(re => re.test(filePath))) return;

    const existing = readExistingFile(filePath);
    const after = prospectiveContent(tool, input, existing);
    const added = addedMacros(existing || '', after);
    if (added.length === 0) return;
    if (consumeBypass(payload.cwd || process.cwd())) return;
    deny(filePath, added);
}

try {
    main();
} catch {}
process.exit(0);
