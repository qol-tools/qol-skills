'use strict';

const TARGETS = ['linux', 'macos', 'windows'];
const FAMILY = { linux: 'unix', macos: 'unix', windows: 'windows' };
const OS_KEYS = new Set(['target_os', 'target_family', 'target_vendor', 'target_env', 'unix', 'windows']);
const UNEVALUATED_OS_KEYS = new Set(['target_vendor', 'target_env']);
const MAX_FREE_ATOMS = 10;
const ALWAYS = Object.freeze({ op: 'all', args: Object.freeze([]) });
const ATTRIBUTE_START = /#(!?)\s*\[\s*(cfg_attr|cfg)\s*\(/g;
const MACRO_START = /(?<![\w$])cfg\s*!\s*\(/g;
const LEADING_ATTRIBUTES = /^(?:\s*#\s*\[[^\]]*\])*/;
const ATTRIBUTE_LINE = /^\s*#\[/;

function parse(expression) {
    let index = 0;
    const skipSpace = () => {
        while (index < expression.length && /\s/.test(expression[index])) index++;
    };
    const node = () => {
        skipSpace();
        const word = /^[A-Za-z_]\w*/.exec(expression.slice(index));
        if (!word) throw new Error('cfg');
        index += word[0].length;
        skipSpace();
        if (expression[index] === '(') {
            if (!['all', 'any', 'not'].includes(word[0])) throw new Error('cfg');
            index++;
            const args = [];
            skipSpace();
            while (expression[index] !== ')') {
                args.push(node());
                skipSpace();
                if (expression[index] === ',') index++;
                else if (expression[index] !== ')') throw new Error('cfg');
                skipSpace();
                if (index >= expression.length) throw new Error('cfg');
            }
            index++;
            if (word[0] === 'not' && args.length !== 1) throw new Error('cfg');
            return { op: word[0], args };
        }
        if (expression[index] === '=') {
            index++;
            skipSpace();
            const literal = /^"((?:\\.|[^"\\])*)"/.exec(expression.slice(index));
            if (!literal) throw new Error('cfg');
            index += literal[0].length;
            return { key: word[0], value: literal[1] };
        }
        return { key: word[0], value: null };
    };
    try {
        const tree = node();
        skipSpace();
        return index === expression.length ? tree : null;
    } catch {
        return null;
    }
}

function atoms(tree, found = []) {
    if (tree.op) {
        for (const arg of tree.args) atoms(arg, found);
    } else {
        found.push(tree);
    }
    return found;
}

function isOsAtom(atom) {
    return OS_KEYS.has(atom.key);
}

function atomName(atom) {
    return atom.value === null ? atom.key : `${atom.key}="${atom.value}"`;
}

function osValue(atom, target) {
    if (atom.key === 'target_os') return atom.value === target;
    if (atom.key === 'target_family') return atom.value === FAMILY[target];
    if (atom.key === 'unix') return FAMILY[target] === 'unix';
    if (atom.key === 'windows') return target === 'windows';
    return null;
}

function holds(tree, target) {
    if (tree.op === 'not') {
        const value = holds(tree.args[0], target);
        return value === null ? null : !value;
    }
    if (tree.op) {
        const values = tree.args.map(arg => holds(arg, target));
        if (values.includes(null)) return null;
        return tree.op === 'all' ? values.every(Boolean) : values.some(Boolean);
    }
    return osValue(tree, target);
}

function kleene(tree, value) {
    if (tree.op === 'not') {
        const inner = kleene(tree.args[0], value);
        return inner === null ? null : !inner;
    }
    if (tree.op) {
        const decisive = tree.op === 'any';
        const values = tree.args.map(arg => kleene(arg, value));
        if (values.includes(decisive)) return decisive;
        return values.includes(null) ? null : !decisive;
    }
    return value(tree);
}

function evaluate(tree, target, settings) {
    if (tree.op === 'all') return tree.args.every(arg => evaluate(arg, target, settings));
    if (tree.op === 'any') return tree.args.some(arg => evaluate(arg, target, settings));
    if (tree.op === 'not') return !evaluate(tree.args[0], target, settings);
    const value = osValue(tree, target);
    return value === null ? settings.get(atomName(tree)) : value;
}

function dependsOnOs(tree) {
    const all = atoms(tree);
    if (all.some(atom => UNEVALUATED_OS_KEYS.has(atom.key))) return true;
    const free = [...new Set(all.filter(atom => !isOsAtom(atom)).map(atomName))];
    if (free.length > MAX_FREE_ATOMS) return all.some(isOsAtom);
    for (let mask = 0; mask < 1 << free.length; mask++) {
        const settings = new Map(free.map((name, bit) => [name, Boolean(mask & (1 << bit))]));
        const values = TARGETS.map(target => evaluate(tree, target, settings));
        if (values.some(value => value !== values[0])) return true;
    }
    return false;
}

function tripleTree(triple) {
    const parts = triple.split('-');
    let os = parts[2] || triple;
    if (parts.includes('linux')) os = 'linux';
    else if (parts.includes('darwin')) os = 'macos';
    else if (parts.includes('windows')) os = 'windows';
    return { op: 'all', args: [{ key: 'target_os', value: os }, { key: 'target_arch', value: parts[0] }] };
}

function targetTree(key) {
    const cfg = /^\s*cfg\s*\(([\s\S]*)\)\s*$/.exec(key);
    return cfg ? parse(cfg[1]) : tripleTree(key.trim());
}

function closing(text, open) {
    let depth = 0;
    for (let index = open; index < text.length; index++) {
        if (text[index] === '(') depth++;
        else if (text[index] === ')' && --depth === 0) return index;
    }
    return -1;
}

function firstTopLevelComma(text, from, to) {
    let depth = 0;
    for (let index = from; index < to; index++) {
        if (text[index] === '(') depth++;
        else if (text[index] === ')') depth--;
        else if (text[index] === ',' && depth === 0) return index;
    }
    return -1;
}

function lineStarts(text) {
    const starts = [0];
    for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) starts.push(index + 1);
    return starts;
}

function lineAt(starts, index) {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
        const middle = (low + high + 1) >> 1;
        if (starts[middle] <= index) low = middle;
        else high = middle - 1;
    }
    return low + 1;
}

function predicates(kept, blanked = kept) {
    const starts = lineStarts(blanked);
    const found = [];
    const add = (kind, inner, start, open, close, end) => {
        let to = close;
        if (kind === 'cfg_attr') {
            const comma = firstTopLevelComma(blanked, open + 1, close);
            if (comma < 0) return;
            to = comma;
        }
        const text = kept.slice(open + 1, to).trim();
        found.push({
            kind,
            inner,
            start,
            end,
            line: lineAt(starts, start),
            endLine: lineAt(starts, end - 1),
            text,
            tree: parse(text),
        });
    };
    for (const match of blanked.matchAll(ATTRIBUTE_START)) {
        const open = match.index + match[0].length - 1;
        const close = closing(blanked, open);
        if (close < 0) continue;
        const bracket = /^\s*\]/.exec(blanked.slice(close + 1));
        if (!bracket) continue;
        add(match[2], match[1] === '!', match.index, open, close, close + 1 + bracket[0].length);
    }
    for (const match of blanked.matchAll(MACRO_START)) {
        const open = match.index + match[0].length - 1;
        const close = closing(blanked, open);
        if (close < 0) continue;
        add('macro', false, match.index, open, close, close + 1);
    }
    return found.sort((a, b) => a.start - b.start);
}

function itemAfter(text, predicate, lines = text.split(/\r?\n/)) {
    const lineEnd = text.indexOf('\n', predicate.end);
    const rest = text.slice(predicate.end, lineEnd < 0 ? text.length : lineEnd).replace(LEADING_ATTRIBUTES, '');
    if (rest.trim()) return { lineno: predicate.endLine, text: rest };
    for (let index = predicate.endLine; index < lines.length; index++) {
        if (lines[index].trim() && !ATTRIBUTE_LINE.test(lines[index])) return { lineno: index + 1, text: lines[index] };
    }
    return null;
}

function decidesOs(predicate, keys = OS_KEYS) {
    if (![...namedOsKeys(predicate)].some(key => keys.has(key))) return false;
    return predicate.tree === null || dependsOnOs(predicate.tree);
}

function namedOsKeys(predicate) {
    if (predicate.tree) return new Set(atoms(predicate.tree).filter(isOsAtom).map(atom => atom.key));
    return new Set([...OS_KEYS].filter(key => new RegExp(`\\b${key}\\b`).test(predicate.text)));
}

module.exports = {
    ALWAYS,
    TARGETS,
    decidesOs,
    dependsOnOs,
    holds,
    itemAfter,
    kleene,
    lineAt,
    lineStarts,
    namedOsKeys,
    parse,
    predicates,
    targetTree,
};
