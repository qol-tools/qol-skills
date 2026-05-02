#!/usr/bin/env node
/*
 * qol-architecture PreToolUse hook.
 *
 * Blocks Rust file Writes/Edits that violate the qol-architecture skill's
 * cross-platform strategy pattern:
 *
 *   1. compile_error! macros — break cross-compilation.
 *   2. #[cfg(target_os = "...")] attributes outside the canonical mod.rs
 *      re-export pattern (e.g. on `pub fn`, `mod foo;` where foo isn't an
 *      OS name, on impls, on use statements inside business code).
 *
 * Allowed:
 *   - cfg(target_os) on `mod {linux,macos,windows};` or `pub use
 *     {linux,macos,windows}::...;` lines (the canonical mod.rs pattern).
 *   - Anything inside files literally named `linux.rs`, `macos.rs`,
 *     `windows.rs` — those are the OS impls themselves.
 *   - Files under tests/ and examples/ — relaxed, cross-platform tests
 *     legitimately use cfg(target_os).
 *
 * Bypass for one-off legitimate exceptions:
 *   touch .claude/bypass-qol-architecture          # next 1 edit passes
 *   echo N > .claude/bypass-qol-architecture       # next N edits pass
 *
 * Runs on Node — Claude Code requires Node, so the dependency is free.
 * Silent on errors — a failing hook must never block Claude irreversibly.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INSPECTED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const OS_BASENAMES = new Set(['linux.rs', 'macos.rs', 'windows.rs']);

const CANONICAL_TARGET = /^\s*(mod (linux|macos|windows);|pub use (linux|macos|windows)::|pub\(crate\) use (linux|macos|windows)::)/;
const ATTRIBUTE_LINE = /^\s*#\[/;
const CFG_TARGET_OS = /#\[cfg\((not\(|all\(|any\()?target_os\s*=/;
const SAMELINE_CANONICAL = /\]\s*(mod (linux|macos|windows);|pub use (linux|macos|windows)::|pub\(crate\) use (linux|macos|windows)::)/;
const COMPILE_ERROR = /\bcompile_error!\s*\(/;

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function log(msg) {
    process.stderr.write(`[qol-architecture] ${msg}\n`);
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

function findCfgViolations(content) {
    const lines = content.split(/\r?\n/);
    const violations = [];
    let pending = null; // { lineno, text }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineno = i + 1;
        if (pending !== null) {
            if (ATTRIBUTE_LINE.test(line)) {
                continue; // stacked attributes — keep waiting
            }
            if (CANONICAL_TARGET.test(line)) {
                pending = null;
                continue;
            }
            violations.push({
                cfgLineno: pending.lineno,
                cfgText: pending.text,
                targetLineno: lineno,
                targetText: line,
            });
            pending = null;
            continue;
        }
        if (CFG_TARGET_OS.test(line)) {
            if (SAMELINE_CANONICAL.test(line)) continue;
            pending = { lineno, text: line };
        }
    }
    if (pending !== null) {
        violations.push({
            cfgLineno: pending.lineno,
            cfgText: pending.text,
            targetLineno: -1,
            targetText: '(no target line — malformed cfg block?)',
        });
    }
    return violations;
}

function blockCompileError(filePath) {
    process.stderr.write(`qol-architecture violation in ${filePath}: \`compile_error!\` macro found.

The skill prohibits compile_error! gates for unsupported platforms. They
break cross-compilation, block dev on other hosts, and break CI matrix
builds.

Replace with a stub Platform impl that returns Err("not implemented on
<os>") at runtime. The host can decide UX (toast, hide menu item, etc.)
while the plugin still compiles cross-platform.

See the qol-architecture skill for the full pattern.

Bypass for this single edit:
  touch .claude/bypass-qol-architecture
`);
}

function blockCfgViolations(filePath, violations) {
    const detail = violations
        .flatMap(v => [
            `  line ${v.cfgLineno}: ${v.cfgText}`,
            `  line ${v.targetLineno}: ${v.targetText}`,
            '  ---',
        ])
        .join('\n');

    process.stderr.write(`qol-architecture violation in ${filePath}.

Detected #[cfg(target_os = ...)] attributes outside the canonical mod.rs
re-export pattern:

${detail}

The skill requires:

  - cfg(target_os) appears ONLY in mod.rs to alias OS submodules:
        #[cfg(target_os = "linux")]    mod linux;
        #[cfg(target_os = "linux")]    pub use linux::Platform;

  - Each platform impl lives in src/<feature>/{linux,macos,windows}.rs.
    Those files are the only place OS-specific code may live. Inside them
    cfg(target_os) is unnecessary because the file itself is OS-gated.

  - Stubs return typed Err on unsupported OSes. No compile_error!,
    no cfg-gated pub fns/structs, no cfg sprawl in business code.

Refactor steps:
  1. Move OS-specific code into linux.rs / macos.rs / windows.rs siblings.
  2. Define a trait in mod.rs.
  3. Each <os>.rs has \`pub(crate) struct Platform; impl Trait for Platform\`.
  4. Replace business-code cfg blocks with calls to \`Platform.method(...)\`.

Reference: qol-dev-conventions:qol-architecture skill.

Bypass for this edit only:
  touch .claude/bypass-qol-architecture
  # or for N edits in a row:
  echo 5 > .claude/bypass-qol-architecture
`);
}

function main() {
    const raw = readStdin().trim();
    if (!raw) return 0;

    let payload;
    try {
        payload = JSON.parse(raw);
    } catch {
        return 0; // silent fail; never wedge Claude
    }

    const tool = payload.tool_name || payload.tool || '';
    if (!INSPECTED_TOOLS.has(tool)) return 0;

    if (payload.agent_type) return 0;

    const input = payload.tool_input || {};
    const filePath = input.file_path || input.notebook_path || '';
    if (!filePath || !filePath.endsWith('.rs')) return 0;

    if (!filePath.includes('/qol-tools/')) return 0;

    const basename = path.basename(filePath);
    if (OS_BASENAMES.has(basename)) return 0;

    if (
        filePath.includes('/tests/') ||
        filePath.includes('/examples/') ||
        basename.endsWith('_test.rs') ||
        basename.endsWith('_tests.rs')
    ) {
        return 0;
    }

    const cwd = payload.cwd || process.cwd();
    const marker = path.join(cwd, '.claude', 'bypass-qol-architecture');
    if (fs.existsSync(marker) && fs.statSync(marker).isFile()) {
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
            // ignore — never block on bypass-marker IO failure
        }
        return 0;
    }

    const newContent = extractNewContent(tool, input);
    if (!newContent) return 0;

    if (COMPILE_ERROR.test(newContent)) {
        blockCompileError(filePath);
        return 2;
    }

    const violations = findCfgViolations(newContent);
    if (violations.length > 0) {
        blockCfgViolations(filePath, violations);
        return 2;
    }

    return 0;
}

process.exit(main());
