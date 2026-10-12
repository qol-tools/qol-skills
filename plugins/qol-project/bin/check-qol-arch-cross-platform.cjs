#!/usr/bin/env node
/*
 * qol-arch-cross-platform PreToolUse hook.
 *
 * Catches the patterns that produce dead_code / unused_imports / unused_mut
 * errors under `RUSTFLAGS=-D warnings` on platforms other than the one CI
 * happens to run on. These are the failures that compile green on Linux,
 * red on macOS or Windows, and only surface when a release pipeline or a
 * cross-platform CI matrix actually exercises the other OS.
 *
 * Rules (active on .rs files under any /qol-tools/ path, outside platform/,
 * tests/, examples/, tests.rs, and *_test.rs / *_tests.rs):
 *
 *   1. Block #[allow(dead_code)]  outside platform/. Hiding a dead-on-some-OS
 *      symbol behind allow doesn't fix it — it lets it rot. Move the symbol
 *      into the platform/ module that actually consumes it (relocate), gate
 *      it by cfg, or delete it.
 *   2. Block #[allow(unused_mut)] outside platform/. Same logic — restructure
 *      so the OS that doesn't mutate doesn't see the binding.
 *   3. Block #[cfg(target_os = ...)] on `use` statements outside platform/.
 *      Almost always a refactor leftover. Either move the consumer too, or
 *      split the file. (cfg on `mod` and `pub use` lines is allowed — that's
 *      the canonical mod.rs re-export pattern from qol-arch-code.)
 *
 * Bypass:
 *   touch .claude/bypass-qol-arch-cross-platform          # next 1 edit passes
 *   echo N > .claude/bypass-qol-arch-cross-platform       # next N edits pass
 *
 * Runs on Node — Claude Code requires Node, dependency is free across OSes.
 * Silent on errors — a failing hook must never block Claude irreversibly.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INSPECTED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const QOL_TOOLS_PATH_RE = /[\\/]qol-[^\\/]+[\\/]/;
const PLATFORM_PATH_RE = /[\\/]platform[\\/]/;
const TESTS_PATH_RE = /[\\/]tests[\\/]/;
const EXAMPLES_PATH_RE = /[\\/]examples[\\/]/;

function crossPlatformBasename(p) {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
}

const WINDOWS_SYSTEM_TOOLS = [
    'cmd', 'reg', 'explorer', 'netsh', 'icacls', 'taskkill', 'tasklist', 'schtasks', 'sc',
    'powershell', 'where', 'wmic', 'msiexec', 'rundll32', 'regsvr32', 'clip',
];
const SYSTEM_TOOL_ARGUMENT = `\\(\\s*"(?:${WINDOWS_SYSTEM_TOOLS.join('|')})(?:\\.exe)?"\\s*\\)`;
const BARE_SYSTEM_TOOL = new RegExp(`\\bCommand::new${SYSTEM_TOOL_ARGUMENT}`, 'gi');
const QUALIFIED_BARE_SYSTEM_TOOL = new RegExp(
    `\\bprocess::Command::new${SYSTEM_TOOL_ARGUMENT}`,
    'gi',
);
const CONSOLE_SPAWN = /\bCommand::new\s*\(/g;
const QUALIFIED_PROCESS_SPAWN = /\bprocess::Command::new\s*\(/g;
const FOREIGN_COMMAND_IMPORT =
    /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+(?!std::process|tokio::process)[\w:]+::(?:Command\b|\{[^}]*\bCommand\b)/m;
const CONSOLE_HIDDEN = /\b(?:hide_console_window|spawn_detached|spawn_owned)\s*\(/g;
const HOST_STATE_CALL =
    /\b(?:SetSystemCursor|SetDeviceGammaRamp|BluetoothSetServiceState)\s*\(|\bSystemParametersInfoW\s*\(\s*SPI_SET/g;
const STOP_LISTENER = /\b(?:on_stop_request|wait_for_stop_request|CancellationToken::install)\b/;
const OTHER_OS_PATH_RE = /[\\/]platform[\\/](?:linux|macos|unix)[^\\/]*(?:[\\/]|\.rs$)/;
const TEST_SUPPORT_PATH_RE =
    /[\\/](?:tests|testing|examples)[\\/]|[\\/](?:tests|build)\.rs$|_tests?\.rs$|[\\/]test_[^\\/]*\.rs$|test_support|testkit/;
const GUI_CRATE_PATH_RE = /[\\/](?:apps[\\/]tray|plugins[\\/][^\\/]+)[\\/]src[\\/]/;
const PLUGIN_CRATE_PATH_RE = /[\\/]plugins[\\/][^\\/]+[\\/]src[\\/]/;
const BLOCK_COMMENT = new RegExp('/\\*[\\s\\S]*?\\*/', 'g');
const LINE_COMMENT = new RegExp('/{2}.*$', 'gm');

const ALLOW_DEAD_CODE = /#\[allow\([^)]*\bdead_code\b[^)]*\)\]/;
const ALLOW_UNUSED_MUT = /#\[allow\([^)]*\bunused_mut\b[^)]*\)\]/;
const CFG_ON_USE_SAMELINE = /#\[cfg\((?:not\(|all\(|any\()?target_os\s*=[^\]]*\]\s*(?:pub(?:\([^)]*\))?\s+)?use\s+/;
const CFG_TARGET_OS = /#\[cfg\((?:not\(|all\(|any\()?target_os\s*=/;
const USE_STATEMENT = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+/;
const ATTRIBUTE_LINE = /^\s*#\[/;

const lintMode = require('./hook-lint-mode.cjs');

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function log(msg) {
    if (lintMode.active()) return;
    process.stderr.write(`[qol-arch-cross-platform] ${msg}\n`);
}

function consumeBypass(marker, basename) {
    if (lintMode.active()) return false;
    if (!fs.existsSync(marker) || !fs.statSync(marker).isFile()) return false;
    try {
        const raw = fs.readFileSync(marker, 'utf8').trim();
        const count = /^\d+$/.test(raw) ? Number(raw) : 1;
        if (count > 1) {
            fs.writeFileSync(marker, String(count - 1));
            log(`bypass consumed (${count - 1} remaining) — ${basename}`);
        } else {
            fs.unlinkSync(marker);
            log(`bypass consumed (marker removed) — ${basename}`);
        }
    } catch {
        return false;
    }
    return true;
}

function extractNewContent(tool, input) {
    if (!input) return '';
    if (tool === 'Write') return input.content || '';
    if (tool === 'Edit') {
        const existing = readExistingFile(input.file_path);
        if (existing === null || !input.old_string) return input.new_string || '';
        if (input.replace_all) {
            return existing.split(input.old_string).join(input.new_string || '');
        }
        const index = existing.indexOf(input.old_string);
        if (index < 0) return input.new_string || '';
        return existing.slice(0, index)
            + (input.new_string || '')
            + existing.slice(index + input.old_string.length);
    }
    if (tool === 'MultiEdit') {
        let existing = readExistingFile(input.file_path);
        if (existing === null) {
            return (input.edits || []).map(edit => edit.new_string || '').join('\n\n');
        }
        for (const edit of input.edits || []) {
            if (!edit.old_string || !existing.includes(edit.old_string)) {
                return (input.edits || []).map(item => item.new_string || '').join('\n\n');
            }
            existing = edit.replace_all
                ? existing.split(edit.old_string).join(edit.new_string || '')
                : existing.replace(edit.old_string, edit.new_string || '');
        }
        return existing;
    }
    if (tool === 'NotebookEdit') return input.new_source || '';
    return '';
}

function readExistingFile(filePath) {
    if (lintMode.isTarget(filePath)) return null;
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return null;
    }
}

function isDirectory(filePath) {
    try {
        return fs.statSync(filePath).isDirectory();
    } catch {
        return false;
    }
}

function platformDirectory(filePath) {
    const resolved = path.resolve(filePath);
    const parts = resolved.split(path.sep);
    const platformIndex = parts.lastIndexOf('platform');
    if (platformIndex >= 0) {
        return parts.slice(0, platformIndex + 1).join(path.sep) || path.sep;
    }
    if (path.basename(resolved) !== 'mod.rs') return null;
    const sibling = path.join(path.dirname(resolved), 'platform');
    return isDirectory(sibling) ? sibling : null;
}

function rustFiles(root, excludedDirectory, prospectiveFile) {
    const files = [];
    const visit = directory => {
        let entries;
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const file = path.join(directory, entry.name);
            if (path.resolve(file) === path.resolve(excludedDirectory)) continue;
            if (entry.isDirectory()) {
                if (entry.name === 'tests' || entry.name === 'examples') continue;
                visit(file);
                continue;
            }
            if (entry.isFile() && file.endsWith('.rs')) files.push(file);
        }
    };
    visit(root);
    if (
        prospectiveFile.endsWith('.rs') &&
        prospectiveFile.startsWith(`${path.resolve(root)}${path.sep}`) &&
        !prospectiveFile.startsWith(`${path.resolve(excludedDirectory)}${path.sep}`) &&
        !files.some(file => path.resolve(file) === path.resolve(prospectiveFile))
    ) {
        files.push(prospectiveFile);
    }
    return files;
}

function productionContent(content) {
    return content.split(/\n\s*#\[cfg\(test\)\]\s*\n\s*mod\s+tests\s*\{/)[0];
}

function prospectiveFileContent(candidate, filePath, newContent) {
    if (path.resolve(candidate) === path.resolve(filePath)) return newContent;
    return readExistingFile(candidate) || '';
}

// Free functions only: a method's name (new, acquire) collides with every
// other type's method of the same name, so counting its uses proves nothing.
function internalCallables(content) {
    return [...content.matchAll(
        /^pub\s*\(\s*(?:crate|super|in\s+[^)]+)\s*\)\s+(?:async\s+)?fn\s+([A-Za-z_]\w*)/gm,
    )].map(match => match[1]);
}

function crateSourceRoot(featureDir) {
    const parts = path.resolve(featureDir).split(path.sep);
    const src = parts.lastIndexOf('src');
    return src < 0 ? featureDir : parts.slice(0, src + 1).join(path.sep) || path.sep;
}

// Every module under platform/ is an adapter, fallbacks and family modules
// included, so a helper shared by linux and a fallback is not exclusive.
function adapterContents(platformDir, filePath, newContent) {
    let entries;
    try {
        entries = fs.readdirSync(platformDir, { withFileTypes: true });
    } catch {
        return new Map();
    }
    const names = entries
        .filter(entry => entry.name !== 'mod.rs' && (entry.isDirectory() || entry.name.endsWith('.rs')))
        .map(entry => entry.name.replace(/\.rs$/, ''));
    const relative = path.relative(platformDir, path.resolve(filePath)).split(path.sep);
    if (relative.length > 0 && relative[0] !== '..' && relative[0] !== 'mod.rs') {
        names.push(relative[0].replace(/\.rs$/, ''));
    }
    return new Map([...new Set(names)].map(name => [name, adapterContent(platformDir, name, filePath, newContent)]));
}

function wordCount(content, name) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [...content.matchAll(new RegExp(`\\b${escaped}\\b`, 'g'))].length;
}

function adapterContent(platformDir, target, filePath, newContent) {
    const flat = path.join(platformDir, `${target}.rs`);
    const directory = path.join(platformDir, target);
    if (fs.existsSync(flat) || path.resolve(flat) === path.resolve(filePath)) {
        return prospectiveFileContent(flat, filePath, newContent);
    }
    if (!isDirectory(directory)) return '';
    return rustFiles(directory, '', filePath)
        .map(file => prospectiveFileContent(file, filePath, newContent))
        .join('\n');
}

function findAdapterExclusiveHelpers(filePath, newContent) {
    const platformDir = platformDirectory(filePath);
    if (!platformDir) return [];
    const featureDir = path.dirname(platformDir);
    const parentFile = path.join(featureDir, 'mod.rs');
    const parentContent = productionContent(
        prospectiveFileContent(parentFile, filePath, newContent),
    );
    if (!parentContent) return [];

    const sharedFiles = rustFiles(crateSourceRoot(featureDir), platformDir, filePath);
    const sharedContent = sharedFiles
        .map(file => productionContent(prospectiveFileContent(file, filePath, newContent)))
        .join('\n');
    const adapters = adapterContents(platformDir, filePath, newContent);

    return internalCallables(parentContent).flatMap(name => {
        if (wordCount(sharedContent, name) > 1) return [];
        const consumers = [...adapters]
            .filter(([, content]) => wordCount(content, name) > 0)
            .map(([target]) => target);
        return consumers.length === 1 ? [{ name, target: consumers[0] }] : [];
    });
}

// A helper's consumers are one property of the feature tree. Lint reports it
// once, on the shared parent; an edit to an adapter still checks it.
function findNewAdapterExclusiveHelpers(filePath, newContent) {
    if (lintMode.isTarget(filePath) && PLATFORM_PATH_RE.test(filePath)) return [];
    const before = new Set(
        findAdapterExclusiveHelpers(filePath, readExistingFile(filePath) || '')
            .map(({ name, target }) => `${name}:${target}`),
    );
    return findAdapterExclusiveHelpers(filePath, newContent)
        .filter(({ name, target }) => !before.has(`${name}:${target}`));
}

function blockAdapterExclusiveHelpers(filePath, violations) {
    lintMode.report(process.stderr, `qol-arch-cross-platform violation in ${filePath}.

Found an adapter-exclusive shared helper:

${violations.map(({ name, target }) => `  - ${name}: consumed only by ${target}`).join('\n')}

A callable whose only non-test consumer is one OS adapter belongs inside that
adapter, together with its tests. Shared parent modules contain only behavior
used by shared production code or multiple adapters.

Reference: qol-project:qol-arch-cross-platform skill.

Bypass for this edit only:
  touch .claude/bypass-qol-arch-cross-platform
`);
}

function addedCodeBaseline(filePath) {
    if (lintMode.isTarget(filePath)) return lintMode.baseline() || '';
    return readExistingFile(filePath) || '';
}

function productionView(content) {
    return content
        .split(/\n\s*#\[cfg\(test\)\]\s*\n\s*mod\s+\w+\s*\{/)[0]
        .replace(BLOCK_COMMENT, '')
        .replace(LINE_COMMENT, '');
}

function occurrences(content, pattern) {
    return (content.match(pattern) || []).length;
}

function added(before, after, pattern) {
    return occurrences(after, pattern) - occurrences(before, pattern);
}

function matchingLines(content, pattern) {
    const single = new RegExp(pattern.source, pattern.flags.replace('g', ''));
    return content
        .split(/\r?\n/)
        .map((text, index) => ({ lineno: index + 1, text }))
        .filter(line => single.test(line.text));
}

function crateHasStopListener(filePath, newContent) {
    const root = crateSourceRoot(path.dirname(path.resolve(filePath)));
    return rustFiles(root, '', path.resolve(filePath))
        .map(file => productionView(prospectiveFileContent(file, filePath, newContent)))
        .some(content => STOP_LISTENER.test(content));
}

function findWindowsViolations(filePath, newContent) {
    if (OTHER_OS_PATH_RE.test(filePath) || TEST_SUPPORT_PATH_RE.test(filePath)) return [];
    const before = productionView(addedCodeBaseline(filePath));
    const after = productionView(newContent);
    const violations = [];
    const foreignCommand = FOREIGN_COMMAND_IMPORT.test(after);
    const systemTool = foreignCommand ? QUALIFIED_BARE_SYSTEM_TOOL : BARE_SYSTEM_TOOL;
    if (added(before, after, systemTool) > 0) {
        violations.push({
            rule: 'a Windows system tool started by its bare name',
            lines: matchingLines(after, systemTool),
            fix: 'Start it with qol_process::system_command("<tool>.exe"), or build the path with\n'
                + 'qol_process::system_program_path; both resolve System32.',
        });
    }
    const spawn = foreignCommand ? QUALIFIED_PROCESS_SPAWN : CONSOLE_SPAWN;
    const spawns = added(before, after, spawn);
    if (
        GUI_CRATE_PATH_RE.test(filePath)
        && spawns > 0
        && spawns > added(before, after, CONSOLE_HIDDEN)
    ) {
        violations.push({
            rule: 'a child process of the tray or a plugin that opens a console window on Windows',
            lines: matchingLines(after, spawn),
            fix: 'Pass every new command through qol_process::hide_console_window(&mut command)\n'
                + '(a tokio command through as_std_mut()), or start it with qol_process::spawn_detached\n'
                + 'or qol_process::spawn_owned, which hide it. system_command only resolves the path.\n'
                + 'GUI children ignore the flag.',
        });
    }
    if (
        PLUGIN_CRATE_PATH_RE.test(filePath)
        && added(before, after, HOST_STATE_CALL) > 0
        && !crateHasStopListener(filePath, newContent)
    ) {
        violations.push({
            rule: 'a host-state change in a plugin that never listens for the stop request',
            lines: matchingLines(after, HOST_STATE_CALL),
            fix: 'Restore the state when the tray stops the daemon: register a hook with\n'
                + 'qol_process::on_stop_request (or wait on qol_process::wait_for_stop_request).',
        });
    }
    return violations;
}

function blockWindowsViolations(filePath, violations) {
    const detail = violations
        .map(({ rule, lines, fix }) => [
            `Found ${rule}:`,
            ...lines.map(line => `  line ${line.lineno}: ${line.text.trim()}`),
            '',
            fix,
        ].join('\n'))
        .join('\n\n');
    lintMode.report(process.stderr, `qol-arch-cross-platform violation in ${filePath}.

${detail}

Reference: qol-project:qol-arch-cross-platform skill, rules 6 to 8.

Bypass for this edit only:
  touch .claude/bypass-qol-arch-cross-platform
`);
}

function isExempt(filePath) {
    const basename = crossPlatformBasename(filePath);
    if (PLATFORM_PATH_RE.test(filePath)) return true;
    if (TESTS_PATH_RE.test(filePath)) return true;
    if (EXAMPLES_PATH_RE.test(filePath)) return true;
    if (basename.endsWith('_test.rs')) return true;
    if (basename.endsWith('_tests.rs')) return true;
    if (basename === 'tests.rs') return true;
    return false;
}

function findAllowViolations(content) {
    const lines = content.split(/\r?\n/);
    const violations = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (ALLOW_DEAD_CODE.test(line)) {
            violations.push({ kind: 'dead_code', lineno: i + 1, text: line });
        }
        if (ALLOW_UNUSED_MUT.test(line)) {
            violations.push({ kind: 'unused_mut', lineno: i + 1, text: line });
        }
    }
    return violations;
}

function findCfgOnUseViolations(content) {
    const lines = content.split(/\r?\n/);
    const violations = [];
    let pendingCfg = null;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineno = i + 1;
        if (CFG_ON_USE_SAMELINE.test(line)) {
            violations.push({ cfgLineno: lineno, cfgText: line, useText: line, useLineno: lineno });
            pendingCfg = null;
            continue;
        }
        if (pendingCfg !== null) {
            if (ATTRIBUTE_LINE.test(line)) continue;
            if (USE_STATEMENT.test(line)) {
                violations.push({
                    cfgLineno: pendingCfg.lineno,
                    cfgText: pendingCfg.text,
                    useLineno: lineno,
                    useText: line,
                });
            }
            pendingCfg = null;
            continue;
        }
        if (CFG_TARGET_OS.test(line) && !CFG_ON_USE_SAMELINE.test(line)) {
            const trimmed = line.trim();
            if (trimmed.endsWith(']')) {
                pendingCfg = { lineno, text: line };
            }
        }
    }
    return violations;
}

function blockAllowViolations(filePath, violations) {
    const detail = violations
        .map(v => `  line ${v.lineno}: ${v.text.trim()}`)
        .join('\n');
    const kinds = [...new Set(violations.map(v => v.kind))].join(', ');
    lintMode.report(process.stderr, `qol-arch-cross-platform violation in ${filePath}.

Found #[allow(${kinds})] outside a platform/ directory:

${detail}

The skill prohibits these in shared code because they hide symbols that are
dead on at least one OS — typically because the consumer is cfg-gated to a
different platform. The dead symbol is the bug; allow() just makes it
invisible until it rots into mystery code.

Three honest fixes (pick one):

  1. Relocate. Move the symbol into src/<feature>/platform/<os>.rs where
     its actual consumers live.
  2. Gate. Add #[cfg(target_os = "<os>")] on the symbol so the OSes that
     don't use it never see it (only on mod / pub use lines per the
     qol-arch-code canonical pattern; otherwise restructure).
  3. Use. If the symbol should be cross-platform, add the missing
     consumer in the OS that's currently silent on it.

Reference: qol-arch-cross-platform skill.

Bypass for this edit only:
  touch .claude/bypass-qol-arch-cross-platform
  # or for N edits in a row:
  echo 5 > .claude/bypass-qol-arch-cross-platform
`);
}

function blockCfgOnUse(filePath, violations) {
    const detail = violations
        .map(v => `  line ${v.useLineno}: ${v.useText.trim()}`)
        .join('\n');
    lintMode.report(process.stderr, `qol-arch-cross-platform violation in ${filePath}.

Found #[cfg(target_os = ...)] attached to a use statement outside a
platform/ directory:

${detail}

This pattern is almost always a refactor leftover. Either:

  - The consumer of the imported symbol is also cfg-gated to the same OS
    — in which case the consumer (and its use) belong inside
    src/<feature>/platform/<os>.rs. Move both.
  - Or the import is genuinely needed only on one OS while other items in
    this file are cross-platform — split the file along that seam.

Inside platform/<os>.rs the cfg gate on use is redundant (the file is
already OS-gated) but harmless; the hook does not fire there.

Reference: qol-arch-cross-platform skill.

Bypass for this edit only:
  touch .claude/bypass-qol-arch-cross-platform
`);
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
    return evaluate(payload);
}

function evaluate(payload) {
    const tool = payload.tool_name || payload.tool || '';
    if (!INSPECTED_TOOLS.has(tool)) return 0;

    const input = payload.tool_input || {};
    const filePath = input.file_path || input.notebook_path || '';
    if (!filePath || !filePath.endsWith('.rs')) return 0;
    if (!QOL_TOOLS_PATH_RE.test(filePath)) return 0;
    const cwd = payload.cwd || process.cwd();
    const marker = path.join(cwd, '.claude', 'bypass-qol-arch-cross-platform');
    const newContent = extractNewContent(tool, { ...input, file_path: filePath });
    if (!newContent) return 0;

    const adapterExclusive = findNewAdapterExclusiveHelpers(filePath, newContent);
    if (adapterExclusive.length > 0) {
        if (consumeBypass(marker, crossPlatformBasename(filePath))) return 0;
        blockAdapterExclusiveHelpers(filePath, adapterExclusive);
        return 2;
    }

    const windowsViolations = findWindowsViolations(filePath, newContent);
    if (windowsViolations.length > 0) {
        if (consumeBypass(marker, crossPlatformBasename(filePath))) return 0;
        blockWindowsViolations(filePath, windowsViolations);
        return 2;
    }

    if (isExempt(filePath)) return 0;

    if (consumeBypass(marker, crossPlatformBasename(filePath))) return 0;

    const allowViolations = findAllowViolations(newContent);
    if (allowViolations.length > 0) {
        blockAllowViolations(filePath, allowViolations);
        return 2;
    }

    const cfgUseViolations = findCfgOnUseViolations(newContent);
    if (cfgUseViolations.length > 0) {
        blockCfgOnUse(filePath, cfgUseViolations);
        return 2;
    }

    return 0;
}

function lintFile(filePath, content, baseline = null) {
    return lintMode.run(filePath, () => evaluate({
        tool_name: 'Write',
        tool_input: { file_path: filePath, content },
        cwd: path.dirname(filePath),
    }), baseline);
}

module.exports = { lintFile };

if (require.main === module) process.exit(main());
