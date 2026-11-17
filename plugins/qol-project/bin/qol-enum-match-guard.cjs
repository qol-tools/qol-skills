'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const serde = require('./rust-serde.cjs');

const BINDING = /^(?:ref\s+)?(?:mut\s+)?[a-z_]\w*\s*@\s*/;
const REFERENCE = /^&\s*(?:mut\s+)?/;
const VARIANT_PATH = /^((?:[A-Za-z_]\w*\s*::\s*)*?)([A-Z]\w*)\s*::\s*([A-Z]\w*)(?![\w:])/;
const ARM_ATTRIBUTES = /^(?:#\s*\[[^\]]*\]\s*)+/;
const EXPRESSION_GOES_ON = /^(?:else\b|as\b|[.?])/;
const IMPL_ITEM_BEFORE = /(?:^|[{};\]]|\bunsafe|\bdefault)$/;
const SHOWN = 6;

const roots = new Map();
const indexes = new Map();
const parsed = new Map();

function lineAt(text, index) {
    return text.slice(0, index).split('\n').length;
}

function skipGroup(text, at) {
    return serde.matchForward(text, at);
}

function bodyOpen(skeleton, from) {
    let depth = 0;
    for (let i = from; i < skeleton.length; i++) {
        const c = skeleton[i];
        if (c === '(' || c === '[') depth++;
        else if (c === ')' || c === ']') {
            if (depth === 0) return -1;
            depth--;
        } else if (c === '{') {
            if (depth === 0) return i;
            i = skipGroup(skeleton, i);
        } else if ((c === ';' || c === '}') && depth === 0) return -1;
    }
    return -1;
}

function topLevelMarks(skeleton, open, close) {
    const arrows = [];
    const commas = [];
    const blockEnds = [];
    for (let i = open + 1; i < close; i++) {
        const c = skeleton[i];
        if (c === '(' || c === '[') {
            i = skipGroup(skeleton, i);
        } else if (c === '{') {
            i = skipGroup(skeleton, i);
            blockEnds.push(i);
        } else if (c === ':' && skeleton[i + 1] === ':' && skeleton[i + 2] === '<') {
            i = skipGroup(skeleton, i + 2);
        } else if (c === '=' && skeleton[i + 1] === '>') {
            arrows.push(i);
            i++;
        } else if (c === '-' && skeleton[i + 1] === '>') {
            i++;
        } else if (c === ',') {
            commas.push(i);
        }
    }
    return { arrows, commas, blockEnds };
}

function patternStart(skeleton, from, to, marks) {
    const commas = marks.commas.filter(at => at > from && at < to);
    if (commas.length > 0) return commas[commas.length - 1] + 1;
    for (const end of marks.blockEnds) {
        if (end <= from || end >= to) continue;
        if (!EXPRESSION_GOES_ON.test(skeleton.slice(end + 1, to).trimStart())) return end + 1;
    }
    return -1;
}

function arms(skeleton, open, close) {
    const marks = topLevelMarks(skeleton, open, close);
    const found = [];
    let previous = open;
    for (const arrow of marks.arrows) {
        const start = previous === open ? open + 1 : patternStart(skeleton, previous + 2, arrow, marks);
        previous = arrow;
        if (start < 0) continue;
        let head = skeleton.slice(start, arrow);
        const guard = /\bif\b/.exec(head);
        if (guard) head = head.slice(0, guard.index);
        const pattern = head.trim().replace(ARM_ATTRIBUTES, '').replace(/^\|\s*/, '').trim();
        const offset = start + skeleton.slice(start, arrow).search(/\S/);
        found.push({ pattern, guarded: Boolean(guard), at: offset });
    }
    return found;
}

function alternatives(pattern) {
    const parts = [];
    let start = 0;
    for (let i = 0; i < pattern.length; i++) {
        const c = pattern[i];
        if (c === '(' || c === '[' || c === '{') i = skipGroup(pattern, i);
        else if (c === '|') {
            parts.push(pattern.slice(start, i));
            start = i + 1;
        }
    }
    parts.push(pattern.slice(start));
    return parts.map(part => part.trim()).filter(Boolean);
}

function namedVariant(alternative) {
    const bare = alternative.replace(BINDING, '').replace(REFERENCE, '');
    const match = VARIANT_PATH.exec(bare);
    return match ? { enumName: match[2], variant: match[3] } : null;
}

function topLevelFor(text) {
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
        const c = text[i];
        if (c === '<') depth++;
        else if (c === '>' && text[i - 1] !== '-') depth--;
        else if (depth === 0 && /\bfor\b/y.test(text.slice(i, i + 4)) && !/\w/.test(text[i - 1] || '')) return i;
    }
    return -1;
}

function selfTypeName(header) {
    let text = header.replace(/\bwhere\b[\s\S]*$/, '').trim();
    if (text.startsWith('<')) text = text.slice(serde.matchForward(text, 0) + 1);
    const forAt = topLevelFor(text);
    if (forAt >= 0) text = text.slice(forAt + 3);
    text = text.trim().replace(/^&\s*(?:'\w+\s+)?(?:mut\s+)?/, '');
    const match = /^(?:[A-Za-z_]\w*\s*::\s*)*([A-Z]\w*)/.exec(text);
    return match ? match[1] : null;
}

function implSpans(skeleton) {
    const spans = [];
    for (const match of skeleton.matchAll(/\bimpl\b/g)) {
        if (!IMPL_ITEM_BEFORE.test(skeleton.slice(0, match.index).trimEnd())) continue;
        const open = skeleton.indexOf('{', match.index);
        if (open < 0) continue;
        const header = skeleton.slice(match.index + 4, open);
        if (header.includes(';')) continue;
        const name = selfTypeName(header);
        if (name) spans.push({ start: open, end: skipGroup(skeleton, open), name });
    }
    return spans;
}

function selfAt(spans, index) {
    let inner = null;
    for (const span of spans) {
        if (span.start < index && index < span.end && (!inner || span.start > inner.start)) inner = span;
    }
    return inner ? inner.name : null;
}

function catchAllMatches(file, content) {
    if (!content) return [];
    const source = serde.production(file, content);
    if (!source) return [];
    const skeleton = source.skeleton;
    const spans = implSpans(skeleton);
    const found = [];
    for (const keyword of skeleton.matchAll(/\bmatch\b/g)) {
        if (skeleton[keyword.index - 1] === '#') continue;
        const open = bodyOpen(skeleton, keyword.index + 5);
        if (open < 0) continue;
        const close = skipGroup(skeleton, open);
        let catchAll = null;
        const named = [];
        for (const arm of arms(skeleton, open, close)) {
            if (!arm.guarded && arm.pattern === '_') {
                catchAll ??= arm;
                continue;
            }
            for (const alternative of alternatives(arm.pattern)) {
                const variant = namedVariant(alternative);
                if (variant) named.push(variant);
            }
        }
        if (!catchAll || named.length === 0) continue;
        const enums = new Set(named.map(entry => entry.enumName === 'Self' ? selfAt(spans, keyword.index) : entry.enumName));
        if (enums.size !== 1 || enums.has(null)) continue;
        const [enumName] = enums;
        const variants = [...new Set(named.map(entry => entry.variant))].sort();
        found.push({
            enumName,
            variants,
            line: lineAt(skeleton, catchAll.at),
            key: `${enumName}:${variants.join(',')}`,
        });
    }
    return found;
}

function repoRoot(file) {
    let dir = path.dirname(path.resolve(file));
    const visited = [];
    for (;;) {
        if (roots.has(dir)) break;
        visited.push(dir);
        if (fs.existsSync(path.join(dir, '.git'))) {
            roots.set(dir, dir);
            break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            roots.set(dir, null);
            break;
        }
        dir = parent;
    }
    const root = roots.get(dir);
    for (const seen of visited) roots.set(seen, root);
    return root;
}

function nonExhaustive(skeleton, enumName) {
    return new RegExp(`#\\s*\\[\\s*non_exhaustive\\s*\\]\\s*(?:#\\s*\\[[^\\]]*\\]\\s*)*(?:pub(?:\\s*\\([^)]*\\))?\\s+)?enum\\s+${enumName}\\b`).test(skeleton);
}

function declaredEnums(file, content) {
    const source = serde.production(file, content);
    if (!source) return [];
    return serde.fileItems(file, source).defs
        .filter(def => def.kind === 'enum')
        .map(def => ({
            name: def.name,
            variants: def.variants.map(variant => variant.rust),
            nonExhaustive: nonExhaustive(source.skeleton, def.name),
        }));
}

function enumIndex(root) {
    if (indexes.has(root)) return indexes.get(root);
    let output = '';
    try {
        output = execFileSync('git', [
            'grep', '-o', '--untracked', '-E', '(^|[^[:alnum:]_])enum[[:space:]]+[A-Z][[:alnum:]_]*',
            '--', '*.rs', ':!vendor/**', ':!third_party/**',
        ], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    } catch {
        output = '';
    }
    const index = new Map();
    for (const line of output.split('\n')) {
        const match = /^([^:]+):.*\benum\s+([A-Z]\w*)$/.exec(line);
        if (!match) continue;
        if (!index.has(match[2])) index.set(match[2], new Set());
        index.get(match[2]).add(match[1]);
    }
    indexes.set(root, index);
    return index;
}

function fileEnums(file) {
    if (parsed.has(file)) return parsed.get(file);
    let found = [];
    try {
        found = declaredEnums(file, fs.readFileSync(file, 'utf8'));
    } catch {
        found = [];
    }
    parsed.set(file, found);
    return found;
}

function workspaceEnums(root, enumName) {
    const files = enumIndex(root).get(enumName) || new Set();
    return [...files].flatMap(relative => fileEnums(path.join(root, relative)).filter(def => def.name === enumName));
}

function hiddenVariants(candidate, declared) {
    for (const def of declared) {
        if (def.nonExhaustive) continue;
        if (!candidate.variants.every(variant => def.variants.includes(variant))) continue;
        const hidden = def.variants.filter(variant => !candidate.variants.includes(variant));
        if (hidden.length > 0) return hidden;
    }
    return null;
}

function fresh(before, after) {
    const exact = new Map();
    const byEnum = new Map();
    for (const candidate of before) {
        exact.set(candidate.key, (exact.get(candidate.key) || 0) + 1);
        byEnum.set(candidate.enumName, (byEnum.get(candidate.enumName) || 0) + 1);
    }
    const unmatched = [];
    for (const candidate of after) {
        const left = exact.get(candidate.key) || 0;
        if (left > 0) {
            exact.set(candidate.key, left - 1);
            byEnum.set(candidate.enumName, byEnum.get(candidate.enumName) - 1);
            continue;
        }
        unmatched.push(candidate);
    }
    return unmatched.filter(candidate => {
        const left = byEnum.get(candidate.enumName) || 0;
        if (left <= 0) return true;
        byEnum.set(candidate.enumName, left - 1);
        return false;
    });
}

function newViolations(file, baseline, content) {
    const after = catchAllMatches(file, content);
    if (after.length === 0) return [];
    const added = fresh(catchAllMatches(file, baseline), after);
    if (added.length === 0) return [];
    const root = repoRoot(file);
    const own = declaredEnums(file, content);
    const violations = [];
    for (const candidate of added) {
        const declared = [
            ...own.filter(def => def.name === candidate.enumName),
            ...(root ? workspaceEnums(root, candidate.enumName) : []),
        ];
        const hidden = hiddenVariants(candidate, declared);
        if (!hidden) continue;
        violations.push({ ...candidate, hidden });
    }
    return violations;
}

function formatViolations(violations) {
    return violations.map(violation => {
        const shown = violation.hidden.slice(0, SHOWN).map(variant => `${violation.enumName}::${variant}`);
        if (violation.hidden.length > SHOWN) shown.push(`and ${violation.hidden.length - SHOWN} more`);
        return `  line ${violation.line}: \`_ =>\` stands for ${shown.join(', ')}`;
    }).join('\n');
}

module.exports = { catchAllMatches, newViolations, formatViolations };
