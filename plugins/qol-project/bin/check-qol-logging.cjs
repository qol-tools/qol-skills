#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INSPECTED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const QOL_PATH_RE = /[\\/]qol-[^\\/]+[\\/]/;

const TEST_PATH_RES = [
    /[\\/](tests|examples|benches)[\\/]/,
    /_tests?\.rs$/,
];

const COMMAND_OUTPUT_PATH_RES = [
    /[\\/]cli\.rs$/,
    /_cli\.rs$/,
    /[\\/]cli[\\/]/,
    /[\\/]build\.rs$/,
    /[\\/]build[\\/]/,
    /[\\/]qol-monorepo[\\/]tools[\\/]/,
    /[\\/]apps[\\/]tray[\\/]src[\\/]logging[\\/]/,
    /[\\/]libs[\\/]log[\\/]/,
    /[\\/]libs[\\/]headless[\\/]/,
];

const SIGNALS = [
    { name: 'eprintln!', re: /\beprintln!\s*[(\[{]/g, commandOutput: true },
    { name: 'eprint!', re: /\beprint!\s*[(\[{]/g, commandOutput: true },
    { name: 'println!', re: /\bprintln!\s*[(\[{]/g, commandOutput: true },
    { name: 'print!', re: /(?<!\w)print!\s*[(\[{]/g, commandOutput: true },
    { name: 'io::stdout()', re: /\bio::stdout\s*\(\s*\)/g, commandOutput: true },
    { name: 'io::stderr()', re: /\bio::stderr\s*\(\s*\)/g, commandOutput: true },
    { name: 'allow(clippy::print_*)', re: /#!?\[\s*(?:allow|expect)\s*\([^\]]*clippy::(?:print_stdout|print_stderr)/g, commandOutput: true },
    { name: 'dbg!', re: /\bdbg!\s*[(\[{]/g, commandOutput: false },
    { name: 'allow(clippy::dbg_macro)', re: /#!?\[\s*(?:allow|expect)\s*\([^\]]*clippy::dbg_macro/g, commandOutput: false },
];

const lintMode = require('./hook-lint-mode.cjs');

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function readExistingFile(filePath) {
    if (lintMode.isTarget(filePath)) return null;
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

function countSignals(content, signals) {
    const view = productionView(content);
    return signals.map(signal => (view.match(signal.re) || []).length);
}

function addedSignals(before, after, signals) {
    const was = countSignals(before, signals);
    const now = countSignals(after, signals);
    return signals.filter((_, index) => now[index] > was[index]).map(signal => signal.name);
}

function deny(filePath, added) {
    const reason =
        `New ${added.join(', ')} in ${path.basename(filePath)}: outside a cli, build or tools module, qol code writes only log:: (log) or qol_runtime::probe! (trace), and dbg! nowhere.\n` +
        `[qol-logging] use log::error!/warn!/info!/debug! or probe!, or return the text to a cli module that prints it (qol-project:qol-arch-code, "Output: log, trace, command output")`;
    if (lintMode.active()) {
        lintMode.report(process.stderr, reason);
        return;
    }
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
    evaluate(payload);
}

function evaluate(payload) {
    const tool = payload.tool_name || '';
    if (!INSPECTED_TOOLS.has(tool)) return;
    const input = payload.tool_input || {};
    const filePath = input.file_path || '';
    if (!filePath.endsWith('.rs') || !QOL_PATH_RE.test(filePath)) return;
    if (TEST_PATH_RES.some(re => re.test(filePath))) return;
    const commandOutputAllowed = COMMAND_OUTPUT_PATH_RES.some(re => re.test(filePath));
    const signals = SIGNALS.filter(signal => !(commandOutputAllowed && signal.commandOutput));

    const existing = readExistingFile(filePath);
    const after = prospectiveContent(tool, input, existing);
    const added = addedSignals(existing || '', after, signals);
    if (added.length === 0) return 0;
    deny(filePath, added);
    return 2;
}

function lintFile(filePath, content) {
    return lintMode.run(filePath, () => evaluate({
        tool_name: 'Write',
        tool_input: { file_path: filePath, content },
    }));
}

module.exports = { lintFile };

if (require.main === module) {
    try {
        main();
    } catch {}
    process.exit(0);
}
