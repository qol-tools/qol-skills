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
 * tests/, examples/, and *_test.rs / *_tests.rs):
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

const QOL_TOOLS_PATH_RE = /[\\/]qol-tools[\\/]/;
const PLATFORM_PATH_RE = /[\\/]platform[\\/]/;
const TESTS_PATH_RE = /[\\/]tests[\\/]/;
const EXAMPLES_PATH_RE = /[\\/]examples[\\/]/;

function crossPlatformBasename(p) {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
}

const ALLOW_DEAD_CODE = /#\[allow\([^)]*\bdead_code\b[^)]*\)\]/;
const ALLOW_UNUSED_MUT = /#\[allow\([^)]*\bunused_mut\b[^)]*\)\]/;
const CFG_ON_USE_SAMELINE = /#\[cfg\((?:not\(|all\(|any\()?target_os\s*=[^\]]*\]\s*(?:pub(?:\([^)]*\))?\s+)?use\s+/;
const CFG_TARGET_OS = /#\[cfg\((?:not\(|all\(|any\()?target_os\s*=/;
const USE_STATEMENT = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+/;
const ATTRIBUTE_LINE = /^\s*#\[/;

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function log(msg) {
    process.stderr.write(`[qol-arch-cross-platform] ${msg}\n`);
}

function extractNewContent(tool, input) {
    if (!input) return '';
    if (tool === 'Write') return input.content || '';
    if (tool === 'Edit') return input.new_string || '';
    if (tool === 'MultiEdit') {
        return (input.edits || [])
            .map(e => e.new_string || '')
            .join('\n\n');
    }
    if (tool === 'NotebookEdit') return input.new_source || '';
    return '';
}

function isExempt(filePath) {
    const basename = crossPlatformBasename(filePath);
    if (PLATFORM_PATH_RE.test(filePath)) return true;
    if (TESTS_PATH_RE.test(filePath)) return true;
    if (EXAMPLES_PATH_RE.test(filePath)) return true;
    if (basename.endsWith('_test.rs')) return true;
    if (basename.endsWith('_tests.rs')) return true;
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
    process.stderr.write(`qol-arch-cross-platform violation in ${filePath}.

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
    process.stderr.write(`qol-arch-cross-platform violation in ${filePath}.

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

    const tool = payload.tool_name || payload.tool || '';
    if (!INSPECTED_TOOLS.has(tool)) return 0;

    const input = payload.tool_input || {};
    const filePath = input.file_path || input.notebook_path || '';
    if (!filePath || !filePath.endsWith('.rs')) return 0;
    if (!QOL_TOOLS_PATH_RE.test(filePath)) return 0;
    if (isExempt(filePath)) return 0;

    const cwd = payload.cwd || process.cwd();
    const marker = path.join(cwd, '.claude', 'bypass-qol-arch-cross-platform');
    if (fs.existsSync(marker) && fs.statSync(marker).isFile()) {
        try {
            const raw = fs.readFileSync(marker, 'utf8').trim();
            const count = /^\d+$/.test(raw) ? Number(raw) : 1;
            if (count > 1) {
                fs.writeFileSync(marker, String(count - 1));
                log(`bypass consumed (${count - 1} remaining) — ${crossPlatformBasename(filePath)}`);
            } else {
                fs.unlinkSync(marker);
                log(`bypass consumed (marker removed) — ${crossPlatformBasename(filePath)}`);
            }
        } catch {
            // ignore — never block on bypass-marker IO failure
        }
        return 0;
    }

    const newContent = extractNewContent(tool, input);
    if (!newContent) return 0;

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

process.exit(main());
