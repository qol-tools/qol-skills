'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SKIPPED_DIRS = new Set(['target', 'node_modules', 'vendor', 'third_party']);
const INCLUDE_CONST = /\b(?:const|static)\s+([A-Za-z_]\w*)\s*:\s*&\s*(?:'static\s+)?str\s*=\s*include_str!\s*\(\s*"([^"\\]+)"\s*\)/g;
const LOOP = /\bfor\s+([a-z_]\w*)\s+in\s+&?\s*\[/g;
const ESCAPES = { n: '\n', r: '\r', t: '\t', '0': '\0', '\\': '\\', '"': '"', "'": "'" };
const NEEDLE_PREVIEW = 100;

const quotesByCrate = new Map();

function readFile(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

function exists(file) {
    try {
        fs.statSync(file);
        return true;
    } catch {
        return false;
    }
}

function crateRoot(filePath) {
    let dir = path.dirname(filePath);
    for (;;) {
        const manifest = readFile(path.join(dir, 'Cargo.toml'));
        if (manifest !== null) return /^\s*\[package\]/m.test(manifest) ? dir : null;
        if (exists(path.join(dir, '.git'))) return null;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

function repoRoot(dir) {
    for (let current = dir; ; current = path.dirname(current)) {
        if (exists(path.join(current, '.git'))) return current;
        if (path.dirname(current) === current) return dir;
    }
}

function rustFiles(dir, found = []) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return found;
    }
    for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            if (!SKIPPED_DIRS.has(entry.name) && !exists(path.join(full, 'Cargo.toml'))) rustFiles(full, found);
        } else if (entry.name.endsWith('.rs')) {
            found.push(full);
        }
    }
    return found;
}

function lexString(src, at) {
    let i = at;
    if (src[i] === 'r') {
        i += 1;
        let hashes = 0;
        while (src[i] === '#') {
            hashes += 1;
            i += 1;
        }
        if (src[i] !== '"') return null;
        const close = '"' + '#'.repeat(hashes);
        const end = src.indexOf(close, i + 1);
        if (end < 0) return null;
        return { value: src.slice(i + 1, end), end: end + close.length };
    }
    if (src[i] !== '"') return null;
    let value = '';
    i += 1;
    while (i < src.length) {
        const ch = src[i];
        if (ch === '"') return { value, end: i + 1 };
        if (ch !== '\\') {
            value += ch;
            i += 1;
            continue;
        }
        const next = src[i + 1];
        if (next in ESCAPES) {
            value += ESCAPES[next];
            i += 2;
        } else if (next === 'x') {
            value += String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16));
            i += 4;
        } else if (next === 'u') {
            const close = src.indexOf('}', i);
            value += String.fromCodePoint(parseInt(src.slice(i + 3, close), 16));
            i = close + 1;
        } else if (next === '\n' || next === '\r') {
            i += 1;
            while (/\s/.test(src[i] || '')) i += 1;
        } else {
            return null;
        }
    }
    return null;
}

function skipTrivia(src, at) {
    let i = at;
    for (;;) {
        while (/\s/.test(src[i] || '')) i += 1;
        if (src.startsWith('//', i)) {
            const end = src.indexOf('\n', i);
            i = end < 0 ? src.length : end + 1;
        } else if (src.startsWith('/*', i)) {
            const end = src.indexOf('*/', i + 2);
            i = end < 0 ? src.length : end + 2;
        } else {
            return i;
        }
    }
}

function isStringStart(src, i) {
    return src[i] === '"' || (src[i] === 'r' && /^r#*"/.test(src.slice(i, i + 8)) && !/\w/.test(src[i - 1] || ''));
}

function skipChar(src, i) {
    if (src[i + 1] === '\\') {
        const end = src.indexOf("'", i + 2);
        return end > 0 && end - i <= 12 ? end + 1 : i + 1;
    }
    const width = (src.codePointAt(i + 1) ?? 0) > 0xffff ? 2 : 1;
    return src[i + 1 + width] === "'" ? i + 2 + width : i + 1;
}

function matchingBrace(src, open) {
    let depth = 0;
    let i = open;
    while (i < src.length) {
        const after = skipTrivia(src, i);
        if (after !== i) {
            i = after;
            continue;
        }
        if (isStringStart(src, i)) {
            const lexed = lexString(src, i);
            if (!lexed) return -1;
            i = lexed.end;
            continue;
        }
        const ch = src[i];
        if (ch === "'") {
            i = skipChar(src, i);
            continue;
        }
        if (ch === '{') depth += 1;
        if (ch === '}') {
            depth -= 1;
            if (depth === 0) return i;
        }
        i += 1;
    }
    return -1;
}

function lineAt(src, index) {
    return src.slice(0, index).split('\n').length;
}

function literalArray(src, open) {
    const values = [];
    let i = skipTrivia(src, open + 1);
    while (src[i] !== ']') {
        if (!isStringStart(src, i)) return null;
        const lexed = lexString(src, i);
        if (!lexed) return null;
        values.push({ value: lexed.value, line: lineAt(src, i) });
        i = skipTrivia(src, lexed.end);
        if (src[i] === ',') i = skipTrivia(src, i + 1);
        else if (src[i] !== ']') return null;
    }
    return { values, end: i + 1 };
}

function literalLoops(src) {
    const loops = [];
    for (const match of src.matchAll(LOOP)) {
        const array = literalArray(src, match.index + match[0].length - 1);
        if (!array) continue;
        const open = skipTrivia(src, array.end);
        if (src[open] !== '{') continue;
        const close = matchingBrace(src, open);
        if (close < 0) continue;
        loops.push({ ident: match[1], values: array.values, start: open, end: close });
    }
    return loops;
}

function isNegated(src, index) {
    let i = index - 1;
    while (/\s/.test(src[i] || '')) i -= 1;
    return src[i] === '!';
}

function quotesOf(src, name) {
    const quotes = [];
    const loops = literalLoops(src);
    const call = new RegExp(`(?<![\\w.])${name}\\s*\\.\\s*contains\\s*\\(`, 'g');
    for (const match of src.matchAll(call)) {
        if (isNegated(src, match.index)) continue;
        let i = skipTrivia(src, match.index + match[0].length);
        if (src[i] === '&') i = skipTrivia(src, i + 1);
        if (isStringStart(src, i)) {
            const lexed = lexString(src, i);
            if (lexed && src[skipTrivia(src, lexed.end)] === ')') {
                quotes.push({ value: lexed.value, line: lineAt(src, match.index) });
            }
            continue;
        }
        const ident = /^[a-z_]\w*/.exec(src.slice(i))?.[0];
        if (!ident || src[skipTrivia(src, i + ident.length)] !== ')') continue;
        const loop = loops
            .filter(candidate => candidate.ident === ident && candidate.start < match.index && match.index < candidate.end)
            .sort((a, b) => b.start - a.start)[0];
        if (loop) quotes.push(...loop.values);
    }
    return quotes;
}

function crateQuotes(root) {
    if (quotesByCrate.has(root)) return quotesByCrate.get(root);
    const byTarget = new Map();
    const display = repoRoot(root);
    for (const file of rustFiles(root)) {
        const src = readFile(file);
        if (!src || !src.includes('include_str!')) continue;
        for (const match of src.matchAll(INCLUDE_CONST)) {
            const target = path.resolve(path.dirname(file), match[2]);
            const relative = path.relative(display, file).split(path.sep).join('/');
            const quotes = quotesOf(src, match[1]).map(quote => ({ ...quote, file: relative, name: match[1] }));
            if (quotes.length === 0) continue;
            byTarget.set(target, [...(byTarget.get(target) || []), ...quotes]);
        }
    }
    quotesByCrate.set(root, byTarget);
    return byTarget;
}

function brokenQuotes(filePath, baseline, content) {
    if (filePath.endsWith('.rs') || typeof content !== 'string') return [];
    const root = crateRoot(filePath);
    if (!root) return [];
    const quotes = crateQuotes(root).get(path.resolve(filePath)) || [];
    return quotes.filter(quote =>
        !content.includes(quote.value) && (baseline === null || baseline.includes(quote.value)));
}

function preview(value) {
    const flat = JSON.stringify(value);
    return flat.length > NEEDLE_PREVIEW ? `${flat.slice(0, NEEDLE_PREVIEW - 3)}..."` : flat;
}

function formatQuotes(quotes) {
    return quotes.map(quote => `  - ${quote.file}:${quote.line} ${quote.name}.contains(${preview(quote.value)})`).join('\n');
}

module.exports = { brokenQuotes, formatQuotes, quotesOf, lexString };
