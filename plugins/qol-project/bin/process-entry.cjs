'use strict';

const fs = require('node:fs');
const path = require('node:path');

const toml = require('./toml-lite.cjs');
const serde = require('./rust-serde.cjs');

const HOST_PACKAGE = 'qol-tray';
const HOST_BIN = 'qol-tray';
const LOG_PACKAGE_DIR = path.join('libs', 'log');
const HAKARI_CONFIG = path.join('.config', 'hakari.toml');
const SKILL_SECTION = 'qol-project:qol-arch-code, "Output: log, trace, command output"';
const QUALIFIED_CALL = String.raw`(?<![\w])qol_log\s*::\s*init_stderr\s*\(\s*\)`;
const IMPORTED = /\buse\s+qol_log\s*::\s*(?:init_stderr\b|\{[^}]*\binit_stderr\b)/;
const FN_MAIN = /\bfn\s+main\b/g;
const MENTIONS_MAIN = /\bfn\s+main\b/;

function readFile(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

function parse(file) {
    const text = readFile(file);
    if (text === null) return null;
    try {
        return toml.parse(text).value;
    } catch {
        return null;
    }
}

function ancestors(start) {
    const found = [];
    for (let current = path.resolve(start); ; current = path.dirname(current)) {
        found.push(current);
        if (path.dirname(current) === current) return found;
    }
}

function findPackage(file) {
    for (const dir of ancestors(path.dirname(file))) {
        const manifest = parse(path.join(dir, 'Cargo.toml'));
        if (manifest?.package) return { dir, manifest };
    }
    return null;
}

function findWorkspace(pkg) {
    for (const dir of ancestors(pkg.dir)) {
        const manifest = dir === pkg.dir ? pkg.manifest : parse(path.join(dir, 'Cargo.toml'));
        if (manifest?.workspace) return { dir, manifest };
    }
    return null;
}

function entryName(pkg, file) {
    const relative = path.relative(pkg.dir, file).split(path.sep).join('/');
    const declared = (Array.isArray(pkg.manifest.bin) ? pkg.manifest.bin : [])
        .find(bin => typeof bin?.path === 'string' && path.resolve(pkg.dir, bin.path) === file);
    if (declared) return typeof declared.name === 'string' ? declared.name : path.basename(file, '.rs');
    if (relative === 'src/main.rs') return pkg.manifest.package.name;
    const bin = /^src\/bin\/([^/]+)\.rs$/.exec(relative) ?? /^src\/bin\/([^/]+)\/main\.rs$/.exec(relative);
    return bin ? bin[1] : null;
}

function normalDependencies(manifest) {
    const tables = [manifest.dependencies, ...Object.values(manifest.target ?? {}).map(target => target?.dependencies)];
    return tables.flatMap(table => (table && typeof table === 'object' ? Object.entries(table) : []));
}

function dependencyDir(key, spec, memberDir, workspace) {
    if (!spec || typeof spec !== 'object') return null;
    if (typeof spec.path === 'string') return path.resolve(memberDir, spec.path);
    const shared = spec.workspace === true ? workspace.manifest.workspace.dependencies?.[key] : null;
    return shared && typeof shared.path === 'string' ? path.resolve(workspace.dir, shared.path) : null;
}

function logClosure(workspace) {
    const seen = new Set();
    const pending = [path.join(workspace.dir, LOG_PACKAGE_DIR)];
    while (pending.length) {
        const dir = pending.pop();
        if (seen.has(dir)) continue;
        seen.add(dir);
        const manifest = parse(path.join(dir, 'Cargo.toml'));
        if (!manifest) continue;
        for (const [key, spec] of normalDependencies(manifest)) {
            const target = dependencyDir(key, spec, dir, workspace);
            if (target) pending.push(target);
        }
    }
    return seen;
}

function leanPackages(workspace) {
    const names = parse(path.join(workspace.dir, HAKARI_CONFIG))?.['final-excludes']?.['workspace-members'];
    return new Set(Array.isArray(names) ? names.filter(name => typeof name === 'string') : []);
}

function exempt(pkg, workspace, name) {
    if (pkg.manifest.package.name === HOST_PACKAGE && name === HOST_BIN) return true;
    if (leanPackages(workspace).has(pkg.manifest.package.name)) return true;
    return logClosure(workspace).has(pkg.dir);
}

function closing(text, open, left, right) {
    let depth = 0;
    for (let index = open; index < text.length; index++) {
        if (text[index] === left) depth++;
        else if (text[index] === right && --depth === 0) return index;
    }
    return -1;
}

function lineOf(content, offset) {
    return content.slice(0, offset).split('\n').length;
}

function mainBodies(skeleton) {
    const bodies = [];
    let depth = 0;
    let scanned = 0;
    for (const match of skeleton.matchAll(FN_MAIN)) {
        for (; scanned < match.index; scanned++) {
            if (skeleton[scanned] === '{') depth++;
            else if (skeleton[scanned] === '}') depth = Math.max(0, depth - 1);
        }
        if (depth !== 0) continue;
        const params = skeleton.indexOf('(', match.index);
        const paramsEnd = params < 0 ? -1 : closing(skeleton, params, '(', ')');
        if (paramsEnd < 0) continue;
        const rest = skeleton.slice(paramsEnd + 1);
        const open = /^[^{;]*\{/.exec(rest);
        if (!open) continue;
        const start = paramsEnd + open[0].length;
        const end = closing(skeleton, start, '{', '}');
        if (end < 0) continue;
        bodies.push({ at: match.index, start: start + 1, end });
    }
    return bodies;
}

function message(headline, hint) {
    return `${headline}\n[qol-logging] ${hint} (${SKILL_SECTION})`;
}

function entryGaps(filePath, content) {
    const file = path.resolve(filePath);
    if (!file.endsWith('.rs') || !MENTIONS_MAIN.test(content)) return [];
    const pkg = findPackage(file);
    if (!pkg) return [];
    const workspace = findWorkspace(pkg);
    if (!workspace || !parse(path.join(workspace.dir, LOG_PACKAGE_DIR, 'Cargo.toml'))?.package) return [];
    const name = entryName(pkg, file);
    if (name === null || exempt(pkg, workspace, name)) return [];
    const code = serde.production(file, content);
    if (!code) return [];
    const call = new RegExp(IMPORTED.test(code.skeleton) ? `(?:${QUALIFIED_CALL}|(?<![\\w:])init_stderr\\s*\\(\\s*\\))` : QUALIFIED_CALL);
    const first = new RegExp(`^\\s*(?:::)?(?:${call.source})\\s*;`);
    const base = path.basename(file);
    const gaps = [];
    for (const body of mainBodies(code.skeleton)) {
        const text = code.skeleton.slice(body.start, body.end);
        if (first.test(text)) continue;
        const main = lineOf(content, body.at);
        const later = call.exec(text);
        gaps.push(later
            ? message(`Logger init is not first in main in ${base}: on line ${lineOf(content, body.start + later.index)}, qol_log::init_stderr() runs after other statements of the main on line ${main}.`,
                'make qol_log::init_stderr(); the first statement of main, so nothing logs before it')
            : message(`Main never initializes the logger in ${base}: the main on line ${main} calls no qol_log::init_stderr(), so every log:: call in this process is dropped.`,
                'add qol_log::init_stderr(); as the first statement of main'));
    }
    return gaps;
}

module.exports = { entryGaps };
