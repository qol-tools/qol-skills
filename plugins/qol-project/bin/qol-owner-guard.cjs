'use strict';

const fs = require('node:fs');
const path = require('node:path');

const OWNERS_FILE = path.join('.qac', 'owners.json');
const IDENT = /[A-Za-z0-9_]/;
const COMPILE_TIME_KEY = /\b(?:target_os|target_family|windows_subsystem)\s*=\s*$/;
const STD_OS_CONSTANT = [
    /\bconsts\s*::\s*(?:OS|FAMILY)\b/g,
    /\bconsts\s*::\s*\{[^}]*\b(?:OS|FAMILY|self)\b/g,
    /\bconsts\s*::\s*\*/g,
    /\bconsts\s+as\b/g,
];
const BUILD_TARGET_OS = 'CARGO_CFG_TARGET_OS';
const ESCAPES = { n: '\n', t: '\t', r: '\r', 0: '\0', '\\': '\\', '"': '"', "'": "'" };

function workspaceRoot(filePath) {
    let dir = path.dirname(filePath);
    for (let i = 0; i < 32; i++) {
        if (fs.existsSync(path.join(dir, '.git'))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
    return null;
}

function relativeTo(root, filePath) {
    return path.relative(root, filePath).split(path.sep).join('/');
}

function readRulebook(root) {
    try {
        return JSON.parse(fs.readFileSync(path.join(root, OWNERS_FILE), 'utf8'));
    } catch {
        return null;
    }
}

function osOwnerFrom(rulebook) {
    const entry = rulebook?.os;
    if (!entry || typeof entry.owner !== 'string' || !Array.isArray(entry.names)) return null;
    return {
        owner: entry.owner,
        use: entry.use || 'the owner',
        text: new Set([...entry.names, ...(entry.labels || [])]),
        allow: (entry.allow || []).map(item => `${item.path}\0${item.text}`),
    };
}

function loadOsOwner(root) {
    return osOwnerFrom(readRulebook(root));
}

function callOwnersFrom(rulebook) {
    if (!rulebook || typeof rulebook !== 'object') return [];
    const owned = [];
    for (const [concept, entry] of Object.entries(rulebook)) {
        if (!entry || !Array.isArray(entry.calls) || !Array.isArray(entry.entry_points)) continue;
        const folders = [entry.owner].flat().filter(folder => typeof folder === 'string');
        if (folders.length === 0) continue;
        owned.push({
            concept,
            folders,
            use: entry.use || 'the owner',
            calls: entry.calls.filter(call => /^[A-Za-z_][A-Za-z0-9_]*$/.test(call)),
            entryPoints: new Set(entry.entry_points),
            allow: (entry.allow || []).map(item => `${item.path}\0${item.text}`),
        });
    }
    return owned;
}

function loadCallOwners(root) {
    return callOwnersFrom(readRulebook(root));
}

function lex(src) {
    const strings = [];
    let code = '';
    let line = 1;
    let i = 0;
    const blank = text => {
        for (const ch of text) {
            code += ch === '\n' ? '\n' : ' ';
            if (ch === '\n') line++;
        }
    };
    while (i < src.length) {
        const c = src[i];
        const next = src[i + 1];
        if (c === '/' && next === '/') {
            const end = src.indexOf('\n', i);
            const stop = end < 0 ? src.length : end;
            blank(src.slice(i, stop));
            i = stop;
            continue;
        }
        if (c === '/' && next === '*') {
            let depth = 0;
            let j = i;
            do {
                if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2; continue; }
                if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2; continue; }
                j++;
            } while (j < src.length && depth > 0);
            blank(src.slice(i, j));
            i = j;
            continue;
        }
        if (c === "'") {
            const point = String.fromCodePoint(src.codePointAt(i + 1) ?? 32);
            const close = next === '\\'
                ? src.indexOf("'", i + 3)
                : src[i + 1 + point.length] === "'" ? i + 1 + point.length : -1;
            if (close > 0) {
                blank(src.slice(i, close + 1));
                i = close + 1;
                continue;
            }
            code += c;
            i++;
            continue;
        }
        const prev = src[i - 1] ?? ' ';
        const raw = !IDENT.test(prev) && src.slice(i, i + 260).match(/^(?:b|c)?r(#*)"/);
        if (raw) {
            const end = `"${raw[1]}`;
            const start = i + raw[0].length;
            const found = src.indexOf(end, start);
            const stop = found < 0 ? src.length : found;
            strings.push({ value: src.slice(start, stop), line, before: code });
            const close = Math.min(src.length, stop + end.length);
            blank(src.slice(i, close));
            i = close;
            continue;
        }
        if (c === '"' || ((c === 'b' || c === 'c') && next === '"' && !IDENT.test(prev))) {
            const startLine = line;
            const before = code;
            let j = c === '"' ? i + 1 : i + 2;
            let value = '';
            while (j < src.length && src[j] !== '"') {
                if (src[j] === '\\') {
                    value += ESCAPES[src[j + 1]] ?? src[j + 1];
                    j += 2;
                    continue;
                }
                value += src[j];
                j++;
            }
            strings.push({ value, line: startLine, before });
            blank(src.slice(i, Math.min(src.length, j + 1)));
            i = j + 1;
            continue;
        }
        code += c;
        if (c === '\n') line++;
        i++;
    }
    return { code, strings };
}

function lineAt(text, offset) {
    let line = 1;
    for (let i = 0; i < offset; i++) if (text[i] === '\n') line++;
    return line;
}

function runtimeOsTests(code) {
    const found = [];
    for (const match of code.matchAll(/\bcfg\s*!\s*\(/g)) {
        let depth = 1;
        let j = match.index + match[0].length;
        while (j < code.length && depth > 0) {
            if (code[j] === '(') depth++;
            else if (code[j] === ')') depth--;
            j++;
        }
        if (/\btarget_os\b/.test(code.slice(match.index, j))) found.push(lineAt(code, match.index));
    }
    return found;
}

function osViolations(relative, content, owner) {
    if (!relative.endsWith('.rs') || relative.startsWith(owner.owner)) return [];
    if (/^(?:vendor|third_party)\//.test(relative)) return [];
    const { code, strings } = lex(content);
    const found = [];
    const add = (line, what, text) => {
        if (owner.allow.includes(`${relative}\0${text}`)) return;
        found.push({ line, what, use: owner.use });
    };
    for (const literal of strings) {
        if (COMPILE_TIME_KEY.test(literal.before)) continue;
        if (owner.text.has(literal.value)) {
            add(literal.line, `OS name typed as text: ${JSON.stringify(literal.value)}`, literal.value);
        }
        if (literal.value.includes(BUILD_TARGET_OS)) {
            add(literal.line, `build target OS read: ${BUILD_TARGET_OS}`, BUILD_TARGET_OS);
        }
    }
    const constantLines = new Set();
    for (const pattern of STD_OS_CONSTANT) {
        for (const match of code.matchAll(pattern)) constantLines.add(lineAt(code, match.index));
    }
    for (const line of constantLines) add(line, 'OS read from std::env::consts', 'consts::OS');
    for (const match of code.matchAll(new RegExp(`\\b${BUILD_TARGET_OS}\\b`, 'g'))) {
        add(lineAt(code, match.index), `build target OS read: ${BUILD_TARGET_OS}`, BUILD_TARGET_OS);
    }
    for (const line of runtimeOsTests(code)) add(line, 'OS tested at run time: cfg!(target_os)', 'cfg!');
    return found.sort((a, b) => a.line - b.line);
}

function functionSpans(code) {
    const spans = [];
    for (const match of code.matchAll(/\bfn\s+([A-Za-z_][A-Za-z0-9_]*)/g)) {
        let depth = 0;
        let j = match.index + match[0].length;
        while (j < code.length) {
            const c = code[j];
            if (c === '(' || c === '[') depth++;
            else if (c === ')' || c === ']') depth--;
            else if (depth === 0 && (c === '{' || c === ';')) break;
            j++;
        }
        if (code[j] !== '{') continue;
        const start = j;
        let braces = 0;
        do {
            if (code[j] === '{') braces++;
            else if (code[j] === '}') braces--;
            j++;
        } while (j < code.length && braces > 0);
        spans.push({ name: match[1], start, end: j });
    }
    return spans;
}

function enclosingFunction(spans, offset) {
    let best = null;
    for (const span of spans) {
        if (span.start <= offset && offset < span.end && (!best || span.start > best.start)) best = span;
    }
    return best ? best.name : null;
}

function callViolations(relative, content, owner) {
    if (!relative.endsWith('.rs') || /^(?:vendor|third_party)\//.test(relative)) return [];
    if (owner.calls.length === 0) return [];
    const { code } = lex(content);
    const spans = functionSpans(code);
    const inside = owner.folders.some(folder => relative.startsWith(folder));
    const found = [];
    const pattern = new RegExp(`(?<!\\bfn\\s+)\\b(${owner.calls.join('|')})\\s*\\(`, 'g');
    for (const match of code.matchAll(pattern)) {
        const name = enclosingFunction(spans, match.index);
        if (inside && owner.entryPoints.has(name)) continue;
        if (name && owner.allow.includes(`${relative}\0${name}`)) continue;
        const where = name ? `fn ${name}` : 'code outside a function';
        found.push({ line: lineAt(code, match.index), what: `${owner.concept} set by ${match[1]} in ${where}`, use: owner.use });
    }
    return found;
}

function ownerViolations(relative, content, os, calls) {
    const found = os ? osViolations(relative, content, os) : [];
    for (const owner of calls) found.push(...callViolations(relative, content, owner));
    return found.sort((a, b) => a.line - b.line);
}

function newViolations(relative, before, after, root) {
    const rulebook = readRulebook(root);
    const os = osOwnerFrom(rulebook);
    const calls = callOwnersFrom(rulebook);
    if (!os && calls.length === 0) return [];
    const counts = new Map();
    for (const violation of ownerViolations(relative, before || '', os, calls)) {
        counts.set(violation.what, (counts.get(violation.what) || 0) + 1);
    }
    const fresh = [];
    for (const violation of ownerViolations(relative, after, os, calls)) {
        const left = counts.get(violation.what) || 0;
        if (left > 0) {
            counts.set(violation.what, left - 1);
            continue;
        }
        fresh.push(violation);
    }
    return fresh;
}

function formatViolations(relative, violations) {
    const shown = violations.slice(0, 12).map(violation =>
        `  - ${relative}:${violation.line} ${violation.what}\n    use: ${violation.use}`);
    if (violations.length > 12) shown.push(`  … and ${violations.length - 12} more`);
    return shown.join('\n');
}

module.exports = {
    lex,
    loadOsOwner,
    loadCallOwners,
    osViolations,
    callViolations,
    newViolations,
    workspaceRoot,
    relativeTo,
    formatViolations,
};
