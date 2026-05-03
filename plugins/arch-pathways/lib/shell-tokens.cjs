'use strict';

function tokenize(cmd) {
    const tokens = [];
    let cur = '';
    let pushed = false;
    let inSingle = false, inDouble = false;
    let i = 0;
    while (i < cmd.length) {
        const c = cmd[i];
        if (inSingle) {
            if (c === "'") { inSingle = false; i++; continue; }
            cur += c; i++; continue;
        }
        if (inDouble) {
            if (c === '"') { inDouble = false; i++; continue; }
            if (c === '\\' && (cmd[i + 1] === '"' || cmd[i + 1] === '\\' || cmd[i + 1] === '$' || cmd[i + 1] === '`')) {
                cur += cmd[i + 1]; i += 2; continue;
            }
            cur += c; i++; continue;
        }
        if (c === "'") { inSingle = true; pushed = false; i++; continue; }
        if (c === '"') { inDouble = true; pushed = false; i++; continue; }
        if (c === '\\' && i + 1 < cmd.length) { cur += cmd[i + 1]; pushed = false; i += 2; continue; }
        if (/\s/.test(c)) {
            if (cur || pushed) { tokens.push(cur); cur = ''; pushed = false; }
            i++; continue;
        }
        cur += c; pushed = true; i++;
    }
    if (cur || pushed) tokens.push(cur);
    return tokens;
}

function splitCommands(cmd) {
    const parts = [];
    let cur = '';
    let inSingle = false, inDouble = false;
    for (let i = 0; i < cmd.length; i++) {
        const c = cmd[i], nxt = cmd[i + 1];
        if (inSingle) { if (c === "'") inSingle = false; cur += c; continue; }
        if (inDouble) { if (c === '"') inDouble = false; cur += c; continue; }
        if (c === "'") { inSingle = true; cur += c; continue; }
        if (c === '"') { inDouble = true; cur += c; continue; }
        if (c === ';') { parts.push(cur); cur = ''; continue; }
        if (c === '&' && nxt === '&') { parts.push(cur); cur = ''; i++; continue; }
        if (c === '|' && nxt === '|') { parts.push(cur); cur = ''; i++; continue; }
        cur += c;
    }
    if (cur.trim()) parts.push(cur);
    return parts.map(s => s.trim()).filter(Boolean);
}

function flagValue(tokens, flagName) {
    for (let i = 0; i < tokens.length; i++) {
        if (tokens[i] === flagName) return tokens[i + 1];
        if (tokens[i].startsWith(flagName + '=')) return tokens[i].slice(flagName.length + 1);
    }
    return null;
}

module.exports = { tokenize, splitCommands, flagValue };
