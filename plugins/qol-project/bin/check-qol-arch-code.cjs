#!/usr/bin/env node
/*
 * qol-arch-code PreToolUse hook.
 *
 * Blocks file Writes/Edits that violate the qol-arch-code skill's
 * cross-platform strategy pattern and plugin source-layout contract:
 *
 *   1. compile_error! macros — break cross-compilation.
 *   2. #[cfg(target_os = "...")] attributes outside the canonical mod.rs
 *      re-export pattern (e.g. on `pub fn`, `mod foo;` where foo isn't an
 *      OS name, on impls, on use statements inside business code).
 *   3. Runtime platform decision signals outside an architecture boundary
 *      (runtime OS constants, OS API imports, OS command dispatch, OS-keyed
 *      storage/path routing, platform manifest branching).
 *   4. New source-layout debt: qtray/plugin root implementation modules,
 *      file/directory module hybrids, catch-all source directories, mixed
 *      platform module forms, and mixed web/native plugin UI roots.
 *   5. Family-merge conversions: edits that remove existing per-OS module
 *      slots from a platform/mod.rs facade in favor of cfg(unix)/windows/
 *      target_family aliases. Identical per-OS files are reserved slots,
 *      not duplicates; authoring a new facade family-first stays allowed.
 *   6. Hand-rolled plugin settings: contract-less config loaders, raw config
 *      file paths and the host config tree in plugin src/ production code.
 *      Settings live in qol-config.toml and load through the contract.
 *   7. Test deadlines that make a passing test race a short clock, in any
 *      .rs file including tests: elapsed-time upper bounds, recv_timeout and
 *      tokio timeout waits on expected events under 5 s, and production
 *      deadline consts given a shorter value under #[cfg(test)].
 *
 * Allowed:
 *   - cfg(target_os) on `mod {linux,macos,windows};` or `pub use
 *     {linux,macos,windows}::...;` lines (the canonical mod.rs pattern).
 *   - Anything inside files literally named `linux.rs`, `macos.rs`,
 *     `windows.rs` — those are the OS impls themselves.
 *   - Files under tests/ and examples/, tests.rs modules — relaxed, cross-platform tests
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
const design = require('./qol-design-guard.cjs');
const lintMode = require('./hook-lint-mode.cjs');

const INSPECTED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const OS_BASENAMES = new Set(['linux.rs', 'macos.rs', 'windows.rs']);
const QOL_TOOLS_PATH_RE = /[\\/]qol-[^\\/]+[\\/]/;
const TESTS_PATH_RE = /[\\/]tests[\\/]/;
const EXAMPLES_PATH_RE = /[\\/]examples[\\/]/;
const PLUGIN_ROOT_RUST_FILES = new Set(['main.rs', 'lib.rs', 'cli.rs']);
const QOL_TRAY_ROOT_RUST_FILES = new Set(['main.rs', 'lib.rs']);
const CATCH_ALL_SOURCE_DIRS = new Set(['common', 'helper', 'helpers', 'util', 'utils']);
const OS_MODULE_NAMES = new Set(['linux', 'macos', 'windows']);
const TARGET_OS_NAMES = ['linux', 'macos', 'windows'];
const WEB_ASSET_EXTENSIONS = new Set([
    '.css',
    '.htm',
    '.html',
    '.js',
    '.jsx',
    '.mjs',
    '.ts',
    '.tsx',
]);

function crossPlatformBasename(p) {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
}

function isDirectory(p) {
    try {
        return fs.statSync(p).isDirectory();
    } catch {
        return false;
    }
}

function findPluginContext(filePath) {
    let dir = path.dirname(filePath);
    for (let i = 0; i < 32; i++) {
        if (fs.existsSync(path.join(dir, 'plugin.toml'))) {
            const relative = path.relative(dir, filePath);
            const parts = relative.split(path.sep);
            const area = parts.shift();
            if ((area !== 'src' && area !== 'ui') || parts.length === 0) return null;
            return {
                area,
                parts,
                sourceRoot: path.join(dir, 'src'),
            };
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

function packageName(manifestPath) {
    try {
        const manifest = fs.readFileSync(manifestPath, 'utf8');
        const header = /^\[package\]\s*$/m.exec(manifest);
        if (!header) return null;
        const afterHeader = manifest.slice(header.index + header[0].length);
        const nextSection = /^\[/m.exec(afterHeader);
        const section = nextSection ? afterHeader.slice(0, nextSection.index) : afterHeader;
        return section.match(/^\s*name\s*=\s*"([^"]+)"\s*$/m)?.[1] || null;
    } catch {
        return null;
    }
}

function findRustSourceContext(filePath) {
    let dir = path.dirname(filePath);
    for (let i = 0; i < 32; i++) {
        const manifestPath = path.join(dir, 'Cargo.toml');
        if (fs.existsSync(manifestPath)) {
            const relative = path.relative(dir, filePath);
            const parts = relative.split(path.sep);
            if (parts[0] !== 'src' || parts.length < 2) return null;
            return {
                crateRoot: dir,
                packageName: packageName(manifestPath),
                parts: parts.slice(1),
                sourceRoot: path.join(dir, 'src'),
            };
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

function findModuleHybrid(filePath, sourceRoot) {
    if (path.extname(filePath) !== '.rs') return null;

    const basename = path.basename(filePath);
    if (basename !== 'mod.rs') {
        const siblingDirectory = path.join(
            path.dirname(filePath),
            basename.slice(0, -'.rs'.length),
        );
        if (isDirectory(siblingDirectory)) {
            return { file: filePath, directory: siblingDirectory };
        }
    }

    let dir = path.dirname(filePath);
    while (dir !== sourceRoot) {
        const relative = path.relative(sourceRoot, dir);
        if (relative.startsWith('..') || path.isAbsolute(relative)) break;
        const siblingFile = `${dir}.rs`;
        if (fs.existsSync(siblingFile)) {
            return { file: siblingFile, directory: dir };
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    return null;
}

function findMixedPlatformShape(filePath, sourceRoot) {
    const relative = path.relative(sourceRoot, filePath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
    const parts = relative.split(path.sep);
    const platformIndex = parts.lastIndexOf('platform');
    if (platformIndex < 0 || parts.length <= platformIndex + 1) return null;

    const platformDir = path.join(sourceRoot, ...parts.slice(0, platformIndex + 1));
    const child = parts[platformIndex + 1];
    const flatName = path.extname(child) === '.rs' ? path.basename(child, '.rs') : null;
    const shape = flatName && OS_MODULE_NAMES.has(flatName)
        ? 'flat'
        : OS_MODULE_NAMES.has(child)
            ? 'directory'
            : null;
    if (!shape) return null;

    const conflicts = [...OS_MODULE_NAMES]
        .map(name => shape === 'flat' ? path.join(platformDir, name) : path.join(platformDir, `${name}.rs`))
        .filter(candidate => isDirectory(candidate) || fs.existsSync(candidate));
    if (conflicts.length === 0) return null;
    return { kind: 'mixed-platform-shape', conflicts, platformDir };
}

function findSourceLayoutViolation(filePath) {
    const context = findRustSourceContext(filePath);
    if (!context || path.extname(filePath) !== '.rs' || fs.existsSync(filePath)) return null;

    const hybrid = findModuleHybrid(filePath, context.sourceRoot);
    if (hybrid) return { kind: 'module-hybrid', ...hybrid };

    const mixedPlatform = findMixedPlatformShape(filePath, context.sourceRoot);
    if (mixedPlatform) return mixedPlatform;

    if (context.parts.slice(0, -1).some(part => CATCH_ALL_SOURCE_DIRS.has(part))) {
        return { kind: 'catch-all-directory' };
    }

    if (
        context.packageName === 'qol-tray' &&
        context.parts.length === 1 &&
        !QOL_TRAY_ROOT_RUST_FILES.has(context.parts[0])
    ) {
        return { kind: 'qol-tray-source-root-module' };
    }

    return null;
}

function findPluginLayoutViolation(filePath) {
    const context = findPluginContext(filePath);
    if (!context) return null;

    const extension = path.extname(filePath).toLowerCase();
    const isNewPath = !fs.existsSync(filePath);

    if (context.area === 'ui' && isNewPath && extension === '.rs') {
        return { kind: 'rust-in-web-ui' };
    }

    if (
        context.area === 'src' &&
        isNewPath &&
        context.parts[0] === 'ui' &&
        WEB_ASSET_EXTENSIONS.has(extension)
    ) {
        return { kind: 'web-in-native-ui' };
    }

    if (
        context.area === 'src' &&
        isNewPath &&
        context.parts.length === 1 &&
        extension === '.rs' &&
        !PLUGIN_ROOT_RUST_FILES.has(context.parts[0])
    ) {
        return { kind: 'source-root-module' };
    }

    return null;
}

const CANONICAL_TARGET = /^\s*(mod (linux|macos|windows);|pub(?:\([^)]*\))?\s+use (linux|macos|windows)::)/;
const TARGET_ADAPTER_ALIAS = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+[A-Za-z_]\w*\s+as\s+imp\s*;/;
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
const PLATFORM_TOKEN = /\b(current_os|target_os|host_os|os_bucket|platforms|supported_platforms)\b|"(linux|macos|windows|darwin|win32|x11|wayland)"/;
const ROUTING_TOKEN = /\.join\s*\(\s*"os"\s*\)|format!\s*\(\s*"os\/|PathBuf::from\s*\(\s*"os"\s*\)|\b(os|core|device)_(dir|path|bucket)\b|"(core|device)"|"plugin-configs"/;
const DECISION_TOKEN = /\b(if|match)\b|=>|==|!=|\.len\(\)\s*==\s*1|\.contains\s*\(/;
const COMPOSITE_WINDOW = 2;
const TEST_MARKER_ATTRIBUTE = /^#\[\s*(?:[A-Za-z_]\w*\s*::\s*)*(?:test|rstest|test_case|bench|proptest)\b/;
const CFG_ATTRIBUTE = /^#\[\s*cfg\s*\(/;
const ITEM_HEAD = /^\s*(?:\{|(?:pub(?:\s*\([^)]*\))?\s+)?(?:default\s+)?(?:const\s+|async\s+|unsafe\s+|extern\s+(?:"[^"]*"\s+)?)*(?:fn|mod|impl|struct|enum|trait|union|use|type|static|let|macro_rules)\b)/;

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function log(msg) {
    if (lintMode.active()) return;
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
    if (lintMode.isTarget(filePath)) return null;
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return null;
    }
}

// The content a rule about added code compares against: the file before the
// edit, or the file at the lint base.
function readBaseline(filePath) {
    return lintMode.isTarget(filePath) ? lintMode.baseline() : readExistingFile(filePath);
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

function sanitizeSource(content, blankLiterals) {
    const out = content.split('');
    const blank = (from, to) => {
        for (let index = from; index < to && index < out.length; index++) {
            if (out[index] !== '\n') out[index] = ' ';
        }
    };
    let index = 0;
    while (index < content.length) {
        const ch = content[index];
        if (ch === '/' && content[index + 1] === '/') {
            let end = content.indexOf('\n', index);
            if (end < 0) end = content.length;
            blank(index, end);
            index = end;
            continue;
        }
        if (ch === '/' && content[index + 1] === '*') {
            let depth = 1;
            let end = index + 2;
            while (end < content.length && depth > 0) {
                if (content[end] === '/' && content[end + 1] === '*') { depth++; end += 2; continue; }
                if (content[end] === '*' && content[end + 1] === '/') { depth--; end += 2; continue; }
                end++;
            }
            blank(index, end);
            index = end;
            continue;
        }
        const raw = /^b?r(#*)"/.exec(content.slice(index, index + 16));
        if (raw && (ch === 'r' || ch === 'b') && !/\w/.test(content[index - 1] || '')) {
            const terminator = `"${raw[1]}`;
            const found = content.indexOf(terminator, index + raw[0].length);
            const end = found < 0 ? content.length : found + terminator.length;
            if (blankLiterals) blank(index, end);
            index = end;
            continue;
        }
        if (ch === '"') {
            let end = index + 1;
            while (end < content.length) {
                if (content[end] === '\\') { end += 2; continue; }
                if (content[end] === '"') { end++; break; }
                end++;
            }
            if (blankLiterals) blank(index, end);
            index = end;
            continue;
        }
        if (ch === "'") {
            const char = /^'(?:\\.|[^\\'])'/.exec(content.slice(index, index + 8));
            if (char) {
                if (blankLiterals) blank(index, index + char[0].length);
                index += char[0].length;
                continue;
            }
        }
        index++;
    }
    return out.join('');
}

function isTestAttribute(attribute) {
    if (TEST_MARKER_ATTRIBUTE.test(attribute)) return true;
    if (!CFG_ATTRIBUTE.test(attribute)) return false;
    let predicate = attribute;
    let previous;
    do {
        previous = predicate;
        predicate = predicate.replace(/\bnot\s*\([^()]*\)/g, '');
    } while (predicate !== previous);
    return /\btest\b/.test(predicate);
}

function readAttributeRun(code, start) {
    const attributes = [];
    let index = start;
    while (code.startsWith('#[', index)) {
        let depth = 0;
        let end = index + 1;
        for (; end < code.length; end++) {
            if (code[end] === '[') depth++;
            else if (code[end] === ']' && --depth === 0) break;
        }
        if (end >= code.length) return null;
        attributes.push(code.slice(index, end + 1));
        index = end + 1;
        while (index < code.length && /\s/.test(code[index])) index++;
    }
    if (attributes.length === 0 || index >= code.length) return null;
    return { attributes, itemStart: index };
}

function findItemEnd(code, start) {
    const lineEnd = code.indexOf('\n', start);
    const head = code.slice(start, lineEnd < 0 ? code.length : lineEnd);
    const blockItem = ITEM_HEAD.test(head);
    let depth = 0;
    let openedBody = false;
    for (let index = start; index < code.length; index++) {
        const ch = code[index];
        if (ch === '{' || ch === '(' || ch === '[') {
            if (ch === '{' && depth === 0) openedBody = true;
            depth++;
            continue;
        }
        if (ch === '}' || ch === ')' || ch === ']') {
            depth--;
            if (depth < 0) return index;
            if (depth === 0 && openedBody && ch === '}') return index + 1;
            continue;
        }
        if (depth > 0) continue;
        if (ch === ';') return index + 1;
        if (ch === ',' && !blockItem) return index + 1;
    }
    return null;
}

function maskTestItems(content) {
    const code = sanitizeSource(content, true);
    const ranges = [];
    let index = 0;
    while (index < code.length) {
        const start = code.indexOf('#[', index);
        if (start < 0) break;
        const run = readAttributeRun(code, start);
        const end = run && run.attributes.some(isTestAttribute)
            ? findItemEnd(code, run.itemStart)
            : null;
        if (end === null) {
            index = start + 2;
            continue;
        }
        ranges.push([start, end]);
        index = end;
    }
    if (ranges.length === 0) return content;
    const out = content.split('');
    for (const [from, to] of ranges) {
        for (let cursor = from; cursor < to && cursor < out.length; cursor++) {
            if (out[cursor] !== '\n') out[cursor] = ' ';
        }
    }
    return out.join('');
}

function productionCode(content) {
    return sanitizeSource(maskTestItems(content), false);
}

const FACADE_MOD_DECLARATION = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+([A-Za-z_]\w*)\s*;/;
const FACADE_SIBLING_USE = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+(?:self::)?([A-Za-z_]\w*)(?:\s+as\b|::)/;

function declaredModules(lines) {
    const names = new Set();
    for (const line of lines) {
        const match = line.match(FACADE_MOD_DECLARATION);
        if (match) names.add(match[1]);
    }
    return names;
}

// A platform/mod.rs facade declares its adapter modules and selects one per
// target, whatever the visibility or the alias it selects them under.
function isFacadeSelection(line, siblings) {
    if (FACADE_MOD_DECLARATION.test(line)) return true;
    const use = line.match(FACADE_SIBLING_USE);
    return use !== null && siblings.has(use[1]);
}

const USE_STATEMENT = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+/;

// qol-arch-cross-platform owns cfg(target_os) on a use statement outside a
// platform/ directory, so this guard leaves those lines to it.
function findCfgViolations(content, allowTargetAdapterAlias = false, usesOwnedElsewhere = false) {
    const lines = content.split(/\r?\n/);
    const siblings = allowTargetAdapterAlias ? declaredModules(lines) : new Set();
    const violations = [];
    let pending = null; // { lineno, text }

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineno = i + 1;
        if (pending !== null) {
            if (ATTRIBUTE_LINE.test(line)) {
                continue; // stacked attributes — keep waiting
            }
            if (
                (usesOwnedElsewhere && USE_STATEMENT.test(line)) ||
                CANONICAL_TARGET.test(line) ||
                (allowTargetAdapterAlias &&
                    (TARGET_ADAPTER_ALIAS.test(line) || isFacadeSelection(line, siblings)))
            ) {
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

function platformContext(filePath) {
    const parts = path.resolve(filePath).split(path.sep);
    const platformIndex = parts.lastIndexOf('platform');
    if (platformIndex < 0) return null;
    const platformDir = parts.slice(0, platformIndex + 1).join(path.sep) || path.sep;
    const relativeParts = parts.slice(platformIndex + 1);
    const target = OS_MODULE_NAMES.has(relativeParts[0]?.replace(/\.rs$/, ''))
        ? relativeParts[0].replace(/\.rs$/, '')
        : null;
    return {
        platformDir,
        relativeParts,
        target,
        facade: relativeParts.length === 1 && relativeParts[0] === 'mod.rs',
    };
}

function isOsAdapterFile(filePath) {
    const context = platformContext(filePath);
    return context !== null && context.target !== null;
}

// Evaluates a cfg predicate for one target. Returns null when the predicate
// names anything other than the target platform (a feature, test, ...), so a
// selection that depends on it never counts as target coverage.
function cfgHolds(expression, target) {
    let index = 0;
    const skipSpace = () => {
        while (index < expression.length && /\s/.test(expression[index])) index++;
    };
    const parse = () => {
        skipSpace();
        const word = expression.slice(index).match(/^[A-Za-z_]\w*/);
        if (!word) throw new Error('cfg');
        index += word[0].length;
        skipSpace();
        if (expression[index] === '(') {
            index++;
            const values = [];
            skipSpace();
            while (expression[index] !== ')') {
                values.push(parse());
                skipSpace();
                if (expression[index] === ',') index++;
                skipSpace();
                if (index >= expression.length) throw new Error('cfg');
            }
            index++;
            if (word[0] === 'not' && values.length === 1) return values[0] === null ? null : !values[0];
            if (values.includes(null)) return null;
            if (word[0] === 'all') return values.every(Boolean);
            if (word[0] === 'any') return values.some(Boolean);
            throw new Error('cfg');
        }
        if (expression[index] === '=') {
            index++;
            skipSpace();
            const literal = expression.slice(index).match(/^"([^"]*)"/);
            if (!literal) throw new Error('cfg');
            index += literal[0].length;
            if (word[0] === 'target_os') return literal[1] === target;
            if (word[0] === 'target_family') return literal[1] === (target === 'windows' ? 'windows' : 'unix');
            return null;
        }
        if (word[0] === 'unix') return target !== 'windows';
        if (word[0] === 'windows') return target === 'windows';
        return null;
    };
    try {
        const value = parse();
        skipSpace();
        return index === expression.length ? value : null;
    } catch {
        return null;
    }
}

function cfgTargets(attribute) {
    const match = attribute.match(/^\s*#\[cfg\(([\s\S]*)\)\]\s*$/);
    if (!match) return [];
    return TARGET_OS_NAMES.filter(target => cfgHolds(match[1], target) === true);
}

function targetScopedUses(content) {
    const lines = content.split(/\r?\n/);
    const selections = new Map();
    for (let i = 0; i < lines.length; i++) {
        if (!/^\s*#\[cfg\(/.test(lines[i])) continue;
        let attribute = lines[i];
        while (!/\)\]\s*$/.test(attribute) && i + 1 < lines.length) attribute += ` ${lines[++i].trim()}`;
        if (!/target_os|target_family|\bunix\b|\bwindows\b/.test(attribute)) continue;
        const targets = cfgTargets(attribute);
        if (targets.length === 0) continue;

        let itemIndex = i + 1;
        while (itemIndex < lines.length && /^\s*#\[/.test(lines[itemIndex])) itemIndex++;
        const itemLines = [];
        while (itemIndex < lines.length) {
            itemLines.push(lines[itemIndex]);
            if (lines[itemIndex].includes(';')) break;
            itemIndex++;
        }
        const item = itemLines.join('\n');
        const match = item.match(
            /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+(?:self::)?([A-Za-z_]\w*)(?:(::(?:\*|[A-Za-z_]\w*|\{[\s\S]*\}))|\s+as\s+([A-Za-z_]\w*))\s*;/,
        );
        if (!match) continue;
        const moduleName = match[1];
        const alias = match[3] || null;
        const exports = exportedNames(match[2]);
        for (const target of targets) {
            const modules = selections.get(target) || new Map();
            const selection = modules.get(moduleName) || { moduleName, alias: null, exports: new Set() };
            for (const name of exports) selection.exports.add(name);
            if (alias) selection.alias = alias;
            modules.set(moduleName, selection);
            selections.set(target, modules);
        }
    }
    return selections;
}

function exportedNames(pathSuffix) {
    if (!pathSuffix) return [];
    if (pathSuffix === '::*') return ['*'];
    if (!pathSuffix.startsWith('::{')) return [pathSuffix.slice(2)];
    return pathSuffix
        .slice(3, -1)
        .split(',')
        .map(name => name.trim().split(/\s+as\s+/)[0])
        .filter(Boolean);
}

function adapterSourcePath(platformDir, moduleName) {
    const candidates = [
        path.join(platformDir, `${moduleName}.rs`),
        path.join(platformDir, moduleName, 'mod.rs'),
    ];
    return candidates.find(candidate => fs.existsSync(candidate)) || candidates[0];
}

function prospectiveContent(sourcePath, filePath, newContent) {
    if (path.resolve(sourcePath) === path.resolve(filePath)) return newContent;
    return readExistingFile(sourcePath);
}

function facadeConsumers(content, alias) {
    return new Set([...content.matchAll(new RegExp(`\\b${alias}::([A-Za-z_]\\w*)`, 'g'))].map(match => match[1]));
}

function sourceExposes(content, name) {
    if (!content) return false;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const declaration = new RegExp(
        `\\bpub(?:\\([^)]*\\))?\\s+(?:(?:async|unsafe)\\s+)*(?:fn|struct|enum|type|const|static)\\s+${escaped}\\b`,
    );
    const reexport = new RegExp(`\\bpub(?:\\([^)]*\\))?\\s+use\\s+[^;]*\\b${escaped}\\b`);
    return declaration.test(content) || reexport.test(content);
}

function bracedBody(content, openingBrace) {
    let depth = 0;
    for (let index = openingBrace; index < content.length; index++) {
        if (content[index] === '{') depth++;
        if (content[index] !== '}') continue;
        depth--;
        if (depth === 0) return content.slice(openingBrace + 1, index);
    }
    return null;
}

function traitRequirements(content) {
    const requirements = new Map();
    const declaration = /\btrait\s+([A-Za-z_]\w*)[^{]*\{/g;
    for (const match of content.matchAll(declaration)) {
        const openingBrace = match.index + match[0].lastIndexOf('{');
        const body = bracedBody(content, openingBrace);
        if (body === null) continue;
        const methods = new Set();
        const method = /\bfn\s+([A-Za-z_]\w*)\s*(?:<[^>{}]*>)?\s*\([^)]*\)[^{;]*(;|\{)/g;
        for (const methodMatch of body.matchAll(method)) {
            if (methodMatch[2] === ';') methods.add(methodMatch[1]);
        }
        if (methods.size > 0) requirements.set(match[1], methods);
    }
    return requirements;
}

// Methods of traitName implemented for a type the facade selects. A trait
// implemented only for other types (a std stream behind a dyn trait) is a
// product of the adapter, not its contract.
function traitImplementationMethods(content, traitName, selectedTypes) {
    const escaped = traitName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const implementation = new RegExp(
        `\\bimpl(?:\\s*<[^>{}]*>)?\\s+(?:(?:[A-Za-z_]\\w*)::)*${escaped}(?:\\s*<[^>{}]*>)?\\s+for\\s+(?:(?:[A-Za-z_]\\w*)::)*([A-Za-z_]\\w*)[^{}]*\\{`,
        'g',
    );
    const methods = new Set();
    let found = false;
    for (const match of content.matchAll(implementation)) {
        if (!selectedTypes.has(match[1])) continue;
        found = true;
        const openingBrace = match.index + match[0].lastIndexOf('{');
        const body = bracedBody(content, openingBrace);
        if (body === null) continue;
        for (const method of body.matchAll(/\bfn\s+([A-Za-z_]\w*)\b/g)) {
            methods.add(method[1]);
        }
    }
    return found ? methods : null;
}

function findPlatformFacadeViolations(filePath, newContent) {
    const context = platformContext(filePath);
    if (!context) return [];
    const modFile = path.join(context.platformDir, 'mod.rs');
    const modContent = prospectiveContent(modFile, filePath, newContent);
    if (!modContent) return [];
    const selections = targetScopedUses(modContent);
    if (selections.size === 0) return [];

    const violations = [];
    const missingTargets = TARGET_OS_NAMES.filter(target => !selections.has(target));
    if (missingTargets.length > 0) {
        violations.push(`missing target coverage: ${missingTargets.join(', ')}`);
        return violations;
    }

    const directSurfaces = TARGET_OS_NAMES.map(target =>
        [...selections.get(target).values()].flatMap(selection => [...selection.exports]).sort().join(','));
    if (
        directSurfaces.some(surface => surface.length > 0) &&
        new Set(directSurfaces).size > 1
    ) {
        violations.push(
            `callable surface differs: ${TARGET_OS_NAMES
                .map((target, index) => `${target}=[${directSurfaces[index]}]`)
                .join(' ')}`,
        );
    }

    const selectedTypes = new Set();
    const adapterSources = new Map();
    for (const target of TARGET_OS_NAMES) {
        const sources = [];
        for (const selection of selections.get(target).values()) {
            const sourcePath = adapterSourcePath(context.platformDir, selection.moduleName);
            const source = prospectiveContent(sourcePath, filePath, newContent);
            if (!source) {
                violations.push(`${selection.moduleName} adapter is missing for ${target}`);
                continue;
            }
            sources.push(source);
            const required = new Set([
                ...[...selection.exports].filter(name => name !== '*'),
                ...(selection.alias ? facadeConsumers(modContent, selection.alias) : []),
            ]);
            for (const name of required) {
                selectedTypes.add(name);
                if (!sourceExposes(source, name)) {
                    violations.push(`${selection.moduleName} adapter is missing ${name} for ${target}`);
                }
            }
        }
        adapterSources.set(target, sources);
    }

    for (const [traitName, requiredMethods] of traitRequirements(modContent)) {
        const implementations = new Map(
            [...adapterSources].map(([target, sources]) => {
                const found = sources
                    .map(source => traitImplementationMethods(source, traitName, selectedTypes))
                    .filter(methods => methods !== null);
                return [target, found.length > 0 ? new Set(found.flatMap(methods => [...methods])) : null];
            }),
        );
        if (![...implementations.values()].some(methods => methods !== null)) continue;
        for (const target of TARGET_OS_NAMES) {
            const methods = implementations.get(target);
            for (const method of requiredMethods) {
                if (!methods?.has(method)) {
                    violations.push(`${target} adapter is missing ${traitName}::${method}`);
                }
            }
        }
    }
    return violations;
}

const OS_MOD_ALIAS = /^\s*(?:pub(?:\([^)]*\))?\s+)?mod (linux|macos|windows);\s*$/;
const FAMILY_CFG = /#\[cfg\((?:not\()?(?:unix\b|windows\b|target_family\s*=)/;

function osModAliases(content) {
    const names = new Set();
    for (const line of content.split(/\r?\n/)) {
        const match = line.match(OS_MOD_ALIAS);
        if (match) names.add(match[1]);
    }
    return names;
}

function findFamilyMergeViolation(filePath, newContent) {
    const context = platformContext(filePath);
    if (!context || !context.facade) return null;
    const before = readExistingFile(filePath);
    if (!before) return null;
    const after = osModAliases(newContent);
    const removed = [...osModAliases(before)].filter(name => !after.has(name));
    if (removed.length === 0 || !FAMILY_CFG.test(newContent)) return null;
    return removed;
}

function blockFamilyMerge(filePath, removed) {
    lintMode.report(process.stderr, `qol-arch-code violation in ${filePath}.

This edit removes per-OS platform module slots (${removed.join(', ')}) and
replaces them with a cfg(unix)/cfg(windows)/target_family alias.

Identical per-OS files under platform/ are NOT duplicate code. They are
reserved OS slots the architecture expects to diverge (a macOS impl moving
off shell-outs, a real Windows impl replacing a stub). Merging them deletes
those slots and hides ownership.

Family-cfg facades (cfg(unix) mod unix;) are allowed only when a module is
AUTHORED that way from the start for genuinely family-shared code. Converting
an existing per-OS facade into one is what this guard blocks.

If the bodies are identical today, leave them identical - or extract a shared
helper that each per-OS file calls.

Reference: qol-project:qol-arch-code skill.

Bypass for this edit only:
  touch .claude/bypass-qol-arch-code
`);
}

const SETTINGS_SIGNALS = [
    {
        label: 'contract-less config loader',
        pattern: /\bload_plugin_config(?:_or|_from_env)?\b/g,
    },
    {
        label: 'raw config file path',
        pattern: /\bplugin_config_paths(?:_from_env)?\b/g,
    },
    {
        label: 'host config tree (qol_config::config_dir)',
        pattern: /\bqol_config::config_dir\b/g,
    },
];

function settingsSignalCounts(content) {
    const code = productionCode(content);
    return SETTINGS_SIGNALS.map(signal => (code.match(signal.pattern) || []).length);
}

function findNewSettingsSignals(filePath, newContent) {
    if (findPluginContext(filePath)?.area !== 'src') return [];
    const before = settingsSignalCounts(readBaseline(filePath) || '');
    const after = settingsSignalCounts(newContent);
    return SETTINGS_SIGNALS
        .filter((_, index) => after[index] > before[index])
        .map(signal => signal.label);
}

function blockSettings(filePath, labels) {
    const detail = labels.map(label => `  - ${label}`).join('\n');
    lintMode.report(process.stderr, `qol-arch-code violation in ${filePath}.

This edit hand-rolls plugin settings instead of going through the contract:

${detail}

Declare the setting in the plugin's qol-config.toml and read the config with
qol_config::load_plugin_config_from_env_with_contract(PLUGIN_ID,
qol_config::plugin_config_contract!()). The host owns the config file; a
plugin never locates, reads or writes it itself.

Reference: qol-project:qol-arch-code skill, "Enforcement: settings guard".

Bypass for this edit only:
  touch .claude/bypass-qol-arch-code
`);
}

const TEST_DEADLINE_FLOOR_MS = 5000;
const DURATION_LITERAL = String.raw`(?:std::time::)?Duration::from_(millis|micros|secs|secs_f32|secs_f64)\(\s*([\d_.]+)\s*\)`;
const TEST_DEADLINE_SIGNALS = [
    {
        label: 'elapsed-time upper bound under 5 s',
        pattern: new RegExp(String.raw`\belapsed(?:\(\))?\s*<=?\s*` + DURATION_LITERAL, 'g'),
    },
    {
        label: 'recv_timeout under 5 s on an event the test expects',
        pattern: new RegExp(
            String.raw`\brecv_timeout\(\s*` + DURATION_LITERAL
                + String.raw`\s*\)\s*\.\s*(?:unwrap\(\)|expect\(|is_ok\(\)|unwrap_or_else\()`,
            'g',
        ),
    },
    {
        label: 'tokio timeout under 5 s on a future the test expects',
        pattern: new RegExp(
            String.raw`\btimeout\(\s*` + DURATION_LITERAL
                + String.raw`\s*,[^;{}]*?\)\s*\.await\s*\.\s*(?:unwrap\(\)|expect\()`,
            'g',
        ),
    },
];
const TEST_OVERRIDE_CONST = /#\[cfg\(\s*(not\s*\(\s*test\s*\)|test)\s*\)\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?const\s+(\w+)\s*:\s*(?:std::time::)?Duration\b/g;
const DEADLINE_NAME = /TIMEOUT|DEADLINE|BACKSTOP|BUDGET|GRACE/;

function durationMs(unit, value) {
    const amount = Number(value.replace(/_/g, ''));
    if (unit === 'millis') return amount;
    if (unit === 'micros') return amount / 1000;
    return amount * 1000;
}

function shortDeadlineCount(code, pattern) {
    let count = 0;
    for (const match of code.matchAll(pattern)) {
        const ms = durationMs(match[1], match[2]);
        if (ms > 0 && ms < TEST_DEADLINE_FLOOR_MS) count++;
    }
    return count;
}

function testOverrideCount(code) {
    const testNames = new Set();
    const productionNames = new Set();
    for (const match of code.matchAll(TEST_OVERRIDE_CONST)) {
        if (!DEADLINE_NAME.test(match[2])) continue;
        (match[1] === 'test' ? testNames : productionNames).add(match[2]);
    }
    return [...testNames].filter(name => productionNames.has(name)).length;
}

function isTestPath(filePath) {
    const basename = crossPlatformBasename(filePath);
    return TESTS_PATH_RE.test(filePath)
        || EXAMPLES_PATH_RE.test(filePath)
        || basename === 'tests.rs'
        || basename.endsWith('_test.rs')
        || basename.endsWith('_tests.rs');
}

function testDeadlineCounts(filePath, content) {
    const code = sanitizeSource(content, true);
    const production = isTestPath(filePath) ? '' : sanitizeSource(maskTestItems(content), true);
    return [
        ...TEST_DEADLINE_SIGNALS.map(signal =>
            shortDeadlineCount(code, signal.pattern) - shortDeadlineCount(production, signal.pattern)),
        testOverrideCount(code),
    ];
}

const TEST_DEADLINE_LABELS = [
    ...TEST_DEADLINE_SIGNALS.map(signal => signal.label),
    'production deadline shortened under #[cfg(test)]',
];

function findNewTestDeadlines(filePath, newContent) {
    const before = testDeadlineCounts(filePath, readBaseline(filePath) || '');
    const after = testDeadlineCounts(filePath, newContent);
    return TEST_DEADLINE_LABELS.filter((_, index) => after[index] > before[index]);
}

function blockTestDeadlines(filePath, labels) {
    const detail = labels.map(label => `  - ${label}`).join('\n');
    lintMode.report(process.stderr, `qol-arch-code violation in ${filePath}.

This edit makes a passing test race a short clock:

${detail}

CI runs thousands of tests at once and can stall a step for over a second, so
a test that passes only when the code finishes inside a short deadline fails
there at random. Wait at least 5 s for anything the test expects to happen
(the wait ends as soon as it happens), keep an elapsed-time upper bound at
5 s or more with a fixture that hangs far longer, and pass a short deadline
as a parameter only to the test that expects the timeout itself.

Reference: qol-tray:qol-apps-testing skill, "Never let a passing test race a
short clock".

Bypass for this edit only:
  touch .claude/bypass-qol-arch-code
`);
}

function platformViolationKind(violation) {
    if (violation.startsWith('missing target coverage:')) return 'missing target coverage';
    if (violation.startsWith('callable surface differs:')) return 'callable surface differs';
    return violation;
}

// A facade's coverage is one property of its platform/ tree. Lint reports it
// once, on the facade; an edit to any file in the tree still checks it.
function findNewPlatformFacadeViolations(filePath, newContent) {
    if (lintMode.isTarget(filePath) && !platformContext(filePath)?.facade) return [];
    const beforeContent = readExistingFile(filePath) || '';
    const before = new Set(
        findPlatformFacadeViolations(filePath, beforeContent).map(platformViolationKind),
    );
    return findPlatformFacadeViolations(filePath, newContent)
        .filter(violation => !before.has(platformViolationKind(violation)));
}

function blockPlatformFacade(filePath, violations) {
    lintMode.report(process.stderr, `qol-arch-code violation in ${filePath}.

The platform facade is incomplete:

${violations.map(violation => `  - ${violation}`).join('\n')}

Every target-selection facade must cover Linux, macOS, and Windows with a
real adapter or an explicitly selected fallback. Every selected adapter must
provide the same callable surface before a shared consumer is added.

Reference: qol-project:qol-arch-code skill.

Bypass for this edit only:
  touch .claude/bypass-qol-arch-code
`);
}

function isArchitectureBoundary(filePath, content) {
    const basename = crossPlatformBasename(filePath);
    if (filePath.split(/[\\/]/).includes('platform')) return true;
    if (ARCH_BOUNDARY_BASENAME.test(basename)) return true;
    if (ARCH_BOUNDARY_SUFFIX.test(basename)) return true;
    if (ARCH_BOUNDARY_TYPE.test(content)) return true;
    return false;
}

const STRONG_PLATFORM_SIGNALS = [
    { label: 'cfg!(target_os)', re: CFG_MACRO },
    { label: '#[cfg(target_family)]', re: CFG_TARGET_FAMILY },
    { label: '#[cfg(unix/windows)]', re: CFG_UNIX_WINDOWS },
    { label: 'std::env::consts::OS', re: RUNTIME_OS_CONST },
    { label: 'OS-specific import', re: OS_API_IMPORT },
    { label: 'OS command dispatch', re: OS_COMMAND },
];

function findStrongPlatformSignals(content) {
    return STRONG_PLATFORM_SIGNALS
        .filter(candidate => candidate.re.test(content))
        .map(candidate => candidate.label);
}

function findCompositePlatformSignals(content) {
    const lines = content.split(/\r?\n/);
    let hasRouting = false;
    let hasDecision = false;
    for (let index = 0; index < lines.length; index++) {
        if (!PLATFORM_TOKEN.test(lines[index])) continue;
        const window = lines
            .slice(Math.max(0, index - COMPOSITE_WINDOW), index + COMPOSITE_WINDOW + 1)
            .join('\n');
        if (ROUTING_TOKEN.test(window)) hasRouting = true;
        if (DECISION_TOKEN.test(window)) hasDecision = true;
    }
    const labels = [];
    if (hasRouting) labels.push('platform token + storage/path routing');
    if (hasDecision) labels.push('platform token + branching');
    return labels;
}

function platformDecisionSignals(content) {
    const production = productionCode(content);
    return [
        ...findStrongPlatformSignals(production),
        ...findCompositePlatformSignals(production),
    ];
}

function findNewPlatformDecisionSignals(filePath, newContent) {
    const before = new Set(platformDecisionSignals(readBaseline(filePath) || ''));
    return platformDecisionSignals(newContent).filter(signal => !before.has(signal));
}

function blockCompileError(filePath) {
    lintMode.report(process.stderr, `qol-arch-code violation in ${filePath}: \`compile_error!\` macro found.

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
    lintMode.report(process.stderr, `qol-arch-code violation in ${filePath}.

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
    lintMode.report(process.stderr, `qol-arch-code violation in ${filePath}.

OS-named files (linux.rs, macos.rs, windows.rs) must live inside a
\`platform/\` directory. Found this one outside any \`platform/\` directory.

Fix the layout to one of:

  src/<feature>/platform/{linux,macos,windows}.rs   (per-feature)
  src/platform/{linux,macos,windows}.rs             (top-level shared)

The \`platform/\` directory keeps cross-platform code visibly compartmentalized
and prevents OS-specific files from drifting into business-code paths.

Bypass for this edit only:
  touch .claude/bypass-qol-arch-code
`);
}

function blockSourceLayout(filePath, violation) {
    let problem;
    let fix;

    switch (violation.kind) {
        case 'source-root-module':
            problem = `New Rust implementation modules may not be created directly under a plugin's \`src/\` root.`;
            fix = `Keep only \`main.rs\`, \`lib.rs\`, and optional \`cli.rs\` there. Move this code to \`src/<capability>/mod.rs\` and wire it from the crate facade.`;
            break;
        case 'qol-tray-source-root-module':
            problem = `New Rust implementation modules may not be created directly under qol-tray's \`src/\` root.`;
            fix = `Keep only \`main.rs\` and \`lib.rs\` there. Move this code beneath the subsystem that owns it and preserve any stable import through a facade re-export.`;
            break;
        case 'module-hybrid':
            problem = `A Rust module cannot use both \`${violation.file}\` and the sibling directory \`${violation.directory}/\`.`;
            fix = `Represent a module with children as \`<module>/mod.rs\`; do not combine \`<module>.rs\` with \`<module>/\`.`;
            break;
        case 'catch-all-directory':
            problem = `New Rust code may not be added under a catch-all \`common\`, \`helper(s)\`, or \`util(s)\` directory.`;
            fix = `Name the capability or boundary that owns the code and place it there.`;
            break;
        case 'mixed-platform-shape':
            problem = `One \`platform/\` directory cannot mix flat OS modules with OS directory modules. Conflicting paths: ${violation.conflicts.join(', ')}.`;
            fix = `Use either \`platform/{linux,macos,windows}.rs\` or \`platform/{linux,macos,windows}/mod.rs\` uniformly within ${violation.platformDir}.`;
            break;
        case 'rust-in-web-ui':
            problem = `Rust UI code does not belong in the plugin-root \`ui/\` directory.`;
            fix = `Move native GPUI code to \`src/ui/\`. Plugin-root \`ui/\` is reserved for host-served HTML, JavaScript, and CSS.`;
            break;
        case 'web-in-native-ui':
            problem = `Browser assets do not belong in \`src/ui/\`.`;
            fix = `Move host-served HTML, JavaScript, and CSS to the plugin-root \`ui/\` directory. \`src/ui/\` is reserved for compiled Rust/GPUI presentation code.`;
            break;
        default:
            problem = 'The Rust source layout violates the canonical directory structure.';
            fix = 'Move the file beneath the capability or adapter that owns it.';
    }

    lintMode.report(process.stderr, `qol-arch-code violation in ${filePath}.

${problem}

Fix:
  ${fix}

The guard is prospective: existing legacy files remain editable, but new
layout debt is blocked. See the qol-project:qol-arch-code skill.

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

    lintMode.report(process.stderr, `qol-arch-code violation in ${filePath}.

Detected #[cfg(target_os = ...)] attributes outside the canonical mod.rs
re-export pattern:

${detail}

The skill requires:

  - cfg(target_os) appears ONLY in mod.rs to alias OS submodules:
        #[cfg(target_os = "linux")]    mod linux;
        #[cfg(target_os = "linux")]    pub use linux::Platform;

  - Each platform impl lives in src/<feature>/platform/{linux,macos,windows}.rs.
    Those files are the only place OS-specific code may live. Inside them
    cfg(target_os) is unnecessary because the file itself is OS-gated.

  - Stubs return typed Err on unsupported OSes. No compile_error!,
    no cfg-gated pub fns/structs, no cfg sprawl in business code.

Refactor steps:
  1. Move OS-specific code into platform/linux.rs, platform/macos.rs, and
     platform/windows.rs siblings.
  2. Define a trait in mod.rs.
  3. Each <os>.rs has \`pub(crate) struct Platform; impl Trait for Platform\`.
  4. Replace business-code cfg blocks with calls to \`Platform.method(...)\`.

Reference: qol-project:qol-arch-code skill.

Bypass for this edit only:
  touch .claude/bypass-qol-arch-code
  # or for N edits in a row:
  echo 5 > .claude/bypass-qol-arch-code
`);
}

function markerPaths(cwd, filePath, name = 'bypass-qol-arch-code') {
    const markers = [];
    const seen = new Set();
    const push = dir => {
        if (!dir) return;
        const marker = path.join(dir, '.claude', name);
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

function consumeBypass(cwd, filePath, basename, name) {
    if (lintMode.active()) return false;
    for (const marker of markerPaths(cwd, filePath, name)) {
        if (consumeBypassMarker(marker, basename)) return true;
    }
    return false;
}

function blockDesign(filePath, relative, violations) {
    lintMode.report(process.stderr, `qol-arch-code design violation in ${filePath}.

This edit adds code that does not follow the Bone and Amber design the rest of
qol is built from. Each line says what to use instead:

${design.formatViolations(relative, violations)}

The register, the ladders and the settings page shape are in the
qol-project:qol-gpui-theme skill; libs/theme/tests/theme.rs fails the build on
the same patterns. The rules and where each comes from are in the
qol-project:qol-arch-code skill, "Enforcement: design guard".

Bypass for this edit only:
  touch .claude/bypass-qol-design
  # or for N edits in a row:
  echo 5 > .claude/bypass-qol-design
`);
}

function findNewDesignViolations(tool, input, filePath) {
    const root = design.workspaceRoot(filePath);
    if (!root) return null;
    const relative = design.relativeTo(root, filePath);
    const after = extractNewContent(tool, { ...input, file_path: filePath });
    if (!after) return null;
    const violations = design.newViolations(relative, readBaseline(filePath), after, root);
    return violations.length > 0 ? { relative, violations } : null;
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
    return evaluate(payload);
}

function evaluate(payload) {
    const tool = payload.tool_name || payload.tool || '';
    if (!INSPECTED_TOOLS.has(tool)) return 0;

    const input = payload.tool_input || {};
    const inputPath = input.file_path || input.notebook_path || '';
    if (!inputPath) return 0;

    const cwd = payload.cwd || process.cwd();
    const filePath = path.isAbsolute(inputPath) ? inputPath : path.resolve(cwd, inputPath);

    if (!QOL_TOOLS_PATH_RE.test(filePath)) return 0;

    const basename = crossPlatformBasename(filePath);

    const layoutViolation = findSourceLayoutViolation(filePath) || findPluginLayoutViolation(filePath);
    if (layoutViolation) {
        if (consumeBypass(cwd, filePath, basename)) return 0;
        blockSourceLayout(filePath, layoutViolation);
        return 2;
    }

    const designViolation = findNewDesignViolations(tool, input, filePath);
    if (designViolation && !consumeBypass(cwd, filePath, basename, 'bypass-qol-design')) {
        blockDesign(filePath, designViolation.relative, designViolation.violations);
        return 2;
    }

    if (!filePath.endsWith('.rs')) return 0;

    const deadlineContent = extractNewContent(tool, { ...input, file_path: filePath });
    const newDeadlines = deadlineContent ? findNewTestDeadlines(filePath, deadlineContent) : [];
    if (newDeadlines.length > 0 && !consumeBypass(cwd, filePath, basename)) {
        blockTestDeadlines(filePath, newDeadlines);
        return 2;
    }

    if (
        TESTS_PATH_RE.test(filePath) ||
        EXAMPLES_PATH_RE.test(filePath) ||
        basename.endsWith('_test.rs') ||
        basename.endsWith('_tests.rs') ||
        basename === 'tests.rs'
    ) {
        return 0;
    }

    if (OS_BASENAMES.has(basename)) {
        if (!filePath.split(/[\\/]/).includes('platform')) {
            blockOsFileOutsidePlatform(filePath);
            return 2;
        }
    }

    if (consumeBypass(cwd, filePath, basename)) return 0;

    const newContent = extractNewContent(tool, { ...input, file_path: filePath });
    if (!newContent) return 0;

    const platformViolations = findNewPlatformFacadeViolations(filePath, newContent);
    if (platformViolations.length > 0) {
        blockPlatformFacade(filePath, platformViolations);
        return 2;
    }

    const familyMerge = findFamilyMergeViolation(filePath, newContent);
    if (familyMerge) {
        blockFamilyMerge(filePath, familyMerge);
        return 2;
    }

    const settingsSignals = findNewSettingsSignals(filePath, newContent);
    if (settingsSignals.length > 0) {
        blockSettings(filePath, settingsSignals);
        return 2;
    }

    if (isOsAdapterFile(filePath)) return 0;

    if (COMPILE_ERROR.test(newContent)) {
        blockCompileError(filePath);
        return 2;
    }

    const violations = findCfgViolations(
        productionCode(newContent),
        platformContext(filePath)?.facade === true,
        !/[\\/]platform[\\/]/.test(filePath),
    );
    if (violations.length > 0) {
        blockCfgViolations(filePath, violations);
        return 2;
    }

    if (!isArchitectureBoundary(filePath, newContent)) {
        const signals = findNewPlatformDecisionSignals(filePath, newContent);
        if (signals.length > 0) {
            blockPlatformDecision(filePath, signals);
            return 2;
        }
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

const LOCATORS = [
    ...SETTINGS_SIGNALS.map(signal => ({ label: signal.label, re: signal.pattern })),
    ...STRONG_PLATFORM_SIGNALS,
    { label: 'platform token + storage/path routing', re: PLATFORM_TOKEN },
    { label: 'platform token + branching', re: PLATFORM_TOKEN },
    { label: 'compile_error!', re: COMPILE_ERROR },
    ...TEST_DEADLINE_SIGNALS.map(signal => ({ label: signal.label, re: signal.pattern })),
    { label: 'production deadline shortened under #[cfg(test)]', re: TEST_OVERRIDE_CONST },
];

module.exports = { lintFile, LOCATORS };

if (require.main === module) process.exit(main());
