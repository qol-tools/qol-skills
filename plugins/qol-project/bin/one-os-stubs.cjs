'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const WATCHED = { macos: 'macOS', linux: 'Linux' };

const SILENT_BODIES = [
    /^(?:false|true)$/,
    /^None$/,
    /^0(?:\.0)?(?:_?(?:[iuf]\d+|usize|isize))?$/,
    /^Ok\(\(\)\)$/,
    /^Ok\((?:None|false|true|0|Vec::new\(\)|vec!\[\]|String::new\(\)|Default::default\(\))\)$/,
    /^(?:Vec|String|HashMap|BTreeMap|HashSet|BTreeSet)::new\(\)$/,
    /^vec!\[\]$/,
    /^""(?:\.(?:to_string|to_owned|into)\(\))?$/,
    /^Some\((?:false|true)\)$/,
    /^[A-Z]\w*::(?:Unknown|None|Disabled|Noop|Empty)$/,
];
const DEFAULT_BODY = /^(?:Default::default|Self::default)\(\)$/;
const SILENCED_PARAMS = /^(?:let _ = (?:&?\w+|\((?:\s*&?\w+\s*,?)+\));\s*)+/;
const UNIT_RETURN = /^(?:\(\s*\))?$/;

function stripCode(src) {
    let out = '';
    let i = 0;
    while (i < src.length) {
        const c = src[i];
        const next = src[i + 1];
        if (c === '/' && next === '/') {
            while (i < src.length && src[i] !== '\n') i++;
            continue;
        }
        if (c === '/' && next === '*') {
            let depth = 1;
            i += 2;
            while (i < src.length && depth > 0) {
                if (src[i] === '/' && src[i + 1] === '*') {
                    depth++;
                    i += 2;
                } else if (src[i] === '*' && src[i + 1] === '/') {
                    depth--;
                    i += 2;
                } else {
                    if (src[i] === '\n') out += '\n';
                    i++;
                }
            }
            continue;
        }
        const raw = c === 'r' && !/\w/.test(src[i - 1] || '') ? /^r(#*)"/.exec(src.slice(i, i + 32)) : null;
        if (raw) {
            const close = `"${raw[1]}`;
            const end = src.indexOf(close, i + raw[0].length);
            const stop = end < 0 ? src.length : end + close.length;
            const text = src.slice(i + raw[0].length, end < 0 ? src.length : end);
            out += text ? '"S"' : '""';
            out += '\n'.repeat((text.match(/\n/g) || []).length);
            i = stop;
            continue;
        }
        if (c === '"') {
            let length = 0;
            let lines = 0;
            i++;
            while (i < src.length && src[i] !== '"') {
                if (src[i] === '\\') i++;
                if (src[i] === '\n') lines++;
                i++;
                length++;
            }
            i++;
            out += (length ? '"S"' : '""') + '\n'.repeat(lines);
            continue;
        }
        if (c === "'") {
            const char = /^'(?:\\.[^']*|[^\\'\n])'/.exec(src.slice(i, i + 12));
            if (char) {
                out += "' '";
                i += char[0].length;
                continue;
            }
        }
        out += c;
        i++;
    }
    return out;
}

function closingBrace(code, open) {
    let depth = 0;
    for (let i = open; i < code.length; i++) {
        if (code[i] === '{') depth++;
        else if (code[i] === '}' && --depth === 0) return i;
    }
    return code.length - 1;
}

function lineAt(code, index) {
    let line = 1;
    for (let i = 0; i < index; i++) if (code[i] === '\n') line++;
    return line;
}

function implOwner(header) {
    let text = header;
    while (/<[^<>]*>/.test(text)) text = text.replace(/<[^<>]*>/g, '');
    const forImpl = /(\S+)\s+for\s+(\S+)/.exec(text.trim());
    return forImpl ? `${forImpl[2]} as ${forImpl[1]}` : text.trim().split(/\s+/)[0];
}

function rustFunctions(src) {
    const code = stripCode(src);
    const skipped = [];
    for (const match of code.matchAll(/#\[cfg\(test\)\]\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+\w+\s*\{/g)) {
        const open = match.index + match[0].length - 1;
        skipped.push([match.index, closingBrace(code, open)]);
    }
    const impls = [];
    for (const match of code.matchAll(/^[ \t]*(?:unsafe\s+)?impl\b([^{;]*)\{/gm)) {
        const open = match.index + match[0].length - 1;
        impls.push({ start: open, end: closingBrace(code, open), owner: implOwner(match[1]) });
    }
    const found = [];
    const fnPattern = /^[ \t]*(?:pub(?:\s*\([^)]*\))?\s+)?(?:(?:const|async|unsafe)\s+|extern\s+"S"\s+)*fn\s+([A-Za-z_]\w*)/gm;
    for (const match of code.matchAll(fnPattern)) {
        const at = match.index;
        if (skipped.some(([start, end]) => at > start && at < end)) continue;
        if (found.some(fn => at > fn.open && at < fn.close)) continue;
        const paren = code.indexOf('(', at + match[0].length);
        let depth = 0;
        let close = paren;
        for (; close < code.length; close++) {
            if (code[close] === '(') depth++;
            else if (code[close] === ')' && --depth === 0) break;
        }
        let cursor = close + 1;
        let angle = 0;
        while (cursor < code.length) {
            const ch = code[cursor];
            if (ch === '<') angle++;
            else if (ch === '>' && code[cursor - 1] !== '-') angle--;
            else if ((ch === '{' || ch === ';') && angle <= 0) break;
            cursor++;
        }
        if (code[cursor] !== '{') continue;
        const end = closingBrace(code, cursor);
        const impl = impls.find(block => at > block.start && at < block.end);
        found.push({
            key: impl ? `${impl.owner}::${match[1]}` : match[1],
            name: match[1],
            method: Boolean(impl),
            returns: code.slice(close + 1, cursor).replace(/\bwhere\b[\s\S]*$/, '').replace(/^\s*->/, '').trim(),
            body: code.slice(cursor + 1, end).replace(/\s+/g, ' ').trim(),
            line: lineAt(code, at),
            open: cursor,
            close: end,
        });
    }
    return found;
}

function silentStub(fn) {
    if (UNIT_RETURN.test(fn.returns)) return null;
    const body = fn.body.replace(SILENCED_PARAMS, '').trim();
    if (DEFAULT_BODY.test(body)) return fn.returns === 'Self' ? null : body;
    return SILENT_BODIES.some(pattern => pattern.test(body)) ? body : null;
}

function byKey(src) {
    return new Map(rustFunctions(src || '').map(fn => [fn.key, fn]));
}

function adapterLocation(filePath) {
    const parts = path.resolve(filePath).split(path.sep);
    const index = parts.lastIndexOf('platform');
    if (index < 0 || index >= parts.length - 1) return null;
    const adapter = parts[index + 1].replace(/\.rs$/, '');
    if (adapter === 'mod' || adapter === 'tests') return null;
    return { platformDir: parts.slice(0, index + 1).join(path.sep) || path.sep, adapter };
}

function osOf(adapter) {
    if (/macos/.test(adapter)) return 'macos';
    if (/linux|x11|wayland/.test(adapter)) return 'linux';
    return null;
}

function adapterSources(platformDir, adapter) {
    const flat = path.join(platformDir, `${adapter}.rs`);
    if (fs.existsSync(flat)) return [flat];
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
            if (entry.isDirectory()) {
                if (entry.name !== 'tests') visit(file);
            } else if (entry.name.endsWith('.rs') && entry.name !== 'tests.rs') {
                files.push(file);
            }
        }
    };
    visit(path.join(platformDir, adapter));
    return files;
}

function siblingAdapters(platformDir, own) {
    let entries;
    try {
        entries = fs.readdirSync(platformDir, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter(entry => entry.isDirectory() || entry.name.endsWith('.rs'))
        .map(entry => entry.name.replace(/\.rs$/, ''))
        .filter(name => name !== 'mod' && name !== 'tests' && name !== own);
}

function readSource(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return '';
    }
}

function siblingFunctions(platformDir, own) {
    return siblingAdapters(platformDir, own).map(adapter => ({
        adapter,
        os: osOf(adapter),
        functions: adapterSources(platformDir, adapter).flatMap(file =>
            rustFunctions(readSource(file)).map(fn => ({ ...fn, file }))),
    }));
}

function crateAdapterFiles(filePath, os) {
    const parts = path.resolve(filePath).split(path.sep);
    const src = parts.lastIndexOf('src');
    if (src < 0) return [];
    const files = [];
    const visit = (directory, adapterOs) => {
        let entries;
        try {
            entries = fs.readdirSync(directory, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const file = path.join(directory, entry.name);
            const parentIsPlatform = path.basename(directory) === 'platform';
            const os = parentIsPlatform ? osOf(entry.name.replace(/\.rs$/, '')) : adapterOs;
            if (entry.isDirectory()) {
                if (entry.name !== 'tests' && entry.name !== 'target') visit(file, os);
            } else if (entry.name.endsWith('.rs') && os) {
                files.push({ file, os });
            }
        }
    };
    visit(parts.slice(0, src + 1).join(path.sep) || path.sep, null);
    return files.filter(entry => entry.os === os).map(entry => entry.file);
}

function movedStub(filePath, os, key, body) {
    return crateAdapterFiles(filePath, os)
        .filter(file => path.resolve(file) !== path.resolve(filePath))
        .some(file => {
            const fn = byKey(readSource(file)).get(key);
            return fn !== undefined && silentStub(fn) === body;
        });
}

function repoRoot(directory) {
    const result = spawnSync('git', ['-C', directory, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
}

function sharedCallers(filePath, platformDir, name) {
    const root = repoRoot(path.dirname(filePath));
    if (!root) return [];
    const result = spawnSync('git', ['-C', root, 'grep', '-n', '-I', '-E', `(^|[^A-Za-z0-9_])${name}[[:space:]]*\\(`, '--', '*.rs'], {
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
    });
    if (result.status !== 0) return [];
    const platformPrefix = path.relative(root, platformDir).split(path.sep).join('/') + '/';
    return result.stdout
        .split('\n')
        .map(line => /^([^:]+):(\d+):(.*)$/.exec(line))
        .filter(Boolean)
        .filter(([, file, , text]) =>
            !file.startsWith(platformPrefix)
            && !/(?:^|\/)(?:tests|examples|vendor)\//.test(file)
            && !/_tests?\.rs$|(?:^|\/)tests\.rs$/.test(file)
            && !new RegExp(`\\bfn\\s+${name}\\b`).test(text))
        .map(([, file, line]) => `${file}:${line}`);
}

function relative(filePath) {
    const root = repoRoot(path.dirname(filePath));
    return root ? path.relative(root, filePath).split(path.sep).join('/') : path.basename(filePath);
}

function findOneOsStubs(filePath, before, after) {
    const location = adapterLocation(filePath);
    if (!location || /[\\/](?:tests|examples)[\\/]|_tests?\.rs$|[\\/]tests\.rs$/.test(filePath)) return [];
    const os = osOf(location.adapter);
    if (!os) return [];
    const previous = byKey(before);
    const current = rustFunctions(after);
    const siblings = siblingFunctions(location.platformDir, location.adapter);
    const notes = [];
    for (const fn of current) {
        const body = silentStub(fn);
        const old = previous.get(fn.key);
        const wasStub = old ? silentStub(old) !== null : false;
        if (body !== null) {
            if (old && wasStub) continue;
            const live = siblings
                .filter(sibling => sibling.os && sibling.os !== os)
                .filter(sibling => sibling.functions.some(other => other.key === fn.key && silentStub(other) === null))
                .map(sibling => sibling.adapter);
            if (live.length === 0) continue;
            if (movedStub(filePath, os, fn.key, body)) continue;
            notes.push({ fn, body, os, stubFile: filePath, line: fn.line, live });
            continue;
        }
        if (old && !wasStub) continue;
        for (const sibling of siblings) {
            if (!sibling.os || sibling.os === os) continue;
            const stub = sibling.functions.find(other => other.key === fn.key && silentStub(other) !== null);
            if (!stub) continue;
            notes.push({ fn: stub, body: silentStub(stub), os: sibling.os, stubFile: stub.file, line: stub.line, live: [location.adapter] });
        }
    }
    return notes.map(note => ({
        ...note,
        callers: note.fn.method ? [] : sharedCallers(filePath, location.platformDir, note.fn.name),
    }));
}

function describe(notes) {
    const lines = notes.slice(0, 6).map(note => {
        const where = `${relative(note.stubFile)}:${note.line}`;
        const callers = note.callers.length
            ? ` Callers that get no effect and no error there: ${note.callers.slice(0, 3).join(', ')}${note.callers.length > 3 ? ', ...' : ''}.`
            : '';
        return `- ${note.fn.key} returns \`${note.body}\` on ${WATCHED[note.os]} (${where}) while ${note.live.join(', ')} implements it.${callers}`;
    });
    if (notes.length > 6) lines.push(`- and ${notes.length - 6} more.`);
    return `One-OS behavior: this edit leaves a shared platform function doing real work on one OS and silently nothing on the other.\n${lines.join('\n')}\n` +
        `[qol-arch-cross-platform] rule 9: the stub is right only when that OS has no such concept; otherwise it needs an implementation or a typed Err the caller sees (rule 4).`;
}

module.exports = { findOneOsStubs, describe, rustFunctions, silentStub };
