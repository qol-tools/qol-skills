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
const owners = require('./qol-owner-guard.cjs');
const events = require('./qol-event-guard.cjs');
const enumMatches = require('./qol-enum-match-guard.cjs');
const quotes = require('./qol-quote-guard.cjs');
const rustCfg = require('./rust-cfg.cjs');
const serde = require('./rust-serde.cjs');
const toml = require('./toml-lite.cjs');
const { inQolRepo } = require('./qol-repo.cjs');

const INSPECTED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const OS_BASENAMES = new Set(['linux.rs', 'macos.rs', 'windows.rs']);
const TOOL_MATCH = /\bmatch\s+(?:[a-zA-Z_]\w*\.)?tool\s*\{/;
const TOOL_MATCH_ROOTS = ['/libs/terminal-sessions/src/cli/', '/plugins/cli-sessions/src/'];
const TOOL_MATCH_EXEMPT = ['/builtins/', '/tests/', '/test/', '/session/tool.rs'];
const PLUGIN_ROOT_RUST_FILES = new Set(['main.rs', 'lib.rs', 'cli.rs']);
const QOL_TRAY_ROOT_RUST_FILES = new Set(['main.rs', 'lib.rs']);
const CATCH_ALL_SOURCE_DIRS = new Set(['common', 'helper', 'helpers', 'util', 'utils']);
const OS_MODULE_NAMES = new Set(rustCfg.TARGETS);
const TARGET_OS_NAMES = rustCfg.TARGETS;
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

function isVendored(filePath) {
    return VENDORED_DIRECTORY.test(serde.repoRelative(filePath));
}

function findSourceLayoutViolation(filePath) {
    const context = findRustSourceContext(filePath);
    if (!context || path.extname(filePath) !== '.rs' || isVendored(filePath)) return null;

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

    if (context.area === 'ui' && extension === '.rs') {
        return { kind: 'rust-in-web-ui' };
    }

    if (
        context.area === 'src' &&
        context.parts[0] === 'ui' &&
        WEB_ASSET_EXTENSIONS.has(extension)
    ) {
        return { kind: 'web-in-native-ui' };
    }

    if (
        context.area === 'src' &&
        context.parts.length === 1 &&
        extension === '.rs' &&
        !PLUGIN_ROOT_RUST_FILES.has(context.parts[0])
    ) {
        return { kind: 'source-root-module' };
    }

    return null;
}

const CANONICAL_TARGET = new RegExp(`^\\s*(mod (${rustCfg.TARGETS.join('|')});|pub(?:\\([^)]*\\))?\\s+use (${rustCfg.TARGETS.join('|')})::)`);
const TARGET_ADAPTER_ALIAS = /^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+[A-Za-z_]\w*\s+as\s+imp\s*;/;
const COMPILE_ERROR = /\bcompile_error!\s*\(/;
const ARCH_BOUNDARY_BASENAME = /^(platform|facade|strategy|resolver|scope|scope_store)\.rs$/;
const ARCH_BOUNDARY_SUFFIX = /_(facade|strategy|resolver|scope|scope_store)\.rs$/;
const ARCH_BOUNDARY_TYPE = /\b(struct|enum|trait)\s+\w*(Platform|Facade|Strategy|Resolver|ScopeStore)\b/;
const FAMILY_CFG_KEYS = new Set(['target_family', 'target_vendor', 'target_env', 'unix', 'windows']);
const TARGET_OS_KEY = new Set(['target_os']);
const OS_CFG_KEYS = new Set([...FAMILY_CFG_KEYS, ...TARGET_OS_KEY]);
const RUNTIME_OS_CONST = /\bconsts\s*::\s*(?:OS|FAMILY)\b/;
const RUNTIME_OS_PATH = /(?:^|::)env::consts::(?:OS|FAMILY)$/;
const PORTABLE_STD_OS_MODULES = new Set(['raw']);
const USE_KEYWORD = /(?<![\w$])use\s+/g;
const RUST_PATH = /(?<![\w:.$])(?:::\s*)?[A-Za-z_]\w*(?:\s*::\s*[A-Za-z_]\w*)+/g;
const EXTERN_CRATE = /(?<![\w$])extern\s+crate\s+([A-Za-z_]\w*)/g;
const OS_COMMAND = /\bCommand::new\s*\(\s*"(open|osascript|xdg-open|powershell|cmd(?:\.exe)?|sw_vers|uname|lsb_release)"\s*\)/;
const PLATFORM_TOKEN = /\b(current_os|target_os|host_os|os_bucket|platforms|supported_platforms)\b|"(linux|macos|windows|darwin|win32|x11|wayland)"/;
const ROUTING_TOKEN = /\.join\s*\(\s*"os"\s*\)|format!\s*\(\s*"os\/|PathBuf::from\s*\(\s*"os"\s*\)|\b(os|core|device)_(dir|path|bucket)\b|"(core|device)"|"plugin-configs"/;
const DECISION_TOKEN = /\b(if|match)\b|=>|==|!=|\.len\(\)\s*==\s*1|\.contains\s*\(/;
const COMPOSITE_WINDOW = 2;
const SHOWN_SIGNAL_LINES = 8;

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

function maskTestItems(content) {
    return serde.blankSpans(content, serde.testSpans(serde.lexRust(content).skeleton));
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
    for (const predicate of rustCfg.predicates(content, sanitizeSource(content, true))) {
        if (predicate.kind === 'macro' || !rustCfg.decidesOs(predicate, TARGET_OS_KEY)) continue;
        const cfgText = lines
            .slice(predicate.line - 1, predicate.endLine)
            .map((line, index) => (index === 0 ? line : line.trim()))
            .join(' ');
        const target = predicate.inner
            ? { lineno: predicate.line, text: '(the whole module)' }
            : rustCfg.itemAfter(content, predicate, lines);
        if (target === null) {
            violations.push({
                cfgLineno: predicate.line,
                cfgText,
                targetLineno: -1,
                targetText: '(no target line, malformed cfg block?)',
            });
            continue;
        }
        if (!predicate.inner && allowedCfgTarget(target.text, allowTargetAdapterAlias, usesOwnedElsewhere, siblings)) continue;
        violations.push({ cfgLineno: predicate.line, cfgText, targetLineno: target.lineno, targetText: target.text });
    }
    return violations;
}

function allowedCfgTarget(line, allowTargetAdapterAlias, usesOwnedElsewhere, siblings) {
    if (usesOwnedElsewhere && USE_STATEMENT.test(line)) return true;
    if (CANONICAL_TARGET.test(line)) return true;
    return allowTargetAdapterAlias && (TARGET_ADAPTER_ALIAS.test(line) || isFacadeSelection(line, siblings));
}

function cfgViolationsIn(filePath, content) {
    return findCfgViolations(
        productionCode(content),
        platformContext(filePath)?.facade === true,
        !/[\\/]platform[\\/]/.test(filePath),
    );
}

function findNewCfgViolations(filePath, newContent) {
    const key = violation => `${violation.cfgText}\n${violation.targetText}`.replace(/\s+/g, ' ').trim();
    const before = new Map();
    for (const violation of cfgViolationsIn(filePath, readBaseline(filePath) || '')) {
        before.set(key(violation), (before.get(key(violation)) || 0) + 1);
    }
    return cfgViolationsIn(filePath, newContent).filter(violation => {
        const left = before.get(key(violation)) || 0;
        if (left === 0) return true;
        before.set(key(violation), left - 1);
        return false;
    });
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
    const tree = rustCfg.parse(expression);
    return tree ? rustCfg.holds(tree, target) : null;
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
const FAMILY_ALIAS_KEYS = new Set(['unix', 'windows', 'target_family']);

function osModAliases(content) {
    const names = new Set();
    for (const line of content.split(/\r?\n/)) {
        const match = line.match(OS_MOD_ALIAS);
        if (match) names.add(match[1]);
    }
    return names;
}

function hasFamilyCfg(content) {
    return rustCfg.predicates(sanitizeSource(content, false), sanitizeSource(content, true))
        .some(predicate => predicate.kind !== 'macro' && rustCfg.decidesOs(predicate, FAMILY_ALIAS_KEYS));
}

function findFamilyMergeViolation(filePath, newContent) {
    const context = platformContext(filePath);
    if (!context || !context.facade) return null;
    const before = readExistingFile(filePath);
    if (!before) return null;
    const after = osModAliases(newContent);
    const removed = [...osModAliases(before)].filter(name => !after.has(name));
    if (removed.length === 0 || !hasFamilyCfg(newContent)) return null;
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

const MONITOR_KIT_PACKAGE = 'qol-gpui';
const VENDORED_DIRECTORY = /^(?:vendor|third_party)[\\/]/;

const MONITOR_SIGNALS = [
    {
        label: 'gpui window opened outside the qol-gpui kit',
        pattern: /\.open_window\s*\(/g,
        owns: source => source.packageName === MONITOR_KIT_PACKAGE,
    },
    {
        label: 'ActiveMonitor built outside qol_gpui::monitor',
        pattern: /\bActiveMonitor::from_(?!(?:event|key)\b)\w+\s*\(/g,
        owns: source => source.packageName === MONITOR_KIT_PACKAGE
            && (source.parts[0] === 'monitor.rs' || source.parts[0] === 'monitor'),
    },
    {
        label: 'saved window placement picked as the monitor',
        pattern: /\.remembered_monitor\s*\(/g,
        owns: () => false,
    },
    {
        label: 'window centered on the primary display',
        pattern: /\bBounds::centered\s*\(\s*None\b/g,
        owns: () => false,
    },
];

function monitorSignalCounts(content, signals) {
    const code = productionCode(content);
    return signals.map(signal => (code.match(signal.pattern) || []).length);
}

function findNewMonitorSignals(filePath, newContent) {
    if (isVendored(filePath)) return [];
    const source = findRustSourceContext(filePath);
    if (!source) return [];
    const signals = MONITOR_SIGNALS.filter(signal => !signal.owns(source));
    const before = monitorSignalCounts(readBaseline(filePath) || '', signals);
    const after = monitorSignalCounts(newContent, signals);
    return signals
        .filter((_, index) => after[index] > before[index])
        .map(signal => signal.label);
}

function blockMonitorSignals(filePath, labels) {
    const detail = labels.map(label => `  - ${label}`).join('\n');
    lintMode.report(process.stderr, `qol-arch-code violation in ${filePath}.

This edit places a gpui window outside the active-monitor signal:

${detail}

qol-tray picks the active monitor once and every window follows it. Open
windows through the qol-gpui kit with the monitor from
MonitorTracker::snapshot_monitor() or resolve_active_monitor(); only
qol_gpui::monitor builds an ActiveMonitor. Saved placement, the cursor, a
window's own display and gpui's primary display are not the signal.

Reference: qol-project:qol-arch-code skill, "Enforcement: active-monitor guard".

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

function testDeadlineCounts(filePath, content) {
    const code = sanitizeSource(content, true);
    const production = serde.isTestFile(filePath) ? '' : sanitizeSource(maskTestItems(content), true);
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

function regexLines(content, re) {
    const lines = [];
    content.split(/\r?\n/).forEach((text, index) => {
        if (re.test(text)) lines.push(index + 1);
    });
    return lines;
}

function predicateLines(predicates, attributes, keys) {
    return predicates
        .filter(predicate => (predicate.kind !== 'macro') === attributes)
        .filter(predicate => rustCfg.decidesOs(predicate, keys))
        .map(predicate => predicate.line)
        .filter((line, index, all) => all.indexOf(line) === index);
}

function packageManifest(filePath) {
    for (let dir = path.dirname(path.resolve(filePath)); ; dir = path.dirname(dir)) {
        let text = null;
        try {
            text = fs.readFileSync(path.join(dir, 'Cargo.toml'), 'utf8');
        } catch {
            text = null;
        }
        if (text !== null && /^\s*\[package\]/m.test(text)) return text;
        if (path.dirname(dir) === dir) return null;
    }
}

function osOnlyCrates(filePath) {
    const manifest = packageManifest(filePath);
    if (manifest === null) return [];
    let doc;
    try {
        doc = toml.parse(manifest).value;
    } catch {
        return [];
    }
    const kind = path.basename(filePath) === 'build.rs' ? 'build-dependencies' : 'dependencies';
    const declared = new Map();
    const declare = (name, tree) => declared.set(name, [...(declared.get(name) || []), tree]);
    for (const name of Object.keys(doc[kind] || {})) declare(name, rustCfg.ALWAYS);
    for (const [target, tables] of Object.entries(doc.target || {})) {
        const tree = rustCfg.targetTree(target) || rustCfg.ALWAYS;
        for (const name of Object.keys(tables?.[kind] || {})) declare(name, tree);
    }
    return [...declared]
        .filter(([, trees]) => !trees.includes(rustCfg.ALWAYS) && rustCfg.dependsOnOs({ op: 'any', args: trees }))
        .map(([name]) => name.replace(/-/g, '_'));
}

function useStatements(code) {
    const statements = [];
    for (const match of code.matchAll(USE_KEYWORD)) {
        const start = match.index + match[0].length;
        let depth = 0;
        let end = start;
        for (; end < code.length; end++) {
            if (code[end] === '{') depth++;
            else if (code[end] === '}' && --depth < 0) break;
            else if (code[end] === ';' && depth === 0) break;
        }
        statements.push({ from: match.index, start, end });
    }
    return statements;
}

function useLeaves(code, start, end, prefix = '', leaves = []) {
    const open = code.indexOf('{', start);
    if (open < 0 || open >= end) {
        const text = code.slice(start, end);
        const path = prefix + text.replace(/\s+as\s+[A-Za-z_]\w*\s*$/, '').replace(/\s+/g, '');
        if (text.trim()) leaves.push({ path, index: start + text.length - text.trimStart().length });
        return leaves;
    }
    const head = prefix + code.slice(start, open).replace(/\s+/g, '');
    let depth = 0;
    let from = open + 1;
    for (let index = open; index < end; index++) {
        if (code[index] === '{') {
            depth++;
        } else if (code[index] === '}' && --depth === 0) {
            if (code.slice(from, index).trim()) useLeaves(code, from, index, head, leaves);
            break;
        } else if (code[index] === ',' && depth === 1) {
            if (code.slice(from, index).trim()) useLeaves(code, from, index, head, leaves);
            from = index + 1;
        }
    }
    return leaves;
}

function osSpecificPath(path, crates) {
    const segments = path.replace(/^::/, '').split('::');
    if (crates.has(segments[0])) return true;
    return segments[0] === 'std'
        && segments[1] === 'os'
        && /^[A-Za-z_]\w*$/.test(segments[2] || '')
        && segments[2] !== 'self'
        && !PORTABLE_STD_OS_MODULES.has(segments[2]);
}

function runtimeOsLines(code, statements) {
    const starts = rustCfg.lineStarts(code);
    const lines = new Set(regexLines(code, RUNTIME_OS_CONST));
    for (const statement of statements) {
        for (const leaf of useLeaves(code, statement.start, statement.end)) {
            if (RUNTIME_OS_PATH.test(leaf.path.replace(/^::/, ''))) lines.add(rustCfg.lineAt(starts, leaf.index));
        }
    }
    return [...lines].sort((a, b) => a - b);
}

function osImportLines(filePath, code, statements) {
    const crates = new Set(osOnlyCrates(filePath));
    const starts = rustCfg.lineStarts(code);
    const lines = new Set();
    for (const statement of statements) {
        for (const leaf of useLeaves(code, statement.start, statement.end)) {
            if (osSpecificPath(leaf.path, crates)) lines.add(rustCfg.lineAt(starts, leaf.index));
        }
    }
    const inUse = index => statements.some(statement => index >= statement.from && index < statement.end);
    for (const match of code.matchAll(RUST_PATH)) {
        if (!inUse(match.index) && osSpecificPath(match[0].replace(/\s+/g, ''), crates)) {
            lines.add(rustCfg.lineAt(starts, match.index));
        }
    }
    for (const match of code.matchAll(EXTERN_CRATE)) {
        if (crates.has(match[1])) lines.add(rustCfg.lineAt(starts, match.index));
    }
    return [...lines].sort((a, b) => a - b);
}

function findStrongPlatformSignals(filePath, kept, blanked) {
    const predicates = rustCfg.predicates(kept, blanked);
    const statements = useStatements(blanked);
    return [
        { label: 'cfg!(..) naming the OS', lines: predicateLines(predicates, false, OS_CFG_KEYS) },
        { label: '#[cfg(..)] naming an OS family', lines: predicateLines(predicates, true, FAMILY_CFG_KEYS) },
        { label: 'std::env::consts::OS or FAMILY', lines: runtimeOsLines(blanked, statements) },
        { label: 'OS-specific import', lines: osImportLines(filePath, blanked, statements) },
        { label: 'OS command dispatch', lines: regexLines(kept, OS_COMMAND) },
    ].filter(signal => signal.lines.length > 0);
}

function findCompositePlatformSignals(content) {
    const lines = content.split(/\r?\n/);
    const routing = [];
    const branching = [];
    for (let index = 0; index < lines.length; index++) {
        if (!PLATFORM_TOKEN.test(lines[index])) continue;
        const window = lines
            .slice(Math.max(0, index - COMPOSITE_WINDOW), index + COMPOSITE_WINDOW + 1)
            .join('\n');
        if (ROUTING_TOKEN.test(window)) routing.push(index + 1);
        if (DECISION_TOKEN.test(window)) branching.push(index + 1);
    }
    return [
        { label: 'platform token + storage/path routing', lines: routing },
        { label: 'platform token + branching', lines: branching },
    ].filter(signal => signal.lines.length > 0);
}

function platformDecisionSignals(filePath, content) {
    const masked = maskTestItems(content);
    const kept = sanitizeSource(masked, false);
    const blanked = sanitizeSource(masked, true);
    return [
        ...findStrongPlatformSignals(filePath, kept, blanked),
        ...findCompositePlatformSignals(kept),
    ];
}

function signalOccurrences(filePath, content) {
    const lines = content.split(/\r?\n/);
    const counts = new Map();
    for (const signal of platformDecisionSignals(filePath, content)) {
        for (const line of signal.lines) {
            const key = `${signal.label}\n${(lines[line - 1] || '').replace(/\s+/g, ' ').trim()}`;
            counts.set(key, (counts.get(key) || 0) + 1);
        }
    }
    return counts;
}

function findNewPlatformDecisionSignals(filePath, newContent) {
    const before = signalOccurrences(filePath, readBaseline(filePath) || '');
    const lines = newContent.split(/\r?\n/);
    return platformDecisionSignals(filePath, newContent)
        .map(signal => ({
            label: signal.label,
            lines: signal.lines.filter(line => {
                const key = `${signal.label}\n${(lines[line - 1] || '').replace(/\s+/g, ' ').trim()}`;
                const left = before.get(key) || 0;
                if (left === 0) return true;
                before.set(key, left - 1);
                return false;
            }),
        }))
        .filter(signal => signal.lines.length > 0);
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

function signalLines(lines) {
    const shown = lines.slice(0, SHOWN_SIGNAL_LINES).map(line => `line ${line}`);
    if (lines.length > SHOWN_SIGNAL_LINES) shown.push(`and ${lines.length - SHOWN_SIGNAL_LINES} more`);
    return shown.join(', ');
}

function blockPlatformDecision(filePath, signals) {
    const detail = signals.map(signal => `  - ${signal.label}: ${signalLines(signal.lines)}`).join('\n');
    lintMode.report(process.stderr, `qol-arch-code violation in ${filePath}.

Detected platform-specific decision logic outside an architecture boundary:

${detail}

Platform decisions must live behind a facade, strategy, resolver, scope store,
or platform/ module. Business code should call that boundary instead of
branching on OS names, runtime OS constants, OS-specific imports, OS commands,
or scoped profile storage paths directly. An OS-specific import is a path into
std::os other than std::os::raw, or into a crate this package's Cargo.toml
declares only under target tables that do not hold on Linux, macOS and Windows
alike.

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
            problem = `Rust implementation modules may not live directly under a plugin's \`src/\` root.`;
            fix = `Keep only \`main.rs\`, \`lib.rs\`, and optional \`cli.rs\` there. Move this code to \`src/<capability>/mod.rs\` and wire it from the crate facade.`;
            break;
        case 'qol-tray-source-root-module':
            problem = `Rust implementation modules may not live directly under qol-tray's \`src/\` root.`;
            fix = `Keep only \`main.rs\` and \`lib.rs\` there. Move this code beneath the subsystem that owns it and preserve any stable import through a facade re-export.`;
            break;
        case 'module-hybrid':
            problem = `A Rust module cannot use both \`${violation.file}\` and the sibling directory \`${violation.directory}/\`.`;
            fix = `Represent a module with children as \`<module>/mod.rs\`; do not combine \`<module>.rs\` with \`<module>/\`.`;
            break;
        case 'catch-all-directory':
            problem = `Rust code may not live under a catch-all \`common\`, \`helper(s)\`, or \`util(s)\` directory.`;
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

The layout holds for every file, not only new ones, so an edit to a file
in the wrong place is blocked until the file moves. Vendored crates keep
their upstream layout. See the qol-project:qol-arch-code skill.

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

Detected cfg predicates naming target_os (in #[cfg], #[cfg_attr] or #![cfg],
at any depth of all/any/not) outside the canonical mod.rs re-export pattern:

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

function blockOwner(filePath, relative, violations) {
    lintMode.report(process.stderr, `qol-arch-code owner violation in ${filePath}.

This edit names a concept that has one owner without going through it:

${owners.formatViolations(relative, violations)}

The repo lists its owners in .qac/owners.json, and a test in the owning crate
keeps that list equal to the owner's definition. Use the owner's type and
functions instead of a copy of its names or checks.

Reference: qol-project:qol-arch-code skill, "Enforcement: owner guard".

Bypass for this edit only:
  touch .claude/bypass-qol-arch-code
`);
}

function findNewOwnerViolations(filePath, newContent) {
    const root = owners.workspaceRoot(filePath);
    if (!root) return null;
    const relative = owners.relativeTo(root, filePath);
    const violations = owners.newViolations(relative, readBaseline(filePath), newContent, root);
    return violations.length > 0 ? { relative, violations } : null;
}

function toolMatchScope(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    if (!TOOL_MATCH_ROOTS.some(root => normalized.includes(root))) return false;
    return !TOOL_MATCH_EXEMPT.some(exempt => normalized.includes(exempt));
}

function countToolMatches(content) {
    return (content.match(new RegExp(TOOL_MATCH.source, 'g')) || []).length;
}

function findNewToolMatches(filePath, newContent) {
    if (!toolMatchScope(filePath)) return false;
    return countToolMatches(newContent) > countToolMatches(readBaseline(filePath) || '');
}

function blockToolMatch(filePath) {
    lintMode.report(process.stderr, `qol-arch-code tool match violation in ${filePath}.

A \`match\` on the tool in shared code is a second registry that drifts from the
facade; per-tool behavior belongs in the backend for that tool.

Move the variant behavior into a backend module (builtins/<tool>/name.rs,
platform/<variant>/, a registered strategy) and consume the facade.

Reference: qol-plugin-cli-sessions skill, "Naming and per-tool backends".

Bypass for this edit only:
  touch .claude/bypass-qol-arch-code
`);
}

function blockEvents(filePath, violations) {
    lintMode.report(process.stderr, `qol-arch-code runtime event violation in ${filePath}.

This edit breaks the runtime event contract every subscriber parses:

${events.formatViolations(violations)}

Event variants are past tense, and payloads only grow: a new field carries
#[serde(default)] (or is an Option), and a shape change is a new variant,
never a rename or a removal.

Reference: qol-project:qol-arch-channels skill, "Rules".

Bypass for this edit only:
  touch .claude/bypass-qol-arch-code
`);
}

function findNewEventViolations(filePath, newContent) {
    return events.newViolations(filePath, readBaseline(filePath), newContent);
}

function blockEnumMatches(filePath, violations) {
    lintMode.report(process.stderr, `qol-arch-code enum match violation in ${filePath}.

This edit adds a \`_ =>\` arm to a match over an enum the workspace declares:

${enumMatches.formatViolations(violations)}

The wildcard turns the compile error a new variant would raise here into a
silent default. Name the variants the arm stands for, joined with |, so a new
variant makes the compiler point at this match.

Reference: qol-project:qol-arch-code skill, "Enforcement: enum match guard".

Bypass for this edit only:
  touch .claude/bypass-qol-arch-code
`);
}

function findNewEnumMatchViolations(filePath, newContent) {
    return enumMatches.newViolations(filePath, readBaseline(filePath), newContent);
}

function blockQuotes(filePath, broken) {
    lintMode.report(process.stderr, `qol-arch-code quoted line violation in ${filePath}.

This edit changes text that Rust tests quote verbatim from this file, so they fail in CI:

${quotes.formatQuotes(broken)}

The test reads this file through include_str! and asserts that it contains each
quote. Update the quotes in the test to the new text first, then this edit
passes; or keep the quoted text.

Reference: qol-project:qol-arch-code skill, "Enforcement: quoted line guard".

Bypass for this edit only:
  touch .claude/bypass-qol-arch-code
`);
}

function editedContent(tool, input, filePath) {
    if (tool === 'Write') return input.content ?? null;
    if (tool !== 'Edit' && tool !== 'MultiEdit') return null;
    let content = readExistingFile(filePath);
    for (const edit of tool === 'Edit' ? [input] : input.edits || []) {
        if (content === null || !edit.old_string || !content.includes(edit.old_string)) return null;
        content = edit.replace_all
            ? content.split(edit.old_string).join(edit.new_string || '')
            : replaceFirst(content, edit.old_string, edit.new_string || '');
    }
    return content;
}

function findBrokenQuotes(tool, input, filePath) {
    if (filePath.endsWith('.rs')) return [];
    const content = editedContent(tool, input, filePath);
    return content === null ? [] : quotes.brokenQuotes(filePath, readBaseline(filePath), content);
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

    if (!inQolRepo(filePath)) return 0;

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

    const brokenQuotes = findBrokenQuotes(tool, input, filePath);
    if (brokenQuotes.length > 0 && !consumeBypass(cwd, filePath, basename)) {
        blockQuotes(filePath, brokenQuotes);
        return 2;
    }

    if (!filePath.endsWith('.rs')) return 0;

    const deadlineContent = extractNewContent(tool, { ...input, file_path: filePath });
    const newDeadlines = deadlineContent ? findNewTestDeadlines(filePath, deadlineContent) : [];
    if (newDeadlines.length > 0 && !consumeBypass(cwd, filePath, basename)) {
        blockTestDeadlines(filePath, newDeadlines);
        return 2;
    }

    const ownerViolation = deadlineContent ? findNewOwnerViolations(filePath, deadlineContent) : null;
    if (ownerViolation && !consumeBypass(cwd, filePath, basename)) {
        blockOwner(filePath, ownerViolation.relative, ownerViolation.violations);
        return 2;
    }

    const eventViolations = deadlineContent ? findNewEventViolations(filePath, deadlineContent) : [];
    if (eventViolations.length > 0 && !consumeBypass(cwd, filePath, basename)) {
        blockEvents(filePath, eventViolations);
        return 2;
    }

    const enumMatchViolations = deadlineContent ? findNewEnumMatchViolations(filePath, deadlineContent) : [];
    if (enumMatchViolations.length > 0 && !consumeBypass(cwd, filePath, basename)) {
        blockEnumMatches(filePath, enumMatchViolations);
        return 2;
    }

    if (deadlineContent && findNewToolMatches(filePath, deadlineContent) && !consumeBypass(cwd, filePath, basename)) {
        blockToolMatch(filePath);
        return 2;
    }

    if (serde.isTestFile(filePath)) return 0;

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

    const monitorSignals = findNewMonitorSignals(filePath, newContent);
    if (monitorSignals.length > 0) {
        blockMonitorSignals(filePath, monitorSignals);
        return 2;
    }

    if (isOsAdapterFile(filePath)) return 0;

    if (COMPILE_ERROR.test(newContent)) {
        blockCompileError(filePath);
        return 2;
    }

    const violations = findNewCfgViolations(filePath, newContent);
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
    ...MONITOR_SIGNALS.map(signal => ({ label: signal.label, re: signal.pattern })),
    { label: 'compile_error!', re: COMPILE_ERROR },
    { label: 'match on the tool in shared code', re: TOOL_MATCH },
    ...TEST_DEADLINE_SIGNALS.map(signal => ({ label: signal.label, re: signal.pattern })),
    { label: 'production deadline shortened under #[cfg(test)]', re: TEST_OVERRIDE_CONST },
];

module.exports = { lintFile, LOCATORS };

if (require.main === module) process.exit(main());
