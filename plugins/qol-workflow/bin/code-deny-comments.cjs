#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const HOOK_NAME = 'code-deny-comments';
const BYPASS_FILE = path.join('.claude', 'bypass-no-comments');

const C_LIKE = {
    lineTokens: ['//'],
    blockPairs: [['/*', '*/']],
    quoteChars: ['"', "'", '`'],
};
const RUST = { ...C_LIKE, rawStrings: true, charLiterals: true };
const STYLE = {
    lineTokens: ['//'],
    blockPairs: [['/*', '*/']],
    quoteChars: ['"', "'"],
    skipUrlParens: true,
};
const CSS = { ...STYLE, lineTokens: [] };
const HASH = {
    lineTokens: ['#'],
    blockPairs: [],
    quoteChars: ['"', "'"],
};
const PYTHON = { ...HASH, tripleQuotes: true };

const LANGUAGES = new Map([
    ['.rs', RUST],
    ['.js', C_LIKE],
    ['.mjs', C_LIKE],
    ['.cjs', C_LIKE],
    ['.jsx', C_LIKE],
    ['.ts', C_LIKE],
    ['.tsx', C_LIKE],
    ['.mts', C_LIKE],
    ['.cts', C_LIKE],
    ['.go', C_LIKE],
    ['.java', C_LIKE],
    ['.c', C_LIKE],
    ['.h', C_LIKE],
    ['.cc', C_LIKE],
    ['.cpp', C_LIKE],
    ['.hpp', C_LIKE],
    ['.cs', C_LIKE],
    ['.kt', C_LIKE],
    ['.kts', C_LIKE],
    ['.swift', C_LIKE],
    ['.dart', C_LIKE],
    ['.php', C_LIKE],
    ['.css', CSS],
    ['.scss', STYLE],
    ['.less', STYLE],
    ['.py', PYTHON],
    ['.sh', HASH],
    ['.bash', HASH],
    ['.zsh', HASH],
    ['.rb', HASH],
]);

function languageFor(filePath) {
    return LANGUAGES.get(path.extname(filePath).toLowerCase()) ?? null;
}

function inQolRepo(filePath) {
    return path
        .resolve(filePath)
        .split(path.sep)
        .some((segment) => segment === 'qol' || segment.startsWith('qol-'));
}

function skipQuoted(text, start, quote) {
    let i = start + 1;
    while (i < text.length) {
        if (text[i] === '\\') {
            i += 2;
            continue;
        }
        if (text[i] === quote) return i + 1;
        i += 1;
    }
    return text.length;
}

function skipTriple(text, start, delimiter) {
    const end = text.indexOf(delimiter, start + delimiter.length);
    return end === -1 ? text.length : end + delimiter.length;
}

function rawStringAt(text, index) {
    const match = /^b?r(#*)"/.exec(text.slice(index, index + 16));
    if (!match) return null;
    const terminator = `"${match[1]}`;
    const bodyStart = index + match[0].length;
    const end = text.indexOf(terminator, bodyStart);
    return end === -1 ? text.length : end + terminator.length;
}

function skipUrlCall(text, index) {
    const end = text.indexOf(')', index);
    return end === -1 ? text.length : end + 1;
}

function isCommentHash(text, index) {
    if (index === 0 && text[1] === '!') return false;
    const previous = index > 0 ? text[index - 1] : '\n';
    return /\s/.test(previous);
}

function extractComments(text, language) {
    const found = [];
    let i = 0;

    scan: while (i < text.length) {
        if (language.tripleQuotes) {
            const triple = text.slice(i, i + 3);
            if (triple === '"""' || triple === "'''") {
                i = skipTriple(text, i, triple);
                continue;
            }
        }

        if (language.rawStrings) {
            const rawEnd = rawStringAt(text, i);
            if (rawEnd !== null) {
                i = rawEnd;
                continue;
            }
        }

        if (language.skipUrlParens && text.startsWith('url(', i)) {
            i = skipUrlCall(text, i);
            continue;
        }

        if (language.charLiterals && text[i] === "'") {
            const literal = /^'(?:\\.|[^'\\])'/.exec(text.slice(i, i + 12));
            i += literal ? literal[0].length : 1;
            continue;
        }

        if (language.quoteChars.includes(text[i])) {
            i = skipQuoted(text, i, text[i]);
            continue;
        }

        for (const [open, close] of language.blockPairs) {
            if (!text.startsWith(open, i)) continue;
            const end = text.indexOf(close, i + open.length);
            const stop = end === -1 ? text.length : end;
            found.push(text.slice(i + open.length, stop));
            i = end === -1 ? text.length : end + close.length;
            continue scan;
        }

        for (const token of language.lineTokens) {
            if (!text.startsWith(token, i)) continue;
            if (token === '#' && !isCommentHash(text, i)) break;
            const newline = text.indexOf('\n', i);
            const stop = newline === -1 ? text.length : newline;
            found.push(text.slice(i + token.length, stop));
            i = stop;
            continue scan;
        }

        i += 1;
    }

    return found;
}

function commentCounts(text, language) {
    const counts = new Map();
    for (const comment of extractComments(text, language)) {
        const key = comment.trim();
        counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
}

function addedComments(before, after, language) {
    const previous = commentCounts(before, language);
    const next = commentCounts(after, language);
    const added = [];
    for (const [comment, count] of next) {
        if (count > (previous.get(comment) ?? 0)) added.push(comment);
    }
    return added;
}

function readIfPresent(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return '';
    }
}

function targetPath(toolInput) {
    return toolInput.file_path ?? toolInput.path ?? null;
}

function editPairs(toolInput) {
    if (Array.isArray(toolInput.edits)) {
        return toolInput.edits.map((edit) => [
            edit.old_string ?? edit.oldText ?? '',
            edit.new_string ?? edit.newText ?? '',
        ]);
    }
    if (typeof toolInput.content === 'string') {
        return [[readIfPresent(targetPath(toolInput)), toolInput.content]];
    }
    if (typeof toolInput.new_string === 'string') {
        return [[toolInput.old_string ?? '', toolInput.new_string]];
    }
    return [];
}

function findBypassMarker(filePath) {
    let directory = path.dirname(path.resolve(filePath));
    for (;;) {
        const marker = path.join(directory, BYPASS_FILE);
        if (fs.existsSync(marker)) return marker;
        const parent = path.dirname(directory);
        if (parent === directory) return null;
        directory = parent;
    }
}

function consumeBypass(filePath) {
    const marker = findBypassMarker(filePath);
    if (!marker) return false;
    try {
        fs.unlinkSync(marker);
    } catch {
        return false;
    }
    return true;
}

function snippet(comment) {
    const flat = comment.replace(/\s+/g, ' ').trim();
    return flat.length > 60 ? `${flat.slice(0, 57)}...` : flat;
}

function deny(filePath, comment) {
    const payload = {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
                'Code comments are banned in qol-tools code; explanations belong in the matching SKILL.md, or in clearer names and smaller functions.\n' +
                `[${HOOK_NAME}] drop the added comment in ${path.basename(filePath)} ("${snippet(comment)}"), or bypass once: touch ${BYPASS_FILE}`,
        },
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.exit(0);
}

function main() {
    let payload;
    try {
        payload = JSON.parse(fs.readFileSync(0, 'utf8'));
    } catch {
        return;
    }

    const toolInput = payload.tool_input ?? {};
    const filePath = targetPath(toolInput);
    if (!filePath) return;
    if (!inQolRepo(filePath)) return;

    const language = languageFor(filePath);
    if (!language) return;

    for (const [before, after] of editPairs(toolInput)) {
        const added = addedComments(before, after, language);
        if (added.length === 0) continue;
        if (consumeBypass(filePath)) return;
        deny(filePath, added[0]);
    }
}

if (require.main === module) main();

module.exports = {
    addedComments,
    editPairs,
    extractComments,
    inQolRepo,
    languageFor,
    targetPath,
};
