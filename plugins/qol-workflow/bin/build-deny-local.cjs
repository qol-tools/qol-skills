#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MONOREPO = /(^|[\\/])qol-monorepo(-worktrees)?([\\/]|$)/;
const APPROVED = /#\s*user approved local build\b/;

const CARGO_COMPILES = new Set([
    'build', 'b', 'check', 'c', 'test', 't', 'clippy', 'run', 'r', 'nextest',
    'bench', 'doc', 'd', 'install', 'fix', 'rustc', 'miri', 'llvm-cov', 'tarpaulin',
]);
const CARGO_VALUE_FLAGS = new Set(['-Z', '-C', '--config', '--color', '--manifest-path']);
const QOL_COMPILES = new Set(['build', 'check', 'dev', 'install', 'setup']);
const NO_VALUE_FLAGS = new Set();
const WRAPPERS = new Set(['nice', 'ionice', 'time', 'env', 'nohup', 'exec', 'command', 'timeout', 'sudo', 'chrt', 'taskset']);

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function stripHeredocs(command) {
    const kept = [];
    let delimiter = null;
    for (const line of command.split('\n')) {
        if (delimiter !== null) {
            if (line.replace(/^\t+/, '') === delimiter) delimiter = null;
            continue;
        }
        kept.push(line);
        const opened = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
        if (opened) delimiter = opened[2];
    }
    return kept.join('\n');
}

function maskQuotes(command) {
    return command
        .replace(/'[^']*'/g, "''")
        .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function stripShellComments(command) {
    return command.replace(/(^|\s)#[^\n]*/g, '$1');
}

function segments(command) {
    const text = stripShellComments(maskQuotes(stripHeredocs(command)));
    return text.split(/&&|\|\||[;|&\n()`]|\$\(/).map((part) => part.trim()).filter(Boolean);
}

function isWrapperOption(token) {
    return token.startsWith('-') || /^\d+[smhd]?$/.test(token);
}

function words(segment) {
    const tokens = segment.split(/\s+/).filter(Boolean);
    let index = 0;
    while (index < tokens.length) {
        const token = tokens[index];
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) {
            index += 1;
            continue;
        }
        if (!WRAPPERS.has(path.basename(token))) break;
        index += 1;
        while (index < tokens.length && isWrapperOption(tokens[index])) index += 1;
    }
    return tokens.slice(index);
}

function subcommand(tokens, valueFlags) {
    let index = 1;
    while (index < tokens.length) {
        const token = tokens[index];
        if (valueFlags.has(token)) {
            index += 2;
            continue;
        }
        if (token.startsWith('+') || token.startsWith('-')) {
            index += 1;
            continue;
        }
        return { name: token, rest: tokens.slice(index + 1) };
    }
    return null;
}

function cargoCompile(tokens) {
    const found = subcommand(tokens, CARGO_VALUE_FLAGS);
    return found && CARGO_COMPILES.has(found.name) ? `cargo ${found.name}` : null;
}

function qolCompile(tokens) {
    const found = subcommand(tokens, NO_VALUE_FLAGS);
    if (!found) return null;
    if (QOL_COMPILES.has(found.name)) return `qol ${found.name}`;
    const devGuest = found.name === 'env' && found.rest[0] === 'up'
        && found.rest.some((token) => token.startsWith('--dev-worktree'));
    return devGuest ? 'qol env up --dev-worktree' : null;
}

function localCompile(segment) {
    const tokens = words(segment);
    if (tokens.length === 0) return null;
    const program = path.basename(tokens[0]);
    if (program === 'cargo') return cargoCompile(tokens);
    if (program === 'qol') return qolCompile(tokens);
    return null;
}

function findLocalCompile(command) {
    for (const segment of segments(command)) {
        const found = localCompile(segment);
        if (found) return found;
    }
    return null;
}

function inMonorepo(cwd, command) {
    if (typeof cwd === 'string' && MONOREPO.test(cwd)) return true;
    return MONOREPO.test(stripHeredocs(command));
}

function denyReason(compile) {
    return `Local builds, tests and clippy in qol-monorepo are off: CI runs them on the pull request so the user's PC stays free (\`${compile}\`).
[build-deny-local] push and read CI through the watcher, live test with \`qol pr try <number>\`, keep cargo fmt and qac lint local, and append \` # user approved local build\` only after the user approved this build.`;
}

function main() {
    const raw = readStdin().trim();
    if (!raw) return 0;

    let payload;
    try {
        payload = JSON.parse(raw);
    } catch {
        return 0;
    }

    if ((payload.tool_name || payload.tool || '') !== 'Bash') return 0;
    const command = (payload.tool_input && payload.tool_input.command) || '';
    if (!command || APPROVED.test(command)) return 0;

    const cwd = (payload.tool_input && payload.tool_input.cwd) || payload.cwd || process.cwd();
    if (!inMonorepo(cwd, command)) return 0;

    const compile = findLocalCompile(command);
    if (!compile) return 0;

    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: denyReason(compile),
        },
    }));
    return 0;
}

module.exports = { findLocalCompile, inMonorepo };

if (require.main === module) {
    process.exit(main());
}
