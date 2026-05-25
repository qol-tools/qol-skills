#!/usr/bin/env node
/*
 * qol-arch-code PreToolUse hook.
 *
 * Blocks Rust file Writes/Edits that violate the qol-arch-code skill's
 * cross-platform strategy pattern:
 *
 *   1. compile_error! macros — break cross-compilation.
 *   2. #[cfg(target_os = "...")] attributes outside the canonical mod.rs
 *      re-export pattern (e.g. on `pub fn`, `mod foo;` where foo isn't an
 *      OS name, on impls, on use statements inside business code).
 *   3. Runtime platform decision signals outside an architecture boundary
 *      (runtime OS constants, OS API imports, OS command dispatch, OS-keyed
 *      storage/path routing, platform manifest branching).
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
 *   touch .claude/bypass-qol-arch-code          # next 1 edit passes
 *   echo N > .claude/bypass-qol-arch-code       # next N edits pass
 *
 * Runs on Node — Claude Code requires Node, so the dependency is free.
 * Silent on errors — a failing hook must never block Claude irreversibly.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INSPECTED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const OS_BASENAMES = new Set(['linux.rs', 'macos.rs', 'windows.rs']);
const QOL_TOOLS_PATH_RE = /[\\/]qol-tools[\\/]/;
const TESTS_PATH_RE = /[\\/]tests[\\/]/;
const EXAMPLES_PATH_RE = /[\\/]examples[\\/]/;

function crossPlatformBasename(p) {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
}

function crossPlatformDirname(p) {
    const parts = p.split(/[\\/]/);
    parts.pop();
    return parts.join('/');
}

const CANONICAL_TARGET = /^\s*(mod (linux|macos|windows);|pub(?:\([^)]*\))?\s+use (linux|macos|windows)::)/;
const ATTRIBUTE_LINE = /^\s*#\[/;
const CFG_TARGET_OS = /#\[cfg\((not\(|all\(|any\()?target_os\s*=/;
const SAMELINE_CANONICAL = /\]\s*(mod (linux|macos|windows);|pub(?:\([^)]*\))?\s+use (linux|macos|windows)::)/;
const COMPILE_ERROR = /\bcompile_error!\s*\(/;
const ARCH_BOUNDARY_BASENAME = /^(platform|facade|strategy|resolver|scope|scope_store)\.rs$/;
const ARCH_BOUNDARY_SUFFIX = /_(facade|strategy|resolver|scope|scope_store)\.rs$/;
const ARCH_BOUNDARY_TYPE = /\b(struct|enum|trait)\s+\w*(Platform|Facade|Strategy|Resolver|ScopeStore)\b/;
const CFG_MACRO = /\bcfg!\s*\([^)]*target_os\s*=/;
const CFG_TARGET_FAMILY = /#\[cfg\((?:not\(|all\(|any\()?target_family\s*=/;
const CFG_UNIX_WINDOWS = /#\[cfg\((?:not\(|all\(|any\()?(unix|windows)\b/;
const RUNTIME_OS_CONST = /\bstd::env::consts::OS\b/;
const OS_API_IMPORT = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+(x11rb|objc2|cocoa|core_graphics|core_foundation|windows::Win32|winapi)\b/m;
const OS_COMMAND = /\bCommand::new\s*\(\s*"(open|osascript|xdg-open|powershell|cmd(?:\.exe)?|sw_vers|uname|lsb_release)"\s*\)/;
const PLATFORM_TOKEN = /\b(current_os|target_os|host_os|os_bucket|platforms?|supported_platforms)\b|"(linux|macos|windows|darwin|win32|x11|wayland)"/;
const ROUTING_TOKEN = /\.join\s*\(\s*"os"\s*\)|format!\s*\(\s*"os\/|PathBuf::from\s*\(\s*"os"\s*\)|\b(os|core|device)_(dir|path|bucket)\b|"(core|device)"|"plugin-configs"/;
const DECISION_TOKEN = /\b(if|match)\b|=>|==|!=|\.len\(\)\s*==\s*1|\.contains\s*\(/;

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function log(msg) {
    process.stderr.write(`[qol-arch-code] ${msg}\n`);
}

function extractNewContent(tool, input) {
    if (!input) return '';
    if (tool === 'Write') return input.content || '';
    if (tool === 'Edit') return applyEdit(input.file_path, input.old_string, input.new_string, input.replace_all);
    if (tool === 'MultiEdit') {
        return applyMultiEdit(input.file_path, input.edits || []);
    }
    if (tool === 'NotebookEdit') return input.new_source || '';
    return '';
}

function readExistingFile(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return null;
    }
}

function replaceFirst(source, oldString, newString) {
    const idx = source.indexOf(oldString);
    if (idx < 0) return null;
    return source.slice(0, idx) + newString + source.slice(idx + oldString.length);
}

function editSnippets(edits) {
    return edits.map(e => e.new_string || '').join('\n\n');
}

function applyEdit(filePath, oldString = '', newString = '', replaceAll = false) {
    const existing = readExistingFile(filePath);
    if (existing === null || !oldString) return newString || '';
    if (replaceAll) return existing.split(oldString).join(newString);
    return replaceFirst(existing, oldString, newString) ?? newString ?? '';
}

function applyMultiEdit(filePath, edits) {
    let current = readExistingFile(filePath);
    if (current === null) {
        return editSnippets(edits);
    }
    for (const edit of edits) {
        const oldString = edit.old_string || '';
        const newString = edit.new_string || '';
        if (!oldString) {
            return editSnippets(edits);
        }
        if (edit.replace_all) {
            if (!current.includes(oldString)) return editSnippets(edits);
            current = current.split(oldString).join(newString);
            continue;
        }
        const replaced = replaceFirst(current, oldString, newString);
        if (replaced === null) return editSnippets(edits);
        current = replaced;
    }
    return current;
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

function isArchitectureBoundary(filePath, content) {
    const basename = crossPlatformBasename(filePath);
    if (filePath.split(/[\\/]/).includes('platform')) return true;
    if (ARCH_BOUNDARY_BASENAME.test(basename)) return true;
    if (ARCH_BOUNDARY_SUFFIX.test(basename)) return true;
    if (ARCH_BOUNDARY_TYPE.test(content)) return true;
    return false;
}

function findStrongPlatformSignals(content) {
    const candidates = [
        { label: 'cfg!(target_os)', re: CFG_MACRO },
        { label: '#[cfg(target_family)]', re: CFG_TARGET_FAMILY },
        { label: '#[cfg(unix/windows)]', re: CFG_UNIX_WINDOWS },
        { label: 'std::env::consts::OS', re: RUNTIME_OS_CONST },
        { label: 'OS-specific import', re: OS_API_IMPORT },
        { label: 'OS command dispatch', re: OS_COMMAND },
    ];
    return candidates
        .filter(candidate => candidate.re.test(content))
        .map(candidate => candidate.label);
}

function findCompositePlatformSignals(content) {
    const hasPlatform = PLATFORM_TOKEN.test(content);
    const hasRouting = ROUTING_TOKEN.test(content);
    const hasDecision = DECISION_TOKEN.test(content);
    const labels = [];
    if (hasPlatform && hasRouting) labels.push('platform token + storage/path routing');
    if (hasPlatform && hasDecision) labels.push('platform token + branching');
    return labels;
}

function blockCompileError(filePath) {
    process.stderr.write(`qol-arch-code violation in ${filePath}: \`compile_error!\` macro found.

The skill prohibits compile_error! gates for unsupported platforms. They
break cross-compilation, block dev on other hosts, and break CI matrix
builds.

Replace with a stub Platform impl that returns Err("not implemented on
<os>") at runtime. The host can decide UX (toast, hide menu item, etc.)
while the plugin still compiles cross-platform.

See the qol-arch-code skill for the full pattern.

Bypass for this single edit:
  touch .claude/bypass-qol-arch-code
`);
}

function blockPlatformDecision(filePath, labels) {
    const detail = labels.map(label => `  - ${label}`).join('\n');
    process.stderr.write(`qol-arch-code violation in ${filePath}.

Detected platform-specific decision logic outside an architecture boundary:

${detail}

Platform decisions must live behind a facade, strategy, resolver, scope store,
or platform/ module. Business code should call that boundary instead of
branching on OS names, runtime OS constants, OS-specific imports, OS commands,
or scoped profile storage paths directly.

Fix:
  1. Move the decision into an existing facade/resolver/scope store.
  2. Or create the facade first, then call it from this file.

Bypass for this edit only:
  touch .claude/bypass-qol-arch-code
`);
}

function blockOsFileOutsidePlatform(filePath) {
    process.stderr.write(`qol-arch-code violation in ${filePath}.

OS-named files (linux.rs, macos.rs, windows.rs) must live inside a
\`platform/\` directory. Found this one as a direct child of its feature
directory instead.

Fix the layout to one of:

  src/<feature>/platform/{linux,macos,windows}.rs   (per-feature)
  src/platform/{linux,macos,windows}.rs             (top-level shared)

The \`platform/\` directory keeps cross-platform code visibly compartmentalized
and prevents OS-specific files from drifting into business-code paths.

Bypass for this edit only:
  touch .claude/bypass-qol-arch-code
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

    process.stderr.write(`qol-arch-code violation in ${filePath}.

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

Reference: qol-dev-conventions:qol-arch-code skill.

Bypass for this edit only:
  touch .claude/bypass-qol-arch-code
  # or for N edits in a row:
  echo 5 > .claude/bypass-qol-arch-code
`);
}

function markerPaths(cwd, filePath) {
    const markers = [];
    const seen = new Set();
    const push = dir => {
        if (!dir) return;
        const marker = path.join(dir, '.claude', 'bypass-qol-arch-code');
        if (seen.has(marker)) return;
        seen.add(marker);
        markers.push(marker);
    };
    push(cwd);
    let dir = path.dirname(filePath);
    for (let i = 0; i < 32; i++) {
        push(dir);
        if (fs.existsSync(path.join(dir, '.git'))) break;
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return markers;
}

function consumeBypassMarker(marker, basename) {
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

    const input = payload.tool_input || {};
    const filePath = input.file_path || input.notebook_path || '';
    if (!filePath || !filePath.endsWith('.rs')) return 0;

    if (!QOL_TOOLS_PATH_RE.test(filePath)) return 0;

    const basename = crossPlatformBasename(filePath);
    const parentDir = crossPlatformBasename(crossPlatformDirname(filePath));

    if (
        TESTS_PATH_RE.test(filePath) ||
        EXAMPLES_PATH_RE.test(filePath) ||
        basename.endsWith('_test.rs') ||
        basename.endsWith('_tests.rs')
    ) {
        return 0;
    }

    if (OS_BASENAMES.has(basename)) {
        if (parentDir !== 'platform') {
            blockOsFileOutsidePlatform(filePath);
            return 2;
        }
        return 0;
    }

    const cwd = payload.cwd || process.cwd();
    for (const marker of markerPaths(cwd, filePath)) {
        if (consumeBypassMarker(marker, basename)) {
            return 0;
        }
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

    if (!isArchitectureBoundary(filePath, newContent)) {
        const signals = [
            ...findStrongPlatformSignals(newContent),
            ...findCompositePlatformSignals(newContent),
        ];
        if (signals.length > 0) {
            blockPlatformDecision(filePath, signals);
            return 2;
        }
    }

    return 0;
}

process.exit(main());
