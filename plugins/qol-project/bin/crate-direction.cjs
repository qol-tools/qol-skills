'use strict';

const fs = require('node:fs');
const path = require('node:path');

const toml = require('./toml-lite.cjs');

const DEPENDENCY_TABLES = ['dependencies', 'build-dependencies', 'dev-dependencies'];
const FORBIDDEN_GROUPS = {
    libs: new Set(['plugins', 'apps', 'tools']),
    plugins: new Set(['plugins', 'apps', 'tools']),
};
const WORKSPACE_TABLE = /^\s*\[workspace\]\s*$/m;

function readFile(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

function parse(text) {
    try {
        return toml.parse(text);
    } catch {
        return null;
    }
}

function workspaceRoot(dir) {
    for (let current = path.resolve(dir); ; current = path.dirname(current)) {
        const manifest = readFile(path.join(current, 'Cargo.toml'));
        if (manifest !== null && WORKSPACE_TABLE.test(manifest)) return current;
        if (path.dirname(current) === current) return null;
    }
}

function segments(root, target) {
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
    return relative.split(path.sep);
}

function dependencyEntries(value) {
    const entries = [];
    const collect = table => {
        for (const kind of DEPENDENCY_TABLES) {
            const deps = table?.[kind];
            if (!deps || typeof deps !== 'object') continue;
            for (const [key, spec] of Object.entries(deps)) entries.push({ key, spec, table: deps });
        }
    };
    collect(value);
    for (const target of Object.values(value.target ?? {})) collect(target);
    return entries;
}

function dependencyPath(spec, key, memberDir, root, shared) {
    if (!spec || typeof spec !== 'object') return null;
    if (typeof spec.path === 'string') return path.resolve(memberDir, spec.path);
    const declared = spec.workspace === true ? shared?.[key] : null;
    if (declared && typeof declared === 'object' && typeof declared.path === 'string') return path.resolve(root, declared.path);
    return null;
}

function violations(filePath, content) {
    if (!content) return [];
    const root = workspaceRoot(path.dirname(filePath));
    if (!root) return [];
    const member = segments(root, path.resolve(filePath));
    if (!member || member.length < 3) return [];
    const forbidden = FORBIDDEN_GROUPS[member[0]];
    if (!forbidden) return [];
    const doc = parse(content);
    if (!doc) return [];
    const shared = parse(readFile(path.join(root, 'Cargo.toml')) || '')?.value.workspace?.dependencies;
    const found = [];
    for (const { key, spec, table } of dependencyEntries(doc.value)) {
        const target = dependencyPath(spec, key, path.dirname(path.resolve(filePath)), root, shared);
        const parts = target && segments(root, target);
        if (!parts || !forbidden.has(parts[0])) continue;
        if (parts[0] === member[0] && parts[1] === member[1]) continue;
        found.push({
            line: toml.keyLine(doc.lines, table, key),
            dependency: key,
            from: `${member[0]}/${member[1]}`,
            target: parts.join('/'),
        });
    }
    return found;
}

module.exports = { violations };
