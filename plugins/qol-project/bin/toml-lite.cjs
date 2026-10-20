'use strict';

class TomlError extends Error {
    constructor(message, line) {
        super(`${message} (line ${line})`);
        this.line = line;
    }
}

const BARE_KEY = /[A-Za-z0-9_-]/;
const ESCAPES = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', e: '\x1b', '"': '"', '\\': '\\' };

function parse(text) {
    const lines = new WeakMap();
    let pos = 0;
    let line = 1;
    const root = {};
    lines.set(root, { line: 1, keys: {} });
    const defined = new WeakSet();
    const implicit = new WeakSet();
    const inline = new WeakSet();
    const tableArrays = new WeakSet();
    let current = root;

    const fail = message => { throw new TomlError(message, line); };
    const peek = (offset = 0) => text[pos + offset];
    const advance = count => {
        for (let i = 0; i < count; i++) {
            if (text[pos] === '\n') line++;
            pos++;
        }
    };
    const meta = table => {
        if (!lines.has(table)) lines.set(table, { line, keys: {} });
        return lines.get(table);
    };

    function skipSpace() {
        while (peek() === ' ' || peek() === '\t') pos++;
    }

    function skipComment() {
        if (peek() !== '#') return;
        while (pos < text.length && peek() !== '\n') pos++;
    }

    function skipBlank() {
        for (;;) {
            skipSpace();
            skipComment();
            if (peek() === '\n') advance(1);
            else if (peek() === '\r' && peek(1) === '\n') advance(2);
            else return;
        }
    }

    function endOfLine() {
        skipSpace();
        skipComment();
        if (pos >= text.length) return;
        if (peek() === '\n') return advance(1);
        if (peek() === '\r' && peek(1) === '\n') return advance(2);
        fail(`unexpected ${JSON.stringify(peek())} after a value`);
    }

    function basicString() {
        advance(1);
        let out = '';
        for (;;) {
            const c = peek();
            if (c === undefined || c === '\n') fail('unterminated string');
            if (c === '"') { advance(1); return out; }
            if (c === '\\') { out += escape(); continue; }
            out += c;
            pos++;
        }
    }

    function escape() {
        const c = peek(1);
        if (c in ESCAPES) { advance(2); return ESCAPES[c]; }
        if (c === 'u' || c === 'U') {
            const size = c === 'u' ? 4 : 8;
            const hex = text.slice(pos + 2, pos + 2 + size);
            if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== size) fail('bad unicode escape');
            advance(2 + size);
            return String.fromCodePoint(parseInt(hex, 16));
        }
        if (c === 'x') {
            const hex = text.slice(pos + 2, pos + 4);
            if (!/^[0-9A-Fa-f]{2}$/.test(hex)) fail('bad hex escape');
            advance(4);
            return String.fromCodePoint(parseInt(hex, 16));
        }
        return fail(`bad escape \\${c}`);
    }

    function multilineBasicString() {
        advance(3);
        if (peek() === '\n') advance(1);
        else if (peek() === '\r' && peek(1) === '\n') advance(2);
        let out = '';
        for (;;) {
            if (pos >= text.length) fail('unterminated multi-line string');
            if (text.startsWith('"""', pos)) {
                let quotes = 3;
                while (peek(quotes) === '"' && quotes < 5) quotes++;
                out += '"'.repeat(quotes - 3);
                advance(quotes);
                return out;
            }
            const c = peek();
            if (c === '\\') {
                const rest = /^\\[ \t]*\r?\n/.exec(text.slice(pos, pos + 64));
                if (rest) {
                    advance(rest[0].length);
                    while (/[ \t\r\n]/.test(peek() ?? '')) advance(1);
                    continue;
                }
                out += escape();
                continue;
            }
            out += c;
            advance(1);
        }
    }

    function literalString() {
        advance(1);
        const end = text.indexOf("'", pos);
        const newline = text.indexOf('\n', pos);
        if (end < 0 || (newline >= 0 && newline < end)) fail('unterminated literal string');
        const out = text.slice(pos, end);
        pos = end + 1;
        return out;
    }

    function multilineLiteralString() {
        advance(3);
        if (peek() === '\n') advance(1);
        else if (peek() === '\r' && peek(1) === '\n') advance(2);
        const end = text.indexOf("'''", pos);
        if (end < 0) fail('unterminated multi-line literal string');
        let stop = end;
        while (text[stop + 3] === "'" && stop - end < 2) stop++;
        const out = text.slice(pos, stop);
        advance(stop + 3 - pos);
        return out;
    }

    function key() {
        const parts = [];
        for (;;) {
            skipSpace();
            const c = peek();
            if (c === '"') parts.push(basicString());
            else if (c === "'") parts.push(literalString());
            else {
                const start = pos;
                while (pos < text.length && BARE_KEY.test(peek())) pos++;
                if (pos === start) fail('expected a key');
                parts.push(text.slice(start, pos));
            }
            skipSpace();
            if (peek() !== '.') return parts;
            pos++;
        }
    }

    function value() {
        const c = peek();
        if (text.startsWith('"""', pos)) return multilineBasicString();
        if (c === '"') return basicString();
        if (text.startsWith("'''", pos)) return multilineLiteralString();
        if (c === "'") return literalString();
        if (c === '[') return array();
        if (c === '{') return inlineTable();
        if (text.startsWith('true', pos) && !BARE_KEY.test(peek(4) ?? '')) { pos += 4; return true; }
        if (text.startsWith('false', pos) && !BARE_KEY.test(peek(5) ?? '')) { pos += 5; return false; }
        return scalar();
    }

    function scalar() {
        const match = /^[0-9A-Za-z_+\-.:]+(?:[ T][0-9][0-9:.+\-Z]*)?/.exec(text.slice(pos, pos + 128));
        if (!match) fail(`unexpected ${JSON.stringify(peek())}`);
        let raw = match[0];
        if (/^\d{4}-\d{2}-\d{2}/.test(raw) || /^\d{2}:\d{2}/.test(raw)) {
            pos += raw.length;
            return raw;
        }
        raw = /^[0-9A-Za-z_+\-.]+/.exec(raw)[0];
        pos += raw.length;
        const number = raw.replace(/_/g, '');
        if (/^[+-]?(?:inf|nan)$/.test(number)) {
            if (number.endsWith('nan')) return NaN;
            return number.startsWith('-') ? -Infinity : Infinity;
        }
        if (/^0x[0-9A-Fa-f]+$/.test(number)) return integer(BigInt(number));
        if (/^0o[0-7]+$/.test(number)) return integer(BigInt(number));
        if (/^0b[01]+$/.test(number)) return integer(BigInt(number));
        if (/^[+-]?(?:0|[1-9]\d*)$/.test(number)) return integer(BigInt(number));
        if (/^[+-]?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(number)) return Number(number);
        return fail(`invalid value ${JSON.stringify(raw)}`);
    }

    function integer(big) {
        const small = Number(big);
        return Number.isSafeInteger(small) ? small : big;
    }

    function array() {
        advance(1);
        const out = [];
        for (;;) {
            skipBlank();
            if (peek() === ']') { advance(1); return out; }
            out.push(value());
            skipBlank();
            if (peek() === ',') { advance(1); continue; }
            if (peek() === ']') { advance(1); return out; }
            fail('expected , or ] in an array');
        }
    }

    function inlineTable() {
        advance(1);
        const table = {};
        meta(table);
        inline.add(table);
        skipSpace();
        if (peek() === '}') { advance(1); return table; }
        for (;;) {
            const keyLine = line;
            const parts = key();
            if (peek() !== '=') fail('expected = in an inline table');
            pos++;
            skipSpace();
            assign(table, parts, value(), keyLine, true);
            skipSpace();
            if (peek() === ',') { pos++; continue; }
            if (peek() === '}') { pos++; return table; }
            fail('expected , or } in an inline table');
        }
    }

    function isTable(item) {
        return item !== null && typeof item === 'object' && !Array.isArray(item);
    }

    function assign(table, parts, item, keyLine, insideInline) {
        let target = table;
        for (const part of parts.slice(0, -1)) {
            if (!(part in target)) {
                target[part] = {};
                meta(target).keys[part] = keyLine;
                lines.set(target[part], { line: keyLine, keys: {} });
                if (!insideInline) defined.add(target[part]);
            } else if (!isTable(target[part]) || inline.has(target[part]) || implicit.has(target[part])) {
                fail(`cannot extend ${part} with a dotted key`);
            }
            target = target[part];
        }
        const last = parts[parts.length - 1];
        if (last in target) fail(`duplicate key ${parts.join('.')}`);
        target[last] = item;
        meta(target).keys[last] = keyLine;
    }

    function tableHeader() {
        const isArray = peek(1) === '[';
        advance(isArray ? 2 : 1);
        const headerLine = line;
        const parts = key();
        if (isArray) {
            if (!text.startsWith(']]', pos)) fail('expected ]] after a table array header');
            pos += 2;
        } else {
            if (peek() !== ']') fail('expected ] after a table header');
            pos++;
        }
        endOfLine();
        let target = root;
        for (const part of parts.slice(0, -1)) {
            if (!(part in target)) {
                target[part] = {};
                meta(target).keys[part] = headerLine;
                lines.set(target[part], { line: headerLine, keys: {} });
                implicit.add(target[part]);
            }
            let next = target[part];
            if (Array.isArray(next)) {
                if (!tableArrays.has(next)) fail(`cannot extend the array ${part}`);
                next = next[next.length - 1];
            }
            if (!isTable(next) || inline.has(next)) fail(`${part} is not a table`);
            target = next;
        }
        const last = parts[parts.length - 1];
        if (isArray) {
            if (!(last in target)) {
                target[last] = [];
                tableArrays.add(target[last]);
                meta(target).keys[last] = headerLine;
            }
            const list = target[last];
            if (!Array.isArray(list) || !tableArrays.has(list)) fail(`${parts.join('.')} is not an array of tables`);
            const table = {};
            lines.set(table, { line: headerLine, keys: {} });
            list.push(table);
            return table;
        }
        if (last in target) {
            const existing = target[last];
            if (!isTable(existing) || inline.has(existing) || defined.has(existing)) fail(`duplicate table ${parts.join('.')}`);
            if (!implicit.has(existing)) fail(`duplicate table ${parts.join('.')}`);
            implicit.delete(existing);
            defined.add(existing);
            meta(existing).line = headerLine;
            return existing;
        }
        const table = {};
        target[last] = table;
        meta(target).keys[last] = headerLine;
        lines.set(table, { line: headerLine, keys: {} });
        defined.add(table);
        return table;
    }

    if (text.charCodeAt(0) === 0xfeff) pos = 1;
    for (;;) {
        skipBlank();
        if (pos >= text.length) break;
        if (peek() === '[') {
            current = tableHeader();
            continue;
        }
        const keyLine = line;
        const parts = key();
        if (peek() !== '=') fail('expected = after a key');
        pos++;
        skipSpace();
        assign(current, parts, value(), keyLine, false);
        endOfLine();
    }
    return { value: root, lines };
}

function keyLine(lines, table, name) {
    const entry = lines.get(table);
    if (!entry) return 0;
    return entry.keys[name] ?? entry.line;
}

function tableLine(lines, table) {
    return lines.get(table)?.line ?? 0;
}

module.exports = { parse, keyLine, tableLine, TomlError };
