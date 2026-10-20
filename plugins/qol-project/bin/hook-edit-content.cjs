'use strict';

const fs = require('node:fs');
const lintMode = require('./hook-lint-mode.cjs');

function readExistingFile(filePath) {
    if (lintMode.isTarget(filePath)) return lintMode.baseline();
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch {
        return null;
    }
}

function applyEdit(content, oldString, newString, replaceAll) {
    if (!oldString || !content.includes(oldString)) return null;
    if (replaceAll) return content.split(oldString).join(newString || '');
    return content.replace(oldString, () => newString || '');
}

function prospectiveContent(tool, input, existing) {
    if (tool === 'Write') return input.content || '';
    const edits = tool === 'Edit' ? [input] : input.edits || [];
    if (existing === null) return edits.map(edit => edit.new_string || '').join('\n');
    let content = existing;
    for (const edit of edits) {
        const next = applyEdit(content, edit.old_string, edit.new_string, edit.replace_all);
        if (next === null) return edits.map(item => item.new_string || '').join('\n');
        content = next;
    }
    return content;
}

module.exports = { readExistingFile, prospectiveContent };
