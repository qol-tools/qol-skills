#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
    if (lintMode.isTarget(filePath)) return lintMode.baseline();
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

function denyReason(where, added) {
    return `New ${added.join(', ')} in ${where}: outside a cli, build or tools module, qol code writes only log:: (log) or qol_runtime::probe! (trace), and dbg! nowhere.\n` +
        `[qol-logging] use log::error!/warn!/info!/debug! or probe!, or return the text to a cli module that prints it (qol-project:qol-arch-code, "Output: log, trace, command output")`;
}

function deny(filePath, added) {
    const reason = denyReason(path.basename(filePath), added);
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

function inspectedSignals(filePath) {
    if (!filePath.endsWith('.rs') || !QOL_PATH_RE.test(filePath)) return [];
    if (TEST_PATH_RES.some(re => re.test(filePath))) return [];
    const commandOutputAllowed = COMMAND_OUTPUT_PATH_RES.some(re => re.test(filePath));
    return SIGNALS.filter(signal => !(commandOutputAllowed && signal.commandOutput));
}

const SHELL_RS_PATH_RE = /[\w./~-]+\.rs\b/g;
const SHELL_WRITE_RE = /<<|\bsed\s+(-\w+\s+)*-i|\bperl\b|\bpython3?\b|\bnode\b|\bruby\b|\btee\b|\bpatch\b|\bgit\s+apply\b|>>?\s*[\w./~-]+\.rs\b/;

function shellSignal(signal) {
    return new RegExp(signal.re.source.replace(/(\w)!/, '$1\\\\?!'), 'g');
}

function commandRsPaths(command, cwd) {
    return [...new Set(command.match(SHELL_RS_PATH_RE) || [])]
        .map(file => path.resolve(cwd, file.replace(/^~(?=\/)/, os.homedir())));
}

function evaluateCommand(payload) {
    const command = (payload.tool_input || {}).command || '';
    if (!SHELL_WRITE_RE.test(command)) return false;
    const cwd = payload.cwd || process.cwd();
    const targets = commandRsPaths(command, cwd).map(inspectedSignals).filter(signals => signals.length);
    if (targets.length === 0) return false;
    const added = SIGNALS
        .filter(signal => targets.some(signals => signals.includes(signal)))
        .filter(signal => shellSignal(signal).test(command))
        .map(signal => signal.name);
    if (added.length === 0) return false;
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: denyReason('a shell command that writes Rust files', added),
        },
    }) + '\n');
    return true;
}

function git(cwd, args) {
    const result = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return result.status === 0 ? result.stdout : null;
}

function dirtyRustFiles(root) {
    const status = git(root, ['status', '--porcelain', '-z', '--untracked-files=all', '--', '*.rs']);
    if (status === null) return [];
    const files = [];
    const entries = status.split('\0');
    for (let index = 0; index < entries.length; index += 1) {
        const entry = entries[index];
        if (entry.length <= 3) continue;
        if ('RC'.includes(entry[0])) index += 1;
        if (entry[0] === 'D' || entry[1] === 'D') continue;
        const file = path.join(root, entry.slice(3));
        if (inspectedSignals(file).length) files.push(file);
    }
    return files;
}

function snapshotPath(payload) {
    const key = String(payload.tool_use_id || payload.session_id || 'bash').replace(/[^\w-]/g, '_');
    return path.join(os.tmpdir(), `qol-logging-bash-${key}.json`);
}

function repoRoot(payload) {
    const cwd = payload.cwd || process.cwd();
    if (!QOL_PATH_RE.test(cwd + path.sep)) return null;
    const root = git(cwd, ['rev-parse', '--show-toplevel']);
    return root === null ? null : root.trim();
}

function snapshotCommand(payload) {
    const root = repoRoot(payload);
    if (root === null) return;
    const files = {};
    for (const file of dirtyRustFiles(root)) {
        try {
            files[file] = fs.readFileSync(file, 'utf8');
        } catch {}
    }
    fs.writeFileSync(snapshotPath(payload), JSON.stringify({ root, files }));
}

function headContent(root, file) {
    return git(root, ['show', `HEAD:${path.relative(root, file).split(path.sep).join('/')}`]) || '';
}

function reviewCommand(payload) {
    const snapshot = snapshotPath(payload);
    let before;
    try {
        before = JSON.parse(fs.readFileSync(snapshot, 'utf8'));
        fs.unlinkSync(snapshot);
    } catch {
        return;
    }
    const found = [];
    for (const file of dirtyRustFiles(before.root)) {
        let after;
        try {
            after = fs.readFileSync(file, 'utf8');
        } catch {
            continue;
        }
        const previous = before.files[file] ?? headContent(before.root, file);
        const added = addedSignals(previous, after, inspectedSignals(file));
        if (added.length) found.push(`${path.relative(before.root, file)} (${added.join(', ')})`);
    }
    if (found.length === 0) return;
    process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: `${denyReason(found.join('; '), ['prints'])}\nThat command already wrote them: remove them now.`,
    }) + '\n');
}

function evaluate(payload) {
    const tool = payload.tool_name || '';
    if (tool === 'Bash') {
        if (payload.hook_event_name === 'PostToolUse') return reviewCommand(payload);
        if (!evaluateCommand(payload)) snapshotCommand(payload);
        return;
    }
    if (!INSPECTED_TOOLS.has(tool)) return;
    const input = payload.tool_input || {};
    const filePath = input.file_path || '';
    const signals = inspectedSignals(filePath);
    if (signals.length === 0) return;

    const existing = readExistingFile(filePath);
    const after = prospectiveContent(tool, input, existing);
    const added = addedSignals(existing || '', after, signals);
    if (added.length === 0) return 0;
    deny(filePath, added);
    return 2;
}

function lintFile(filePath, content, baseline = null) {
    return lintMode.run(filePath, () => evaluate({
        tool_name: 'Write',
        tool_input: { file_path: filePath, content },
    }), baseline);
}

const LOCATORS = SIGNALS.map(signal => ({ label: signal.name, re: signal.re }));

module.exports = { lintFile, LOCATORS };

if (require.main === module) {
    try {
        main();
    } catch {}
    process.exit(0);
}
