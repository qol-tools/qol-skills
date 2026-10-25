'use strict';

const IDENT_CHAR = /[A-Za-z0-9_]/;
const ESCAPES = { n: '\n', t: '\t', r: '\r', 0: '\0', '\\': '\\', '"': '"', "'": "'" };
const TEST_FILE = /(^|[\\/])(tests?|benches|examples)[\\/]|(^|[\\/_])tests?\.rs$/;

function blankOut(text) {
    return text.replace(/[^\n]/g, ' ');
}

function decodeString(raw) {
    return raw.replace(/\\(u\{[0-9A-Fa-f]+\}|x[0-9A-Fa-f]{2}|\r?\n\s*|.)/g, (_, escape) => {
        if (escape.startsWith('u{')) return String.fromCodePoint(parseInt(escape.slice(2, -1), 16));
        if (escape.startsWith('x')) return String.fromCharCode(parseInt(escape.slice(1), 16));
        if (escape.startsWith('\n') || escape.startsWith('\r')) return '';
        return ESCAPES[escape] ?? escape;
    });
}

function lexRust(src) {
    const clean = [];
    const skeleton = [];
    const strings = [];
    let last = 0;
    let i = 0;
    const flush = end => {
        if (end > last) {
            const code = src.slice(last, end);
            clean.push(code);
            skeleton.push(code);
        }
    };
    const blank = (start, end) => {
        const text = blankOut(src.slice(start, end));
        clean.push(text);
        skeleton.push(text);
        i = last = end;
    };
    const literal = (start, open, close, end, value) => {
        clean.push(src.slice(start, end));
        skeleton.push(src.slice(start, open) + blankOut(src.slice(open, close)) + src.slice(close, end));
        strings.push({ value, start, end });
        i = last = end;
    };
    while (i < src.length) {
        const c = src[i];
        const next = src[i + 1];
        if (c === '/' && next === '/') {
            flush(i);
            const end = src.indexOf('\n', i);
            blank(i, end < 0 ? src.length : end);
            continue;
        }
        if (c === '/' && next === '*') {
            flush(i);
            let depth = 0;
            let j = i;
            while (j < src.length) {
                if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2; continue; }
                if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2; if (depth === 0) break; continue; }
                j++;
            }
            blank(i, Math.min(j, src.length));
            continue;
        }
        const prev = i > 0 ? src[i - 1] : ' ';
        if ((c === 'r' || c === 'b' || c === 'c') && !IDENT_CHAR.test(prev)) {
            const raw = /^(?:b|c)?r(#*)"/.exec(src.slice(i, i + 260));
            if (raw) {
                flush(i);
                const open = i + raw[0].length;
                const terminator = `"${raw[1]}`;
                const found = src.indexOf(terminator, open);
                const close = found < 0 ? src.length : found;
                literal(i, open, close, Math.min(src.length, close + terminator.length), src.slice(open, close));
                continue;
            }
        }
        const prefixed = (c === 'b' || c === 'c') && next === '"' && !IDENT_CHAR.test(prev);
        if (c === '"' || prefixed) {
            flush(i);
            const open = i + (prefixed ? 2 : 1);
            let j = open;
            while (j < src.length && src[j] !== '"') j += src[j] === '\\' ? 2 : 1;
            const close = Math.min(j, src.length);
            literal(i, open, close, Math.min(src.length, close + 1), decodeString(src.slice(open, close)));
            continue;
        }
        if (c === "'") {
            let close = -1;
            if (next === '\\') close = src.indexOf("'", i + 3);
            else {
                const point = String.fromCodePoint(src.codePointAt(i + 1) ?? 32);
                if (src[i + 1 + point.length] === "'") close = i + 1 + point.length;
            }
            if (close > 0 && close - i < 16) {
                flush(i);
                blank(i, close + 1);
                continue;
            }
        }
        i++;
    }
    flush(src.length);
    return { clean: clean.join(''), skeleton: skeleton.join(''), strings };
}

const OPENERS = { '(': ')', '[': ']', '{': '}', '<': '>' };

function matchForward(text, open) {
    const angles = text[open] === '<';
    const stack = [OPENERS[text[open]]];
    for (let i = open + 1; i < text.length; i++) {
        const c = text[i];
        if ((c === '-' || c === '=') && text[i + 1] === '>') { i++; continue; }
        if (c === '(' || c === '[' || c === '{' || (angles && c === '<')) {
            stack.push(OPENERS[c]);
            continue;
        }
        if ((c === ')' || c === ']' || c === '}' || (angles && c === '>')) && c === stack[stack.length - 1]) {
            stack.pop();
            if (stack.length === 0) return i;
        }
    }
    return text.length - 1;
}

function splitTop(text) {
    const parts = [];
    let depth = 0;
    let start = 0;
    let quote = false;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (quote) {
            if (c === '\\') i++;
            else if (c === '"') quote = false;
            continue;
        }
        if (c === '"') { quote = true; continue; }
        if ((c === '-' || c === '=') && text[i + 1] === '>') { i++; continue; }
        if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
        else if (c === ')' || c === ']' || c === '}' || c === '>') depth--;
        else if (c === ',' && depth === 0) {
            parts.push([start, i]);
            start = i + 1;
        }
    }
    parts.push([start, text.length]);
    return parts.filter(([from, to]) => text.slice(from, to).trim());
}

function leadingAttributes(skeleton, clean, start, end) {
    const attrs = [];
    let i = start;
    for (;;) {
        while (i < end && /\s/.test(skeleton[i])) i++;
        if (skeleton[i] !== '#' || skeleton[i + 1] !== '[') break;
        const close = matchForward(skeleton, i + 1);
        attrs.push(clean.slice(i, close + 1));
        i = close + 1;
    }
    return { attrs, rest: i };
}

function precedingAttributes(skeleton, clean, at) {
    const attrs = [];
    let i = at - 1;
    for (;;) {
        while (i >= 0 && /\s/.test(skeleton[i])) i--;
        if (skeleton[i] !== ']') break;
        let depth = 0;
        let j = i;
        for (; j >= 0; j--) {
            if (skeleton[j] === ']') depth++;
            else if (skeleton[j] === '[') {
                depth--;
                if (depth === 0) break;
            }
        }
        if (j <= 0 || skeleton[j - 1] !== '#') break;
        attrs.unshift(clean.slice(j - 1, i + 1));
        i = j - 2;
    }
    return attrs;
}

function serdeItems(attrs) {
    const items = [];
    for (const attr of attrs) {
        const match = /^#\s*\[\s*serde\s*\(([\s\S]*)\)\s*\]$/.exec(attr.trim());
        if (match) items.push(...parseItems(match[1]));
    }
    return items;
}

function parseItems(text) {
    const items = [];
    for (const [from, to] of splitTop(text)) {
        const part = text.slice(from, to).trim();
        let match;
        if ((match = /^(\w+)\s*=\s*"((?:[^"\\]|\\.)*)"$/.exec(part))) items.push({ name: match[1], value: decodeString(match[2]) });
        else if ((match = /^(\w+)\s*\(([\s\S]*)\)$/.exec(part))) items.push({ name: match[1], nested: parseItems(match[2]) });
        else if (/^\w+$/.test(part)) items.push({ name: part });
    }
    return items;
}

function itemValue(items, name, side = 'deserialize') {
    const values = [];
    for (const item of items) {
        if (item.name !== name) continue;
        if (item.value !== undefined) values.push(item.value);
        else if (item.nested) {
            const nested = item.nested.find(entry => entry.name === side);
            if (nested?.value !== undefined) values.push(nested.value);
        }
    }
    return values;
}

function hasItem(items, name) {
    return items.some(item => item.name === name);
}

function derivesDeserialize(attrs) {
    return attrs.some(attr => /\bderive\s*\([^)]*\bDeserialize\b/.test(attr));
}

function derivesSerialize(attrs) {
    return attrs.some(attr => /\bderive\s*\([^)]*\bSerialize\b/.test(attr));
}

function splitWords(name) {
    return name.split('_').filter(Boolean);
}

function renameField(name, rule) {
    switch (rule) {
        case 'UPPERCASE':
        case 'SCREAMING_SNAKE_CASE': return name.toUpperCase();
        case 'PascalCase': return splitWords(name).map(word => word[0].toUpperCase() + word.slice(1)).join('');
        case 'camelCase': {
            const pascal = renameField(name, 'PascalCase');
            return pascal[0].toLowerCase() + pascal.slice(1);
        }
        case 'kebab-case': return name.replace(/_/g, '-');
        case 'SCREAMING-KEBAB-CASE': return name.replace(/_/g, '-').toUpperCase();
        default: return name;
    }
}

function renameVariant(name, rule) {
    const snake = () => name.replace(/[A-Z]/g, (c, at) => (at ? '_' : '') + c.toLowerCase());
    switch (rule) {
        case 'lowercase': return name.toLowerCase();
        case 'UPPERCASE': return name.toUpperCase();
        case 'camelCase': return name[0].toLowerCase() + name.slice(1);
        case 'snake_case': return snake();
        case 'SCREAMING_SNAKE_CASE': return snake().toUpperCase();
        case 'kebab-case': return snake().replace(/_/g, '-');
        case 'SCREAMING-KEBAB-CASE': return snake().replace(/_/g, '-').toUpperCase();
        default: return name;
    }
}

function tokenizeType(text) {
    const tokens = [];
    const re = /\s*(->|::|'[A-Za-z_]\w*|[A-Za-z_]\w*|\d+|[<>(),\[\];&=+!*])/y;
    let match;
    while ((match = re.exec(text))) tokens.push(match[1]);
    return tokens;
}

function parseType(text) {
    const tokens = tokenizeType(text);
    let at = 0;
    const peek = () => tokens[at];
    const take = () => tokens[at++];
    function node() {
        while (peek() === '&' || /^'/.test(peek() ?? '') || peek() === 'mut' || peek() === 'dyn' || peek() === 'impl') {
            if (peek() === 'dyn' || peek() === 'impl') {
                take();
                skipBounds();
                return { any: true };
            }
            take();
        }
        if (peek() === '(') {
            take();
            const items = [];
            while (peek() && peek() !== ')') {
                items.push(node());
                if (peek() === ',') take();
            }
            take();
            return items.length === 0 ? { any: true } : { tuple: items };
        }
        if (peek() === '[') {
            take();
            const item = node();
            if (peek() === ';') {
                while (peek() && peek() !== ']') take();
            }
            take();
            return { seq: item };
        }
        if (peek() === 'fn') {
            skipBounds();
            return { any: true };
        }
        let name = '';
        let args = [];
        if (peek() === '::') take();
        for (;;) {
            const segment = take();
            if (!segment || !/^[A-Za-z_]/.test(segment)) return { any: true };
            name = segment;
            args = [];
            if (peek() === '<') {
                take();
                while (peek() && peek() !== '>') {
                    if (/^'/.test(peek())) {
                        take();
                    } else if (/^[A-Za-z_]\w*$/.test(peek()) && tokens[at + 1] === '=') {
                        take();
                        take();
                        args.push(node());
                    } else {
                        args.push(node());
                    }
                    if (peek() === ',') take();
                }
                take();
            }
            if (peek() !== '::') break;
            take();
        }
        return { name, args };
    }
    function skipBounds() {
        let depth = 0;
        while (peek()) {
            const token = peek();
            if (token === '<' || token === '(') depth++;
            if (token === '>' || token === ')') {
                if (depth === 0) return;
                depth--;
            }
            if (token === ',' && depth === 0) return;
            take();
        }
    }
    return node();
}

function blockKinds(skeleton) {
    const events = [];
    let headerStart = 0;
    for (let i = 0; i < skeleton.length; i++) {
        const c = skeleton[i];
        if (c === '{') {
            const kind = /\b(impl|trait|fn|mod|struct|enum|union|macro_rules)\b/.exec(skeleton.slice(headerStart, i));
            events.push([i, kind ? kind[1] : 'block']);
            headerStart = i + 1;
        } else if (c === '}') {
            events.push([i, null]);
            headerStart = i + 1;
        } else if (c === ';') {
            headerStart = i + 1;
        }
    }
    const stack = [];
    let next = 0;
    return position => {
        while (next < events.length && events[next][0] < position) {
            const [, kind] = events[next++];
            if (kind) stack.push(kind);
            else stack.pop();
        }
        return stack;
    };
}

function testSpans(skeleton) {
    const spans = [];
    const re = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]/g;
    let match;
    while ((match = re.exec(skeleton))) {
        const rest = skeleton.slice(re.lastIndex);
        const item = /^\s*(?:#\s*\[[^\]]*\]\s*)*(?:pub(?:\s*\([^)]*\))?\s+)?(?:mod|fn|impl|const|static|use|struct|enum)\b[^{;]*([{;])/.exec(rest);
        if (!item) continue;
        const at = re.lastIndex + item[0].length - 1;
        const end = item[1] === '{' ? matchForward(skeleton, at) : at;
        spans.push([match.index, end + 1]);
        re.lastIndex = end + 1;
    }
    return spans;
}

function production(file, content) {
    if (TEST_FILE.test(file)) return null;
    const lexed = lexRust(content);
    const spans = testSpans(lexed.skeleton);
    if (spans.length === 0) return lexed;
    let skeleton = lexed.skeleton;
    let clean = lexed.clean;
    for (const [start, end] of spans) {
        skeleton = skeleton.slice(0, start) + blankOut(skeleton.slice(start, end)) + skeleton.slice(end);
        clean = clean.slice(0, start) + blankOut(clean.slice(start, end)) + clean.slice(end);
    }
    const strings = lexed.strings.filter(string => !spans.some(([start, end]) => string.start >= start && string.start < end));
    return { clean, skeleton, strings };
}

function parseFields(skeleton, clean, from, to, file) {
    const fields = [];
    const body = skeleton.slice(from, to);
    for (const [start, end] of splitTop(body)) {
        const { attrs, rest } = leadingAttributes(skeleton, clean, from + start, from + end);
        const text = clean.slice(rest, from + end).trim();
        const match = /^(?:pub(?:\s*\([^)]*\))?\s+)?(?:r#)?([A-Za-z_]\w*)\s*:\s*([\s\S]+)$/.exec(text);
        if (!match) continue;
        fields.push(fieldFrom(match[1], parseType(match[2]), serdeItems(attrs), file));
    }
    return fields;
}

function fieldFrom(rust, type, items, file) {
    return {
        rust,
        type,
        file,
        rename: itemValue(items, 'rename')[0],
        aliases: itemValue(items, 'alias'),
        defaulted: hasItem(items, 'default'),
        flatten: hasItem(items, 'flatten'),
        skip: hasItem(items, 'skip') || hasItem(items, 'skip_deserializing'),
        custom: hasItem(items, 'deserialize_with') || hasItem(items, 'with'),
    };
}

function parseTupleItems(skeleton, clean, from, to) {
    const items = [];
    const body = skeleton.slice(from, to);
    for (const [start, end] of splitTop(body)) {
        const { rest } = leadingAttributes(skeleton, clean, from + start, from + end);
        const text = clean.slice(rest, from + end).trim().replace(/^pub(?:\s*\([^)]*\))?\s+/, '');
        items.push(parseType(text));
    }
    return items;
}

function parseVariants(skeleton, clean, from, to, file) {
    const variants = [];
    const body = skeleton.slice(from, to);
    for (const [start, end] of splitTop(body)) {
        const { attrs, rest } = leadingAttributes(skeleton, clean, from + start, from + end);
        const head = /^\s*([A-Za-z_]\w*)\s*/.exec(skeleton.slice(rest, from + end));
        if (!head) continue;
        const items = serdeItems(attrs);
        const after = rest + head[0].length;
        const variant = {
            rust: head[1],
            rename: itemValue(items, 'rename')[0],
            aliases: itemValue(items, 'alias'),
            other: hasItem(items, 'other'),
            skip: hasItem(items, 'skip') || hasItem(items, 'skip_deserializing'),
            untagged: hasItem(items, 'untagged'),
            renameAll: itemValue(items, 'rename_all')[0],
            shape: 'unit',
        };
        if (skeleton[after] === '{') {
            const close = matchForward(skeleton, after);
            variant.shape = 'struct';
            variant.fields = parseFields(skeleton, clean, after + 1, close, file);
        } else if (skeleton[after] === '(') {
            const close = matchForward(skeleton, after);
            const types = parseTupleItems(skeleton, clean, after + 1, close);
            variant.shape = types.length === 1 ? 'newtype' : 'tuple';
            variant.types = types;
        }
        variants.push(variant);
    }
    return variants;
}

function fileItems(file, lexed) {
    const into = { defs: [], custom: [] };
    if (!lexed) return into;
    const { skeleton, clean } = lexed;
    const kindsAt = blockKinds(skeleton);
    for (const match of skeleton.matchAll(/\bimpl\s*<\s*'de\s*>\s*(?:[\w:]*::)?Deserialize\s*<\s*'de\s*>\s*for\s+([A-Za-z_]\w*)/g)) {
        into.custom.push(match[1]);
    }
    for (const match of skeleton.matchAll(/(?<![\w])(struct|enum|type)\s+([A-Za-z_]\w*)/g)) {
        const kinds = kindsAt(match.index);
        if (kinds.some(kind => kind !== 'mod')) continue;
        const [, keyword, name] = match;
        let start = match.index;
        const visibility = /(?:pub(?:\s*\([^)]*\))?\s+)$/.exec(skeleton.slice(Math.max(0, start - 40), start));
        if (visibility) start -= visibility[0].length;
        const attrs = precedingAttributes(skeleton, clean, start);
        let at = match.index + match[0].length;
        while (/\s/.test(skeleton[at] ?? '')) at++;
        if (skeleton[at] === '<') at = matchForward(skeleton, at) + 1;
        if (keyword === 'type') {
            const eq = skeleton.indexOf('=', at);
            const end = skeleton.indexOf(';', at);
            if (eq < 0 || end < 0 || eq > end) continue;
            into.defs.push({ kind: 'alias', name, file, target: parseType(clean.slice(eq + 1, end)) });
            continue;
        }
        const items = serdeItems(attrs);
        const container = {
            name,
            file,
            deserialize: derivesDeserialize(attrs),
            serialize: derivesSerialize(attrs),
            renameAll: itemValue(items, 'rename_all')[0],
            renameAllFields: itemValue(items, 'rename_all_fields')[0],
            denyUnknown: hasItem(items, 'deny_unknown_fields'),
            defaulted: hasItem(items, 'default'),
            transparent: hasItem(items, 'transparent'),
            from: itemValue(items, 'from')[0] ?? itemValue(items, 'try_from')[0],
            tag: itemValue(items, 'tag')[0],
            content: itemValue(items, 'content')[0],
            untagged: hasItem(items, 'untagged'),
        };
        const where = /^\s*where\b[^{;(]*/.exec(skeleton.slice(at));
        if (where) at += where[0].length;
        while (/\s/.test(skeleton[at] ?? '')) at++;
        if (keyword === 'struct') {
            if (skeleton[at] === '{') {
                const close = matchForward(skeleton, at);
                into.defs.push({ ...container, kind: 'struct', fields: parseFields(skeleton, clean, at + 1, close, file) });
            } else if (skeleton[at] === '(') {
                const close = matchForward(skeleton, at);
                const types = parseTupleItems(skeleton, clean, at + 1, close);
                into.defs.push({ ...container, kind: types.length === 1 ? 'newtype' : 'tuple', types });
            } else {
                into.defs.push({ ...container, kind: 'unit' });
            }
        } else if (skeleton[at] === '{') {
            const close = matchForward(skeleton, at);
            into.defs.push({ ...container, kind: 'enum', variants: parseVariants(skeleton, clean, at + 1, close, file) });
        }
    }
    return into;
}

function schemaOf(itemsList) {
    const schema = { types: new Map(), custom: new Set() };
    for (const items of itemsList) {
        for (const name of items.custom) schema.custom.add(name);
        for (const def of items.defs) {
            if (!schema.types.has(def.name)) schema.types.set(def.name, []);
            schema.types.get(def.name).push(def);
        }
    }
    return schema;
}

function serdeSchema(files) {
    return schemaOf(files.map(({ file, content, lexed }) => fileItems(file, lexed ?? production(file, content))));
}

function crateOf(file) {
    const match = /^(.*?)[\\/]src[\\/]/.exec(file);
    return match ? match[1] : '';
}

function lookup(schema, name, fromFile) {
    if (schema.custom.has(name)) return null;
    const candidates = schema.types.get(name);
    if (!candidates?.length) return null;
    const usable = candidates.filter(def => def.kind === 'alias' || def.deserialize);
    const pool = usable.length ? usable : candidates;
    if (pool.length === 1) return pool[0];
    const sameCrate = pool.filter(def => crateOf(def.file) === crateOf(fromFile ?? ''));
    return sameCrate.length === 1 ? sameCrate[0] : null;
}

const STRINGS = new Set(['String', 'str', 'PathBuf', 'Path', 'OsString', 'char', 'SmolStr', 'CompactString', 'Utf8PathBuf']);
const INTEGERS = /^(?:u8|u16|u32|u64|u128|usize|i8|i16|i32|i64|i128|isize|NonZero\w+)$/;
const FLOATS = new Set(['f32', 'f64']);
const SEQUENCES = new Set(['Vec', 'VecDeque', 'BTreeSet', 'HashSet', 'IndexSet', 'LinkedList', 'BinaryHeap', 'SmallVec']);
const MAPS = new Set(['HashMap', 'BTreeMap', 'IndexMap']);
const WRAPPERS = new Set(['Box', 'Arc', 'Rc', 'Cow', 'Cell', 'RefCell']);
const ANY = new Set(['Value', 'Table', 'Map']);

function shapeOf(schema, type, fromFile, seen = new Set()) {
    if (!type || type.any) return { kind: 'any' };
    if (type.tuple) return { kind: 'tuple', items: type.tuple, fromFile };
    if (type.seq) return { kind: 'seq', item: type.seq, fromFile };
    const { name, args } = type;
    if (STRINGS.has(name)) return { kind: 'string' };
    if (name === 'bool') return { kind: 'bool' };
    if (INTEGERS.test(name)) return { kind: 'integer' };
    if (FLOATS.has(name)) return { kind: 'float' };
    if (name === 'Option') return { kind: 'option', item: args[0], fromFile };
    if (SEQUENCES.has(name)) {
        const item = args[0]?.seq ?? args[0];
        return { kind: 'seq', item, fromFile };
    }
    if (MAPS.has(name)) return { kind: 'map', key: args[0], value: args[1], fromFile };
    if (WRAPPERS.has(name)) {
        const inner = args[args.length - 1];
        if (name === 'Cow' && inner?.name === 'str') return { kind: 'string' };
        return shapeOf(schema, inner, fromFile, seen);
    }
    if (ANY.has(name) && !schema.types.has(name)) return { kind: 'any' };
    const def = lookup(schema, name, fromFile);
    if (!def || seen.has(def)) return { kind: 'any' };
    if (def.kind === 'alias') return shapeOf(schema, def.target, def.file, new Set([...seen, def]));
    if (!def.deserialize) return { kind: 'any' };
    if (def.from) return shapeOf(schema, parseType(def.from), def.file, new Set([...seen, def]));
    if (def.transparent || def.kind === 'newtype') {
        const inner = def.kind === 'newtype' ? def.types[0] : def.fields?.find(field => !field.skip)?.type;
        return shapeOf(schema, inner, def.file, new Set([...seen, def]));
    }
    if (def.kind === 'tuple') return { kind: 'tuple', items: def.types, fromFile: def.file };
    if (def.kind === 'unit') return { kind: 'any' };
    return { kind: def.kind, def };
}

function wireName(field, renameAll) {
    return field.rename ?? renameField(field.rust, renameAll);
}

function variantWire(variant, renameAll) {
    return variant.rename ?? renameVariant(variant.rust, renameAll);
}

function isTable(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describe(value) {
    if (Array.isArray(value)) return 'an array';
    if (isTable(value)) return 'a table';
    if (typeof value === 'string') return `the string ${JSON.stringify(value)}`;
    if (typeof value === 'boolean') return `the boolean ${value}`;
    return `the number ${String(value)}`;
}

function structMembers(schema, def, fields = def.fields, renameAll = def.renameAll, defaulted = def.defaulted, seen = new Set()) {
    const members = { byWire: new Map(), required: [], catchAll: [] };
    if (seen.has(def)) return members;
    seen.add(def);
    for (const field of fields) {
        if (field.skip) continue;
        if (field.flatten) {
            const shape = shapeOf(schema, field.type, field.file);
            const target = shape.kind === 'option' ? shapeOf(schema, shape.item, shape.fromFile) : shape;
            if (target.kind === 'struct') {
                const inner = structMembers(schema, target.def, target.def.fields, target.def.renameAll, target.def.defaulted || shape.kind === 'option', seen);
                for (const [wire, entry] of inner.byWire) members.byWire.set(wire, entry);
                members.required.push(...inner.required);
                members.catchAll.push(...inner.catchAll);
            } else {
                members.catchAll.push({ owner: def, field });
            }
            continue;
        }
        const wire = wireName(field, renameAll);
        const entry = { owner: def, field, wire };
        members.byWire.set(wire, entry);
        for (const alias of field.aliases) members.byWire.set(alias, entry);
        const optional = defaulted || field.defaulted || shapeOf(schema, field.type, field.file).kind === 'option';
        if (!optional) members.required.push(entry);
    }
    return members;
}

function checkValue(schema, value, type, fromFile, at, out) {
    const shape = shapeOf(schema, type, fromFile);
    checkShape(schema, value, shape, at, out);
}

function checkShape(schema, value, shape, at, out) {
    const wrong = expected => out.problems.push({ kind: 'type', ...at, expected, actual: describe(value) });
    switch (shape.kind) {
        case 'any': return;
        case 'string': if (typeof value !== 'string') wrong('a string'); return;
        case 'bool': if (typeof value !== 'boolean') wrong('true or false'); return;
        case 'integer': if (!(typeof value === 'bigint' || Number.isInteger(value))) wrong('an integer'); return;
        case 'float': if (!(typeof value === 'bigint' || typeof value === 'number')) wrong('a number'); return;
        case 'option': return checkValue(schema, value, shape.item, shape.fromFile, at, out);
        case 'seq':
            if (!Array.isArray(value)) return wrong('an array');
            value.forEach((item, index) => checkValue(schema, item, shape.item, shape.fromFile, { ...at, path: `${at.path}[${index}]` }, out));
            return;
        case 'tuple':
            if (!Array.isArray(value) || value.length !== shape.items.length) return wrong(`an array of ${shape.items.length}`);
            value.forEach((item, index) => checkValue(schema, item, shape.items[index], shape.fromFile, { ...at, path: `${at.path}[${index}]` }, out));
            return;
        case 'map': {
            if (!isTable(value)) return wrong('a table');
            const keyShape = shapeOf(schema, shape.key, shape.fromFile);
            for (const key of Object.keys(value)) {
                const path = at.path ? `${at.path}.${key}` : key;
                if (keyShape.kind === 'enum') {
                    const wires = unitWires(keyShape.def);
                    if (!wires.includes(key)) out.problems.push({ kind: 'variant', table: value, key, path, actual: key, allowed: wires });
                }
                checkValue(schema, value[key], shape.value, shape.fromFile, { table: value, key, path }, out);
            }
            return;
        }
        case 'struct': return checkStruct(schema, value, shape.def, shape.def.fields, shape.def.renameAll, shape.def.defaulted, at, out, new Set());
        case 'enum': return checkEnum(schema, value, shape.def, at, out);
        default: return;
    }
}

function checkStruct(schema, value, def, fields, renameAll, defaulted, at, out, ignore) {
    if (!isTable(value)) {
        out.problems.push({ kind: 'type', ...at, expected: 'a table', actual: describe(value) });
        return;
    }
    const members = structMembers(schema, def, fields, renameAll, defaulted);
    const present = new Set();
    for (const key of Object.keys(value)) {
        if (ignore.has(key)) continue;
        const path = at.path ? `${at.path}.${key}` : key;
        const entry = members.byWire.get(key);
        if (entry) {
            present.add(entry);
            out.used.push({ table: value, key, path, owner: entry.owner, field: entry.field });
            checkValue(schema, value[key], entry.field.type, entry.field.file, { table: value, key, path }, out);
            continue;
        }
        if (members.catchAll.length) {
            const { owner, field } = members.catchAll[0];
            out.used.push({ table: value, key, path, owner, field, swallowed: true });
            continue;
        }
        out.problems.push({ kind: 'unknown', table: value, key, path, owner: def, strict: def.denyUnknown, known: [...members.byWire.keys()] });
    }
    for (const entry of members.required) {
        if (!present.has(entry)) out.problems.push({ kind: 'missing', ...at, missing: entry.wire, owner: def });
    }
}

function unitWires(def) {
    return def.variants.filter(variant => variant.shape === 'unit' && !variant.skip && !variant.other)
        .flatMap(variant => [variantWire(variant, def.renameAll), ...variant.aliases]);
}

function findVariant(def, tag) {
    for (const variant of def.variants) {
        if (variant.skip) continue;
        if (variantWire(variant, def.renameAll) === tag || variant.aliases.includes(tag)) return variant;
    }
    return def.variants.find(variant => variant.other) ?? null;
}

function checkVariantContent(schema, value, def, variant, at, out, ignore) {
    if (variant.shape === 'struct') {
        return checkStruct(schema, value, def, variant.fields, variant.renameAll ?? def.renameAllFields, false, at, out, ignore);
    }
    if (variant.shape === 'newtype') {
        const shape = shapeOf(schema, variant.types[0], def.file);
        if (shape.kind === 'struct' && ignore.size) {
            return checkStruct(schema, value, shape.def, shape.def.fields, shape.def.renameAll, shape.def.defaulted, at, out, ignore);
        }
        return checkShape(schema, value, shape, at, out);
    }
    if (variant.shape === 'tuple') return checkShape(schema, value, { kind: 'tuple', items: variant.types, fromFile: def.file }, at, out);
    if (isTable(value)) {
        for (const key of Object.keys(value)) {
            if (ignore.has(key)) continue;
            out.problems.push({ kind: 'unknown', table: value, key, path: at.path ? `${at.path}.${key}` : key, owner: def, strict: false, known: [] });
        }
    }
}

function checkEnum(schema, value, def, at, out) {
    const allowed = def.variants.filter(variant => !variant.skip).map(variant => variantWire(variant, def.renameAll));
    if (def.untagged) {
        for (const variant of def.variants) {
            if (variant.shape === 'unit' || variant.skip) continue;
            const trial = { problems: [], used: [] };
            checkVariantContent(schema, value, def, variant, at, trial, new Set());
            if (trial.problems.length === 0) {
                out.used.push(...trial.used);
                return;
            }
        }
        out.problems.push({ kind: 'type', ...at, expected: `one of the forms of ${def.name}`, actual: describe(value) });
        return;
    }
    if (def.tag) {
        if (!isTable(value)) {
            out.problems.push({ kind: 'type', ...at, expected: `a table with ${def.tag} = ${allowed.join(' | ')}`, actual: describe(value) });
            return;
        }
        const tag = value[def.tag];
        const variant = typeof tag === 'string' ? findVariant(def, tag) : null;
        if (!variant) {
            out.problems.push({ kind: 'variant', table: value, key: def.tag, path: at.path ? `${at.path}.${def.tag}` : def.tag, actual: tag, allowed });
            return;
        }
        if (def.content) return checkVariantContent(schema, value[def.content], def, variant, { table: value, key: def.content, path: `${at.path}.${def.content}` }, out, new Set());
        return checkVariantContent(schema, value, def, variant, at, out, new Set([def.tag]));
    }
    if (typeof value === 'string') {
        const variant = findVariant(def, value);
        if (!variant || (variant.shape !== 'unit' && !variant.other)) {
            out.problems.push({ kind: 'variant', ...at, actual: value, allowed: unitWires(def) });
        }
        return;
    }
    if (isTable(value) && Object.keys(value).length === 1) {
        const [tag] = Object.keys(value);
        const variant = findVariant(def, tag);
        if (!variant) {
            out.problems.push({ kind: 'variant', table: value, key: tag, path: at.path ? `${at.path}.${tag}` : tag, actual: tag, allowed });
            return;
        }
        return checkVariantContent(schema, value[tag], def, variant, { table: value, key: tag, path: at.path ? `${at.path}.${tag}` : tag }, out, new Set());
    }
    out.problems.push({ kind: 'type', ...at, expected: `one of ${allowed.join(', ')}`, actual: describe(value) });
}

function checkDocument(schema, rootName, value) {
    const out = { problems: [], used: [] };
    const shape = shapeOf(schema, { name: rootName, args: [] });
    if (shape.kind !== 'struct') return null;
    const { def } = shape;
    checkStruct(schema, value, def, def.fields, def.renameAll, def.defaulted, { table: null, key: null, path: '' }, out, new Set());
    return out;
}

function fieldReads(files) {
    const reads = new Set();
    for (const { file, content, lexed: given } of files) {
        const lexed = given ?? production(file, content);
        if (!lexed) continue;
        const { skeleton } = lexed;
        for (const match of skeleton.matchAll(/\.\s*(?:r#)?([a-z_][a-z0-9_]*)\b(?!\s*(?:\(|::|!(?!=)))/g)) reads.add(match[1]);
        for (const match of skeleton.matchAll(/\b(?:[A-Z]\w*|Self)\s*\{/g)) {
            const open = match.index + match[0].length - 1;
            const before = skeleton.slice(Math.max(0, match.index - 40), match.index);
            if (/\b(?:struct|enum|union|impl|trait|for)\s+$/.test(before) || /\b(?:struct|enum|union|impl|trait)\s+[\w<>, ]*$/.test(before)) continue;
            const close = matchForward(skeleton, open);
            const body = skeleton.slice(open + 1, close);
            let depth = 0;
            let start = 0;
            for (let i = 0; i <= body.length; i++) {
                const c = body[i];
                if (c === '{' || c === '(' || c === '[') depth++;
                else if (c === '}' || c === ')' || c === ']') depth--;
                if ((c === ',' || i === body.length) && depth === 0) {
                    const head = /^\s*(?:ref\s+)?(?:mut\s+)?(?:r#)?([a-z_][a-z0-9_]*)\s*(?::|$)/.exec(body.slice(start, i));
                    if (head) reads.add(head[1]);
                    start = i + 1;
                }
            }
        }
    }
    return reads;
}

module.exports = {
    lexRust,
    production,
    parseType,
    fileItems,
    schemaOf,
    serdeSchema,
    lookup,
    matchForward,
    shapeOf,
    structMembers,
    checkDocument,
    fieldReads,
    variantWire,
    TEST_FILE,
};
