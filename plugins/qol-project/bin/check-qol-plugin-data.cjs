#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const lintMode = require('./hook-lint-mode.cjs');
const { readExistingFile, prospectiveContent } = require('./hook-edit-content.cjs');
const { inQolRepo } = require('./qol-repo.cjs');
const rust = require('./rust-serde.cjs');

const INSPECTED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const MANIFEST = 'plugin.toml';
const RUST_SOURCE = /\.rs$/;
const SKILL_SECTION = 'qol-project:qol-arch-code, "Enforcement: plugin data guard"';

const OPENS_WITHOUT_LAUNCHER_ENTRY = new Set(['qol-launcher', 'qol-alt-tab']);
const IDENTITY_KEEPERS = ['libs/migrations/', 'libs/conventions/', 'libs/plugin-ids/'];
const IDENTITY_CONSTANTS = { id: 'ID', uid: 'UID', socket: 'SOCKET_NAME', port: 'PORT' };
const INTEGER_LITERAL = /(?<![\w.])(\d[\d_]*)(?:[ui](?:8|16|32|64|128|size))?(?![\w.])/g;

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function parseValue(text) {
    const quoted = /^"([^"]*)"/.exec(text);
    if (quoted) return quoted[1];
    if (/^true\b/.test(text)) return true;
    if (/^false\b/.test(text)) return false;
    return text;
}

function parseManifest(content) {
    const manifest = { plugin: null, actions: new Map(), shortcuts: [], launcher: false, daemon: null };
    let table = null;
    content.split(/\r?\n/).forEach((raw, index) => {
        const line = raw.trim();
        const header = /^(\[\[?)\s*([^\]]+?)\s*\]\]?$/.exec(line);
        if (header) {
            const name = header[2];
            const array = header[1] === '[[';
            table = { line: index + 1, values: {}, lines: {} };
            const action = /^action\.(?:"([^"]+)"|([\w-]+))$/.exec(name);
            if (array && name === 'shortcuts') manifest.shortcuts.push(table);
            else if (array) return;
            else if (name === 'plugin') manifest.plugin = table;
            else if (name === 'launcher') manifest.launcher = true;
            else if (name === 'daemon') manifest.daemon = table;
            else if (action) manifest.actions.set(action[1] ?? action[2], table);
            return;
        }
        const pair = /^([\w-]+)\s*=\s*(.+)$/.exec(line);
        if (pair && table) {
            table.values[pair[1]] = parseValue(pair[2].trim());
            table.lines[pair[1]] = index + 1;
        }
    });
    return manifest;
}

function reachesOpenFromLauncher(manifest) {
    if (manifest.launcher) return true;
    return manifest.shortcuts.some(shortcut =>
        (shortcut.values.action ?? 'open') === 'open' && shortcut.values.export_to_launcher !== false);
}

function daemonPort(manifest) {
    const port = manifest.daemon?.values.port;
    return typeof port === 'string' && /^\d+$/.test(port) ? port : null;
}

function readManifest(file) {
    try {
        return parseManifest(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

function portOwners(dir, port) {
    const parent = path.dirname(dir);
    let entries;
    try {
        entries = fs.readdirSync(parent, { withFileTypes: true });
    } catch {
        return [];
    }
    return entries
        .filter(entry => entry.isDirectory() && path.join(parent, entry.name) !== dir)
        .map(entry => ({ folder: entry.name, manifest: readManifest(path.join(parent, entry.name, MANIFEST)) }))
        .filter(({ manifest }) => manifest?.plugin && daemonPort(manifest) === port)
        .map(({ folder, manifest }) => manifest.plugin.values.id ?? folder)
        .sort();
}

function dataGaps(content, dir) {
    if (!content) return [];
    const manifest = parseManifest(content);
    if (!manifest.plugin) return [];
    const gaps = [];
    const open = manifest.actions.get('open');
    const runs = open && (open.values.kind ?? 'run') === 'run';
    if (runs && !OPENS_WITHOUT_LAUNCHER_ENTRY.has(manifest.plugin.values.id) && !reachesOpenFromLauncher(manifest)) {
        gaps.push({
            rule: 'launcher',
            text: `Open action has no launcher entry in ${MANIFEST}: line ${open.line} declares [action.open], but no [[shortcuts]] entry exports it and there is no [launcher] flow, so the launcher cannot start this plugin and only its Open row in qol settings can. Add [[shortcuts]] with id = "open", name = "<what the launcher lists>", action = "open", export_to_launcher = true.`,
        });
    }
    const settings = [...manifest.actions.values()].some(action => action.values.kind === 'settings');
    if (!settings && fs.existsSync(path.join(dir, 'qol-config.toml'))) {
        gaps.push({
            rule: 'settings',
            text: `Settings contract has no settings action in ${MANIFEST}: line ${manifest.plugin.line} starts a plugin that ships qol-config.toml but declares no action with kind = "settings", so the launcher lists no "Settings > ${manifest.plugin.values.name ?? 'plugin'}" entry. Add [action.settings] with label = "Settings", kind = "settings", args = ["--settings"], and the tray hosts that page itself.`,
        });
    }
    const port = daemonPort(manifest);
    const owners = port ? portOwners(dir, port) : [];
    if (owners.length > 0) {
        gaps.push({
            rule: 'port',
            text: `Daemon port is taken in ${MANIFEST}: line ${manifest.daemon.lines.port} sets [daemon] port = ${port}, which ${owners.join(', ')} already declares, so whichever daemon starts second cannot bind it. Pick a port no other plugin.toml declares.`,
            hint: 'give this daemon a free port in this edit',
        });
    }
    return gaps;
}

function isDirectory(dir) {
    try {
        return fs.statSync(dir).isDirectory();
    } catch {
        return false;
    }
}

const identityRoots = new Map();

function identityRoot(file) {
    const start = path.dirname(file);
    if (identityRoots.has(start)) return identityRoots.get(start);
    let root = null;
    for (let dir = start; ; dir = path.dirname(dir)) {
        if (fs.existsSync(path.join(dir, '.git')) && isDirectory(path.join(dir, 'plugins'))) {
            root = dir;
            break;
        }
        if (path.dirname(dir) === dir) break;
    }
    identityRoots.set(start, root);
    return root;
}

function manifestIdentities(folder, manifest) {
    if (!manifest?.plugin) return [];
    const socket = manifest.daemon?.values.socket;
    const module = folder.replace(/-/g, '_');
    return [
        ['id', manifest.plugin.values.id],
        ['uid', manifest.plugin.values.uid],
        ['socket', typeof socket === 'string' ? path.posix.basename(socket) : null],
        ['port', daemonPort(manifest)],
    ]
        .filter(([, value]) => typeof value === 'string' && value !== '')
        .map(([kind, value]) => ({
            kind,
            value,
            folder,
            module,
            within: kind === 'port' ? new RegExp(`(?<![\\w.])${value}(?![\\w.])`) : null,
        }));
}

const identitiesByRoot = new Map();

function identities(root) {
    if (identitiesByRoot.has(root)) return identitiesByRoot.get(root);
    const plugins = path.join(root, 'plugins');
    let folders = [];
    try {
        folders = fs.readdirSync(plugins, { withFileTypes: true })
            .filter(entry => entry.isDirectory())
            .map(entry => entry.name)
            .sort();
    } catch {}
    const entries = folders.flatMap(folder => manifestIdentities(folder, readManifest(path.join(plugins, folder, MANIFEST))));
    identitiesByRoot.set(root, entries);
    return entries;
}

function mentionsIdentity(content, entries) {
    let digits = null;
    return entries.some(entry => {
        if (entry.kind !== 'port') return content.includes(entry.value);
        digits ??= content.replace(/(?<=\d)_(?=\d)/g, '');
        return digits.includes(entry.value);
    });
}

function literalVerb(entry, text) {
    if (text === entry.value) return 'is';
    if (entry.kind === 'socket' && text.endsWith(`/${entry.value}`)) return 'holds';
    if (entry.within?.test(text)) return 'holds';
    return null;
}

function foreignMatch(rel, matches) {
    if (matches.length === 0) return null;
    if (matches.some(({ entry }) => rel.startsWith(`plugins/${entry.folder}/`))) return null;
    return matches[0];
}

function identityHits(rel, code, entries) {
    const hits = [];
    for (const literal of code.strings) {
        const matches = entries
            .map(entry => ({ entry, verb: literalVerb(entry, literal.value) }))
            .filter(({ verb }) => verb !== null);
        const match = foreignMatch(rel, matches);
        if (match) hits.push({ ...match, start: literal.start, shown: JSON.stringify(literal.value) });
    }
    const ports = entries.filter(entry => entry.kind === 'port');
    for (const token of code.skeleton.matchAll(INTEGER_LITERAL)) {
        const digits = token[1].replace(/_/g, '');
        const matches = ports.filter(entry => entry.value === digits).map(entry => ({ entry, verb: 'is' }));
        const match = foreignMatch(rel, matches);
        if (match) hits.push({ ...match, start: token.index, shown: token[0] });
    }
    return hits.sort((left, right) => left.start - right.start);
}

function lineOf(content, offset) {
    let line = 1;
    for (let index = content.indexOf('\n'); index !== -1 && index < offset; index = content.indexOf('\n', index + 1)) line++;
    return line;
}

function identityGaps(filePath, content) {
    if (!content) return [];
    const file = path.resolve(filePath);
    const root = identityRoot(file);
    if (!root) return [];
    const rel = path.relative(root, file).split(path.sep).join('/');
    if (IDENTITY_KEEPERS.some(prefix => rel.startsWith(prefix))) return [];
    const entries = identities(root);
    if (!mentionsIdentity(content, entries)) return [];
    const code = rust.production(file, content);
    if (!code) return [];
    return identityHits(rel, code, entries).map(({ entry, verb, start, shown }) => ({
        rule: 'identity',
        text: `Plugin identity typed by hand in ${path.basename(file)}: on line ${lineOf(content, start)}, ${shown} ${verb} the ${entry.folder} plugin's ${entry.kind} typed by hand; use qol_plugin_ids::${entry.module}::${IDENTITY_CONSTANTS[entry.kind]} instead.`,
        hint: 'take it from the generated qol-plugin-ids crate in this edit',
    }));
}

function gapsFor(filePath, content) {
    if (path.basename(filePath) === MANIFEST) return dataGaps(content, path.dirname(filePath));
    return identityGaps(filePath, content);
}

function reason(gap) {
    return `${gap.text}\n[qol-plugin-data] ${gap.hint ?? 'ship the missing entry in this edit'} (${SKILL_SECTION})`;
}

function deny(gaps) {
    if (lintMode.active()) {
        for (const gap of gaps) lintMode.report(process.stderr, reason(gap));
        return;
    }
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: gaps.map(reason).join('\n\n'),
        },
    }) + '\n');
}

function evaluate(payload) {
    const tool = payload.tool_name || '';
    if (!INSPECTED_TOOLS.has(tool)) return 0;
    const input = payload.tool_input || {};
    const filePath = input.file_path || '';
    const inspected = path.basename(filePath) === MANIFEST || RUST_SOURCE.test(filePath);
    if (!inspected || !inQolRepo(filePath)) return 0;
    const gaps = gapsFor(filePath, prospectiveContent(tool, input, readExistingFile(filePath)));
    if (gaps.length === 0) return 0;
    deny(gaps);
    return 2;
}

function main() {
    let payload;
    try {
        payload = JSON.parse(readStdin() || '{}');
    } catch {
        return;
    }
    evaluate(payload);
}

function lintFile(filePath, content, baseline = null) {
    return lintMode.run(filePath, () => evaluate({
        tool_name: 'Write',
        tool_input: { file_path: filePath, content },
    }), baseline);
}

module.exports = { lintFile };

if (require.main === module) {
    try {
        main();
    } catch {}
    process.exit(0);
}
