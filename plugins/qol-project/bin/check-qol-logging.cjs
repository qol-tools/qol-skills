#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const INSPECTED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);

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

const FS_MUTATORS = ['write', 'create_dir', 'create_dir_all', 'rename', 'copy', 'set_permissions', 'hard_link', 'soft_link'];
const FS_CALL_RE = new RegExp(`(?<![\\w.])((?:std\\s*::\\s*)?fs)\\s*::\\s*(${FS_MUTATORS.join('|')})\\s*\\(`, 'g');
const FS_BINDING_RE = /(?:\blet\s+_|(?<![\w.])_)\s*=(?![=>])\s*$/;
const FS_ADAPTER_RE = /^\s*\.\s*(ok|unwrap_or_default|unwrap_or)\s*\(/;
const FS_EMPTY_ARM = String.raw`=>\s*(?:\{\s*\}|\(\s*\))\s*,?`;
const FS_ERR_ARM_RE = new RegExp(String.raw`(?<![\w:])Err\s*\(\s*(?:_\w*|\.\.)\s*\)\s*${FS_EMPTY_ARM}`, 'g');
const FS_ANY_ARM_RE = new RegExp(String.raw`(?<![\w:])_\s*${FS_EMPTY_ARM}`, 'g');
const FS_ERR_PATTERN_RE = /(?<![\w:])Err\b/g;
const FS_SKILL_SECTION = 'qol-project:qol-arch-code, "File system results thrown away"';

const lintMode = require('./hook-lint-mode.cjs');
const { inQolRepo } = require('./qol-repo.cjs');
const { readExistingFile, prospectiveContent } = require('./hook-edit-content.cjs');
const serde = require('./rust-serde.cjs');
const { entryGaps } = require('./process-entry.cjs');

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function countSignals(file, content, signals) {
    const view = serde.production(file, content)?.clean ?? '';
    return signals.map(signal => (view.match(signal.re) || []).length);
}

function addedSignals(file, before, after, signals) {
    const was = countSignals(file, before, signals);
    const now = countSignals(file, after, signals);
    return signals.filter((_, index) => now[index] > was[index]).map(signal => signal.name);
}

function lineOf(content, offset) {
    let line = 1;
    for (let index = content.indexOf('\n'); index !== -1 && index < offset; index = content.indexOf('\n', index + 1)) line++;
    return line;
}

function closing(text, open, left, right) {
    let depth = 0;
    for (let index = open; index < text.length; index++) {
        if (text[index] === left) depth++;
        else if (text[index] === right && --depth === 0) return index;
    }
    return -1;
}

function followsStatementBoundary(skeleton, start) {
    const before = skeleton.slice(0, start).trimEnd();
    return before === '' || ';{}'.includes(before[before.length - 1]);
}

function followsPathSegment(skeleton, start) {
    const before = skeleton.slice(0, start).trimEnd();
    if (!before.endsWith('::')) return false;
    return /[\w>]$/.test(before.slice(0, -2).trimEnd());
}

function topLevelArms(body, re) {
    const depths = new Int32Array(body.length + 1);
    for (let index = 0, depth = 0; index < body.length; index++) {
        if ('({['.includes(body[index])) depth++;
        else if (')}]'.includes(body[index])) depth = Math.max(0, depth - 1);
        depths[index + 1] = depth;
    }
    return [...body.matchAll(re)].filter(arm => {
        if (depths[arm.index] !== 0) return false;
        const before = body.slice(0, arm.index).trimEnd();
        return before === '' || ',}'.includes(before[before.length - 1]);
    });
}

function matchDropsError(skeleton, open) {
    const close = closing(skeleton, open, '{', '}');
    if (close < 0) return false;
    const body = skeleton.slice(open + 1, close);
    if (topLevelArms(body, FS_ERR_ARM_RE).length > 0) return true;
    return topLevelArms(body, FS_ANY_ARM_RE).length > 0 && topLevelArms(body, FS_ERR_PATTERN_RE).length === 0;
}

function adapterEnd(skeleton, close) {
    const adapter = FS_ADAPTER_RE.exec(skeleton.slice(close + 1));
    if (!adapter) return close;
    const open = close + adapter[0].length;
    const end = closing(skeleton, open, '(', ')');
    if (end < 0) return -1;
    const empty = skeleton.slice(open + 1, end).trim() === '';
    return adapter[1] === 'unwrap_or' || empty ? end : -1;
}

function thrownAwayShape(skeleton, call, close) {
    const origin = skeleton.slice(0, call.index).replace(/::\s*$/, '').length;
    const before = skeleton.slice(Math.max(0, origin - 64), origin);
    const end = adapterEnd(skeleton, close);
    if (end >= 0 && /^\s*;/.test(skeleton.slice(end + 1))) {
        if (FS_BINDING_RE.test(before)) return true;
        if (end > close && followsStatementBoundary(skeleton, origin)) return true;
    }
    const opening = /^\s*\{/.exec(skeleton.slice(close + 1));
    return Boolean(opening) && /(?<![\w.])match\s+$/.test(before) && matchDropsError(skeleton, close + opening[0].length);
}

function fsGaps(filePath, content) {
    if (!/\bfs\s*::/.test(content)) return [];
    const code = serde.production(path.resolve(filePath), content);
    if (!code) return [];
    const gaps = [];
    for (const call of code.skeleton.matchAll(FS_CALL_RE)) {
        if (followsPathSegment(code.skeleton, call.index)) continue;
        const close = closing(code.skeleton, call.index + call[0].length - 1, '(', ')');
        if (close < 0 || !thrownAwayShape(code.skeleton, call, close)) continue;
        const spelled = call[1].replace(/\s+/g, '');
        gaps.push(`File system result thrown away in ${path.basename(filePath)}: on line ${lineOf(content, call.index)}, ${spelled}::${call[2]}(..) drops the error of std::fs::${call[2]}; return it with ? or log it with log::warn! naming the path.\n` +
            `[qol-logging] handle the error of this call in this edit (${FS_SKILL_SECTION})`);
    }
    return gaps;
}

function denyReason(where, added) {
    return `New ${added.join(', ')} in ${where}: outside a cli, build or tools module, qol code writes only log:: (log) or qol_runtime::probe! (trace), and dbg! nowhere.\n` +
        `[qol-logging] use log::error!/warn!/info!/debug! or probe!, or return the text to a cli module that prints it (qol-project:qol-arch-code, "Output: log, trace, command output")`;
}

function deny(filePath, added, gaps = []) {
    const reasons = [
        ...(added.length ? [denyReason(path.basename(filePath), added)] : []),
        ...gaps,
    ];
    if (lintMode.active()) {
        for (const reason of reasons) lintMode.report(process.stderr, reason);
        return;
    }
    const reason = reasons.join('\n\n');
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
    if (!filePath.endsWith('.rs') || !inQolRepo(filePath)) return [];
    if (serde.isTestFile(path.resolve(filePath))) return [];
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
    if (!inQolRepo(cwd)) return null;
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
        const added = addedSignals(file, previous, after, inspectedSignals(file));
        if (added.length) found.push(`${path.relative(before.root, file).split(path.sep).join('/')} (${added.join(', ')})`);
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
    if (!filePath.endsWith('.rs') || !inQolRepo(filePath)) return;
    const signals = inspectedSignals(filePath);

    const existing = readExistingFile(filePath);
    const after = prospectiveContent(tool, input, existing);
    const added = addedSignals(filePath, existing || '', after, signals);
    const gaps = [...fsGaps(filePath, after), ...entryGaps(filePath, after)];
    if (added.length === 0 && gaps.length === 0) return 0;
    deny(filePath, added, gaps);
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
