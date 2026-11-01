#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TAG = 'worktree-deny-divergent-layout';
const MAIN_NAME = 'qol-monorepo';
const INTENTIONAL = /#\s*intentional\b/;
const WRAPPERS = new Set(['nice', 'ionice', 'time', 'env', 'nohup', 'exec', 'command', 'timeout', 'sudo', 'chrt', 'taskset']);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=/;
const ADD_VALUE_FLAGS = new Set(['--reason']);
const REVISION = /[~^@:]|^HEAD$|^refs\//;
const SHA = /^[0-9a-f]{7,40}$/i;
const UNRESOLVED = 'cannot be resolved before it runs; spell it out';

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

function lookup(name, vars) {
    if (Object.prototype.hasOwnProperty.call(vars, name)) return vars[name];
    if (name === 'HOME') return os.homedir();
    return Object.prototype.hasOwnProperty.call(process.env, name) ? process.env[name] : null;
}

function closingParen(text, start) {
    let depth = 0;
    for (let i = start; i < text.length; i += 1) {
        if (text[i] === '(') depth += 1;
        else if (text[i] === ')') {
            depth -= 1;
            if (depth === 0) return i;
        }
    }
    return text.length - 1;
}

function recordAssignments(words, vars) {
    const assigns = words[0].value === 'export' ? words.slice(1) : words;
    if (assigns.length === 0 || !assigns.every((w) => ASSIGNMENT.test(w.value))) return;
    for (const w of assigns) {
        const name = w.value.match(ASSIGNMENT)[1];
        vars[name] = w.unresolved ? null : w.value.slice(name.length + 1);
    }
}

function parseCommands(command) {
    const text = stripHeredocs(command);
    const vars = {};
    const commands = [];
    let words = [];
    let word = null;
    let skipNext = false;

    const extend = (chunk, unresolved = false) => {
        if (!word) word = { value: '', unresolved: false };
        word.value += chunk;
        if (unresolved) word.unresolved = true;
    };
    const endWord = () => {
        if (!word) return;
        if (skipNext) skipNext = false;
        else words.push(word);
        word = null;
    };
    const endCommand = () => {
        endWord();
        skipNext = false;
        if (words.length === 0) return;
        recordAssignments(words, vars);
        commands.push(words);
        words = [];
    };
    const expand = (i) => {
        const next = text[i + 1];
        if (next === '(') {
            extend('', true);
            return closingParen(text, i + 1);
        }
        if (next === '{') {
            const end = text.indexOf('}', i + 2);
            const close = end === -1 ? text.length - 1 : end;
            const name = text.slice(i + 2, close);
            const value = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? lookup(name, vars) : null;
            extend(value ?? '', value === null);
            return close;
        }
        const name = text.slice(i + 1).match(/^[A-Za-z_][A-Za-z0-9_]*/);
        if (name) {
            const value = lookup(name[0], vars);
            extend(value ?? '', value === null);
            return i + name[0].length;
        }
        extend('$');
        return i;
    };
    const backtick = (i) => {
        const end = text.indexOf('`', i + 1);
        extend('', true);
        return end === -1 ? text.length : end;
    };

    for (let i = 0; i < text.length; i += 1) {
        const c = text[i];
        if (c === "'") {
            const end = text.indexOf("'", i + 1);
            const close = end === -1 ? text.length : end;
            extend(text.slice(i + 1, close));
            i = close;
        } else if (c === '"') {
            extend('');
            i += 1;
            while (i < text.length && text[i] !== '"') {
                if (text[i] === '\\' && '"\\$`'.includes(text[i + 1])) {
                    extend(text[i + 1]);
                    i += 2;
                } else if (text[i] === '$') {
                    i = expand(i) + 1;
                } else if (text[i] === '`') {
                    i = backtick(i) + 1;
                } else {
                    extend(text[i]);
                    i += 1;
                }
            }
        } else if (c === '\\') {
            if (text[i + 1] !== '\n') extend(text[i + 1] ?? '');
            i += 1;
        } else if (c === '$') {
            i = expand(i);
        } else if (c === '`') {
            i = backtick(i);
        } else if (c === '#' && !word) {
            const end = text.indexOf('\n', i);
            i = end === -1 ? text.length : end - 1;
        } else if (c === '~' && !word && (text[i + 1] === undefined || /[\s/]/.test(text[i + 1]))) {
            extend(os.homedir());
        } else if (c === '>' || c === '<' || (c === '&' && text[i + 1] === '>')) {
            if (word && /^\d+$/.test(word.value)) word = null;
            endWord();
            while (/[<>&|-]/.test(text[i + 1] ?? '')) i += 1;
            skipNext = true;
        } else if (/[;&|\n()]/.test(c)) {
            endCommand();
        } else if (/\s/.test(c)) {
            endWord();
        } else {
            extend(c);
        }
    }
    endCommand();
    return commands;
}

function program(words) {
    let index = 0;
    while (index < words.length) {
        const value = words[index].value;
        if (ASSIGNMENT.test(value)) {
            index += 1;
            continue;
        }
        if (!WRAPPERS.has(path.basename(value))) break;
        index += 1;
        while (index < words.length && /^-|^\d+[smhd]?$/.test(words[index].value)) index += 1;
    }
    return words.slice(index);
}

function findRepo(cwd) {
    let dir = cwd;
    while (dir && path.dirname(dir) !== dir) {
        const dotGit = path.join(dir, '.git');
        let stat;
        try {
            stat = fs.statSync(dotGit);
        } catch {
            dir = path.dirname(dir);
            continue;
        }
        if (stat.isDirectory()) return { main: dir, top: dir };
        try {
            const pointer = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
            const gitdir = path.resolve(dir, pointer[1].trim());
            const owner = gitdir.match(/^(.*)[\\/]\.git[\\/]worktrees[\\/][^\\/]+$/);
            return owner ? { main: owner[1], top: dir } : null;
        } catch {
            return null;
        }
    }
    return null;
}

function monorepo(cwd) {
    if (typeof cwd !== 'string' || !cwd) return null;
    const repo = findRepo(cwd);
    if (!repo || path.basename(repo.main) !== MAIN_NAME) return null;
    return { ...repo, root: path.join(path.dirname(repo.main), 'worktrees') };
}

function layoutFeature(repo, target) {
    const parts = path.relative(repo.root, target).split(path.sep);
    if (parts.length !== 2 || parts[1] !== MAIN_NAME) return null;
    if (!parts[0] || parts[0] === '.' || parts[0] === '..') return null;
    return parts[0];
}

function headBranch(gitdir) {
    try {
        const head = fs.readFileSync(path.join(gitdir, 'HEAD'), 'utf8').trim();
        const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
        return ref ? ref[1] : null;
    } catch {
        return null;
    }
}

function worktreeGitdir(top) {
    try {
        const pointer = fs.readFileSync(path.join(top, '.git'), 'utf8').match(/^gitdir:\s*(.+)$/m);
        return path.resolve(top, pointer[1].trim());
    } catch {
        return path.join(top, '.git');
    }
}

function worktreeOnBranch(repo, branch) {
    const admin = path.join(repo.main, '.git', 'worktrees');
    let names = [];
    try {
        names = fs.readdirSync(admin);
    } catch {
        return null;
    }
    for (const name of names) {
        const gitdir = path.join(admin, name);
        if (headBranch(gitdir) !== branch) continue;
        try {
            return path.dirname(fs.readFileSync(path.join(gitdir, 'gitdir'), 'utf8').trim());
        } catch {
            return null;
        }
    }
    return null;
}

function localBranch(repo, name) {
    const gitDir = path.join(repo.main, '.git');
    if (fs.existsSync(path.join(gitDir, 'refs', 'heads', name))) return true;
    try {
        return fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8')
            .split('\n')
            .some((line) => line.endsWith(` refs/heads/${name}`));
    } catch {
        return false;
    }
}

function slug(name) {
    const last = String(name || '').split('/').filter(Boolean).pop() || '';
    return last.replace(/[^A-Za-z0-9._-]/g, '-') || '<feature>';
}

function layoutPath(repo, feature) {
    return path.join(repo.root, feature, MAIN_NAME);
}

function addHint(repo, feature, base = '') {
    return `run \`git -C ${repo.main} worktree add ${layoutPath(repo, feature)} -b ${feature}${base}\``;
}

function deny(problem, hint) {
    return `This qol-monorepo worktree leaves the layout: ${problem}. \`qol dev <feature>\` finds a worktree by its branch name, so the folder and the branch must both be <feature>.
[${TAG}] ${hint} (qol-workflow:git-trees, "Layout"), or append \` # intentional\` when the user asked for this layout.`;
}

function shortFlags(value, valueLetters) {
    const letters = value.slice(1);
    for (let i = 0; i < letters.length; i += 1) {
        if (valueLetters.includes(letters[i])) {
            return { letters: letters.slice(0, i + 1), value: letters.slice(i + 1) || null, takes: true };
        }
    }
    return { letters, value: null, takes: false };
}

function parseAdd(args) {
    const parsed = { branch: null, detach: false, positional: [] };
    for (let i = 0; i < args.length; i += 1) {
        const value = args[i].value;
        if (value === '--') {
            parsed.positional.push(...args.slice(i + 1));
            break;
        }
        if (ADD_VALUE_FLAGS.has(value)) {
            i += 1;
        } else if (value === '--detach') {
            parsed.detach = true;
        } else if (/^-[A-Za-z]/.test(value)) {
            const flags = shortFlags(value, 'bB');
            if (flags.letters.includes('d')) parsed.detach = true;
            if (!flags.takes) continue;
            if (flags.value !== null) {
                parsed.branch = { value: flags.value, unresolved: args[i].unresolved };
            } else {
                parsed.branch = args[i + 1] || { value: '', unresolved: true };
                i += 1;
            }
        } else if (!value.startsWith('-')) {
            parsed.positional.push(args[i]);
        }
    }
    return parsed;
}

function checkedOutBranch(repo, { branch, detach, commitish }, target) {
    if (branch) return branch.value;
    if (detach) return null;
    if (!commitish) return path.basename(target);
    if (commitish.unresolved) return null;
    if (localBranch(repo, commitish.value)) return commitish.value;
    if (SHA.test(commitish.value) || REVISION.test(commitish.value) || commitish.value.includes('/')) return null;
    return commitish.value;
}

function checkAdd(repo, cwd, args) {
    const { branch, detach, positional } = parseAdd(args);
    const [where, commitish] = positional;
    if (!where) return null;
    const base = !branch && commitish && !commitish.unresolved ? ` ${commitish.value}` : '';
    const guess = slug(branch ? branch.value : base.trim());
    if (where.unresolved) return deny(`its path ${UNRESOLVED}`, addHint(repo, guess));
    const target = path.resolve(cwd, where.value);
    const feature = layoutFeature(repo, target);
    if (branch && branch.unresolved) return deny(`its branch name ${UNRESOLVED}`, addHint(repo, feature || guess));
    const name = checkedOutBranch(repo, { branch, detach, commitish }, target);
    if (!feature) {
        const fallback = path.basename(target) === MAIN_NAME ? path.dirname(target) : target;
        const pick = name && name !== MAIN_NAME ? slug(name) : slug(fallback);
        return deny(`it would sit at ${target}, outside ${repo.root}/<feature>/${MAIN_NAME}`, addHint(repo, pick, base));
    }
    if (name === null || name === feature) return null;
    const why = branch || commitish
        ? `its branch would be \`${name}\`, not the folder name \`${feature}\``
        : `with no \`-b\` git names its branch \`${name}\`, not the folder name \`${feature}\``;
    return deny(why, addHint(repo, feature, base));
}

function moveHint(repo, source, branch, feature) {
    const move = `\`git -C ${repo.main} worktree move ${source} ${layoutPath(repo, feature)}\``;
    if (!branch || branch === feature) return `run ${move}`;
    return `run \`git -C ${repo.main} branch -m ${branch} ${feature}\` and ${move}`;
}

function checkMove(repo, cwd, args) {
    const positional = args.filter((w) => !w.value.startsWith('-'));
    if (positional.length < 2) return null;
    const [from, to] = positional;
    if (from.unresolved) return null;
    const source = path.resolve(cwd, from.value);
    const branch = headBranch(worktreeGitdir(source));
    if (to.unresolved) return deny(`its new path ${UNRESOLVED}`, moveHint(repo, source, branch, slug(branch)));
    let target = path.resolve(cwd, to.value);
    try {
        if (fs.statSync(target).isDirectory()) target = path.join(target, path.basename(source));
    } catch {}
    const feature = layoutFeature(repo, target);
    if (!feature) {
        const pick = slug(branch || path.basename(path.dirname(target)));
        return deny(`it would move to ${target}, outside ${repo.root}/<feature>/${MAIN_NAME}`, moveHint(repo, source, branch, pick));
    }
    if (!branch || branch === feature) return null;
    return deny(`it would put branch \`${branch}\` in the folder \`${feature}\``, moveHint(repo, source, branch, slug(branch)));
}

function keepHint(feature) {
    return `keep the branch named \`${feature}\``;
}

function checkBranch(repo, args) {
    let move = false;
    const positional = [];
    for (const word of args) {
        const value = word.value;
        if (value === '--move') move = true;
        else if (/^-[A-Za-z]+$/.test(value)) {
            if (/[mM]/.test(value)) move = true;
        } else if (!value.startsWith('-')) positional.push(word);
    }
    if (!move || positional.length === 0) return null;
    const next = positional[positional.length - 1];
    const old = positional.length > 1 ? positional[0] : null;
    if (old && old.unresolved) return null;
    const top = old ? worktreeOnBranch(repo, old.value) : repo.top;
    if (!top) return null;
    const feature = layoutFeature(repo, top);
    if (!feature) return null;
    if (next.unresolved) return deny(`its new branch name ${UNRESOLVED}`, keepHint(feature));
    if (next.value === feature) return null;
    return deny(`it would rename the branch of ${top} to \`${next.value}\`, not its folder name \`${feature}\``, keepHint(feature));
}

function createdBranch(verb, args) {
    const letters = verb === 'switch' ? 'cC' : 'bB';
    for (let i = 0; i < args.length; i += 1) {
        const value = args[i].value;
        if (value === '--orphan' || (verb === 'switch' && (value === '--create' || value === '--force-create'))) {
            return args[i + 1] || null;
        }
        if (!/^-[A-Za-z]+$/.test(value)) continue;
        const flags = shortFlags(value, letters);
        if (!flags.takes) continue;
        return flags.value !== null ? { value: flags.value, unresolved: args[i].unresolved } : args[i + 1] || null;
    }
    return null;
}

function checkCreate(repo, verb, args) {
    const feature = layoutFeature(repo, repo.top);
    if (!feature) return null;
    const name = createdBranch(verb, args);
    if (!name) return null;
    if (name.unresolved) return deny(`its new branch name ${UNRESOLVED}`, keepHint(feature));
    if (name.value === feature) return null;
    return deny(`it would put ${repo.top} on branch \`${name.value}\`, not its folder name \`${feature}\``, keepHint(feature));
}

function gitTarget(words, cwd) {
    let gitCwd = cwd;
    let index = 1;
    while (index < words.length) {
        const value = words[index].value;
        if (value === '-C') {
            const target = words[index + 1];
            gitCwd = !target || target.unresolved ? null : path.resolve(gitCwd, target.value);
            if (gitCwd === null) return null;
            index += 2;
        } else if (value === '-c' || value === '--namespace' || value === '--config-env') {
            index += 2;
        } else if (value.startsWith('--git-dir') || value.startsWith('--work-tree')) {
            return null;
        } else if (value.startsWith('-')) {
            index += 1;
        } else {
            return { gitCwd, sub: value, rest: words.slice(index + 1) };
        }
    }
    return null;
}

function checkGit(words, cwd) {
    const found = gitTarget(words, cwd);
    if (!found) return null;
    const { gitCwd, sub, rest } = found;
    const repo = monorepo(gitCwd);
    if (!repo) return null;
    if (sub === 'worktree' && rest[0] && rest[0].value === 'add') return checkAdd(repo, gitCwd, rest.slice(1));
    if (sub === 'worktree' && rest[0] && rest[0].value === 'move') return checkMove(repo, gitCwd, rest.slice(1));
    if (sub === 'branch') return checkBranch(repo, rest);
    if (sub === 'checkout' || sub === 'switch') return checkCreate(repo, sub, rest);
    return null;
}

function checkBash(command, baseCwd) {
    let cwd = baseCwd;
    for (const raw of parseCommands(command)) {
        const words = program(raw);
        if (words.length === 0) continue;
        const name = path.basename(words[0].value);
        if (name === 'cd' || name === 'pushd') {
            const target = words.find((w, i) => i > 0 && !w.value.startsWith('-'));
            if (!target) cwd = os.homedir();
            else cwd = target.unresolved || cwd === null ? null : path.resolve(cwd, target.value);
            continue;
        }
        if (name !== 'git' || cwd === null) continue;
        const reason = checkGit(words, cwd);
        if (reason) return reason;
    }
    return null;
}

function checkTool(tool, input, cwd) {
    const repo = monorepo(cwd);
    if (!repo) return null;
    if (tool === 'EnterWorktree' && !input.path) {
        const feature = input.name ? slug(input.name) : '<feature>';
        return deny(
            'EnterWorktree would create it under .claude/worktrees/ on a branch that is not its folder name',
            `${addHint(repo, feature)} with Bash, then pass that path to EnterWorktree`,
        );
    }
    if ((tool === 'Agent' || tool === 'Task') && input.isolation === 'worktree') {
        return deny(
            "Agent isolation would create the subagent's worktree under .claude/worktrees/ on a branch that is not its folder name",
            `${addHint(repo, '<feature>')} with Bash, then start the subagent without isolation and name that path in its prompt`,
        );
    }
    return null;
}

function decide(payload) {
    const tool = payload.tool_name || payload.tool || '';
    const input = payload.tool_input || {};
    const cwd = input.cwd || payload.cwd || process.cwd();
    if (tool !== 'Bash') return checkTool(tool, input, cwd);
    const command = input.command || '';
    if (!command || INTENTIONAL.test(command)) return null;
    return checkBash(command, cwd);
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
    let reason = null;
    try {
        reason = decide(payload);
    } catch {
        return 0;
    }
    if (!reason) return 0;
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
        },
    }));
    return 0;
}

module.exports = { parseCommands, decide, layoutFeature, monorepo };

if (require.main === module) {
    process.exit(main());
}
