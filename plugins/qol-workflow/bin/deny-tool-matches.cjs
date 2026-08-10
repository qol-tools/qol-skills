#!/usr/bin/env node
'use strict';

const fs = require('node:fs');

const HOOK_NAME = 'deny-tool-matches';
const ROOT_MARKER = '/qol-monorepo/';
const SCOPED_ROOTS = [
    '/libs/qol-terminal-sessions/src/cli/',
    '/plugins/cli-sessions/src/',
];
const EXEMPT = [
    '/builtins/',
    '/tests/',
    '/test/',
    '/session/tool.rs',
];

const TOOL_MATCH = /\bmatch\s+(?:[a-zA-Z_][\w]*\.)?tool\s*\{/;

function targetPath(toolInput) {
    return toolInput.file_path ?? toolInput.path ?? null;
}

function inScope(filePath) {
    const normalized = filePath.replace(/\\/g, '/');
    if (!normalized.includes(ROOT_MARKER)) return false;
    if (!SCOPED_ROOTS.some((root) => normalized.includes(root))) return false;
    return !EXEMPT.some((exempt) => normalized.includes(exempt));
}

function editPairs(toolInput) {
    if (Array.isArray(toolInput.edits)) {
        return toolInput.edits.map((edit) => [
            edit.old_string ?? '',
            edit.new_string ?? edit.newText ?? '',
        ]);
    }
    if (typeof toolInput.new_string === 'string') {
        return [[toolInput.old_string ?? '', toolInput.new_string]];
    }
    if (typeof toolInput.content === 'string') {
        return [['', toolInput.content]];
    }
    return [];
}

function deny(filePath) {
    const payload = {
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason:
                'A `match` on the tool in shared code is a second registry that drifts from the facade; per-tool behavior belongs in the backend for that tool.\n' +
                `[${HOOK_NAME}] move the variant behavior into a backend module (builtins/<tool>/name.rs, platform/<variant>/, a registered strategy) and consume the facade; see qol-plugin-cli-sessions "Naming and per-tool backends"`,
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
    const filePath = targetPath(payload.tool_input ?? {});
    if (!filePath || !inScope(filePath)) return;
    for (const [, after] of editPairs(payload.tool_input ?? {})) {
        if (TOOL_MATCH.test(after)) deny(filePath);
    }
}

if (require.main === module) main();

module.exports = {
    TOOL_MATCH,
    editPairs,
    inScope,
    targetPath,
};
