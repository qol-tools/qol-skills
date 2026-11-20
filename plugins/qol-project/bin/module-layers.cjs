'use strict';

const fs = require('node:fs');
const path = require('node:path');

const crateDirection = require('./crate-direction.cjs');
const rustCfg = require('./rust-cfg.cjs');
const serde = require('./rust-serde.cjs');
const toml = require('./toml-lite.cjs');

const SKILL = path.join(__dirname, '..', 'skills', 'qol-arch-code', 'SKILL.md');
const LAYER_BLOCK = /<!--\s*module-layers:start\s*-->([\s\S]*?)<!--\s*module-layers:end\s*-->/;
const LAYER_ROW = /^\|\s*(adapter|presentation|config|platform)\s*\|(.*)\|\s*$/gm;
const SECTION = 'qol-project:qol-arch-code, "Enforcement: module layers"';
const ROOT_FILES = new Set(['main.rs', 'lib.rs']);
const CONVENTIONS = path.join('libs', 'conventions', 'src');
const CONVENTIONS_BUILD = path.join(CONVENTIONS, 'build');
const ENV_CONST = /\bpub\s+const\s+(ENV_[A-Z0-9_]+)\s*:/g;
const RUSTC_ENV = /cargo:rustc-env=([A-Z_][A-Z0-9_]*)=/g;
const INLINE_MODULE = /(?<![\w$])pub\s+mod\s+([A-Za-z_]\w*)\s*\{/g;
const FREE_FN = /(?<![\w$])fn\s+([A-Za-z_]\w*)/g;
const ROOT_ITEM = /(?<![\w$'])(fn|struct|enum|trait|impl|static|union)(?![\w$])/g;
const ITEM_PREFIX = /(?:(?:pub(?:\s*\([^)]*\))?|unsafe|async|const|default|extern(?:\s*"[^"]*")?)\s+)*$/;
const DAEMON_ENV_PREFIX = 'ENV_DAEMON_';

let vocabularyCache;
const conventionsIndexes = new Map();
const libSourceCache = new Map();
const daemonModuleCache = new Map();
const workspaceIndexes = new Map();
const crateIndexes = new Map();

function readFile(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

function rustFiles(dir, found = []) {
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return found;
    }
    for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) rustFiles(full, found);
        else if (entry.name.endsWith('.rs')) found.push(full);
    }
    return found;
}

function parseVocabulary(text) {
    const block = LAYER_BLOCK.exec(text || '');
    if (!block) return null;
    const vocabulary = { adapter: new Set(), presentation: new Set(), config: new Set(), platform: new Set() };
    for (const row of block[1].matchAll(LAYER_ROW)) {
        for (const name of row[2].matchAll(/`([A-Za-z_]\w*)`/g)) vocabulary[row[1]].add(name[1]);
    }
    return Object.values(vocabulary).every(names => names.size > 0) ? vocabulary : null;
}

function vocabulary() {
    if (vocabularyCache === undefined) vocabularyCache = parseVocabulary(readFile(SKILL));
    return vocabularyCache;
}

function packageName(manifest) {
    const header = /^\[package\]\s*$/m.exec(manifest);
    if (!header) return null;
    const rest = manifest.slice(header.index + header[0].length);
    const next = /^\[/m.exec(rest);
    return (next ? rest.slice(0, next.index) : rest).match(/^\s*name\s*=\s*"([^"]+)"\s*$/m)?.[1] || null;
}

function crateOf(filePath) {
    let dir = path.dirname(path.resolve(filePath));
    for (let depth = 0; depth < 32; depth++) {
        const manifest = readFile(path.join(dir, 'Cargo.toml'));
        if (manifest !== null && /^\[package\]\s*$/m.test(manifest)) {
            const parts = path.relative(dir, path.resolve(filePath)).split(path.sep);
            if (parts[0] !== 'src' || parts.length < 2 || parts[1] === 'bin') return null;
            const workspace = crateDirection.workspaceRoot(dir);
            return {
                root: dir,
                workspace,
                ident: (packageName(manifest) || path.basename(dir)).replace(/-/g, '_'),
                parts: parts.slice(1),
                plugin: fs.existsSync(path.join(dir, 'plugin.toml')),
                app: Boolean(workspace) && path.relative(workspace, dir).split(path.sep)[0] === 'apps',
            };
        }
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
    return null;
}

function moduleSegments(parts) {
    if (parts.length === 1 && ROOT_FILES.has(parts[0])) return [];
    const last = parts[parts.length - 1];
    const head = parts.slice(0, -1);
    return last === 'mod.rs' ? head : [...head, last.replace(/\.rs$/, '')];
}

function layerOf(segments, names) {
    if (segments.length === 0) return 'root';
    const top = segments[0];
    if (names.adapter.has(top)) return 'adapter';
    if (names.presentation.has(top)) return 'presentation';
    if (segments.some(segment => names.platform.has(segment))) return 'platform';
    if (names.config.has(top)) return 'config';
    return 'capability';
}

function depthMap(text) {
    const depths = new Int32Array(text.length + 1);
    let depth = 0;
    for (let index = 0; index < text.length; index++) {
        depths[index] = depth;
        if ('{(['.includes(text[index])) depth++;
        else if ('})]'.includes(text[index])) depth = Math.max(0, depth - 1);
    }
    depths[text.length] = depth;
    return depths;
}

function closingBrace(text, open) {
    let depth = 0;
    for (let index = open; index < text.length; index++) {
        if (text[index] === '{') depth++;
        else if (text[index] === '}' && --depth === 0) return index;
    }
    return -1;
}

function groupHeads(text, open) {
    const close = closingBrace(text, open);
    if (close < 0) return [];
    const heads = [];
    let depth = 0;
    let from = open + 1;
    for (let index = open + 1; index <= close; index++) {
        const c = text[index];
        if (c === '{') depth++;
        else if (c === '}' && depth > 0) depth--;
        else if ((c === ',' && depth === 0) || index === close) {
            const head = /^\s*([A-Za-z_]\w*)/.exec(text.slice(from, index));
            if (head && head[1] !== 'self') heads.push({ name: head[1], index: from + head[0].length - head[1].length });
            from = index + 1;
        }
    }
    return heads;
}

function rootHeads(skeleton, at) {
    const rest = skeleton.slice(at);
    const group = /^\s*\{/.exec(rest);
    if (group) return groupHeads(skeleton, at + group[0].length - 1);
    const ident = /^\s*([A-Za-z_]\w*)/.exec(rest);
    return ident ? [{ name: ident[1], index: at + ident[0].length - ident[1].length }] : [];
}

function crateRootReferences(skeleton, segments) {
    const found = [];
    for (const match of skeleton.matchAll(/(?<![\w$:])crate\s*::/g)) {
        if (/\(\s*in\s+$/.test(skeleton.slice(Math.max(0, match.index - 16), match.index))) continue;
        found.push(...rootHeads(skeleton, match.index + match[0].length));
    }
    for (const match of skeleton.matchAll(/(?<![\w$:])((?:super\s*::\s*)+)/g)) {
        const climbs = (match[1].match(/super/g) || []).length;
        if (climbs < segments.length) continue;
        found.push(...rootHeads(skeleton, match.index + match[0].length));
    }
    return found;
}

function lineOf(starts, index) {
    return rustCfg.lineAt(starts, index);
}

function upwardImports(code, context, segments, names, starts) {
    const source = layerOf(segments, names);
    if (!context.plugin || !['platform', 'capability', 'config'].includes(source)) return [];
    const seen = new Set();
    const found = [];
    for (const head of crateRootReferences(code.skeleton, segments)) {
        if (!names.adapter.has(head.name) && !names.presentation.has(head.name)) continue;
        const line = lineOf(starts, head.index);
        if (seen.has(`${line}:${head.name}`)) continue;
        seen.add(`${line}:${head.name}`);
        const target = names.presentation.has(head.name) ? 'presentation' : 'adapter';
        found.push({
            rule: 'upward-import',
            line,
            text: `Upward module import in FILE: on line ${line}, a ${source} module reaches crate::${head.name}, the ${target} layer, which depends on it and not the other way round. Move what it needs down into a capability or config module that both can import, or pass it in from the adapter.`,
        });
    }
    return found;
}

function exposedPlatform(code, segments, names, starts) {
    if (segments.length === 0) return [];
    const found = [];
    const pattern = /(?<![\w$])pub(\s*\(\s*[^)]*\))?\s+mod\s+([A-Za-z_]\w*)\s*[;{]/g;
    for (const match of code.skeleton.matchAll(pattern)) {
        if (!names.platform.has(match[2])) continue;
        if (match[1] && /^\(\s*self\s*\)$/.test(match[1].trim())) continue;
        const line = lineOf(starts, match.index);
        found.push({
            rule: 'platform-visibility',
            line,
            text: `Exposed platform module in FILE: on line ${line}, \`${match[0].replace(/\s*[;{]$/, '').replace(/\s+/g, ' ')}\` lets other modules reach past the capability's facade into its OS code. Declare it \`mod ${match[2]};\` and re-export from the facade what callers need.`,
        });
    }
    return found;
}

function rootItems(code, fileName) {
    const depths = depthMap(code.skeleton);
    const items = [];
    for (const match of code.skeleton.matchAll(ROOT_ITEM)) {
        if (depths[match.index] !== 0) continue;
        const before = code.skeleton.slice(Math.max(0, match.index - 200), match.index).replace(ITEM_PREFIX, '').trimEnd();
        if (before && !';}]'.includes(before[before.length - 1])) continue;
        const name = match[1] === 'impl'
            ? /^\s*(?:<[^{]*?>)?\s*([^{]*?)\s*(?:where\b[^{]*)?\{/.exec(code.skeleton.slice(match.index + 4))?.[1]?.replace(/\s+/g, ' ') || ''
            : /^\s+(?:mut\s+)?([A-Za-z_]\w*)/.exec(code.skeleton.slice(match.index + match[1].length))?.[1];
        if (!name) continue;
        if (fileName === 'main.rs' && match[1] === 'fn' && name === 'main') continue;
        items.push({ kind: match[1], name, index: match.index });
    }
    return items;
}

function rootComposition(code, context, starts) {
    const fileName = context.parts[0];
    if (!(context.plugin || context.app) || context.parts.length !== 1 || !ROOT_FILES.has(fileName)) return [];
    return rootItems(code, fileName).map(item => {
        const line = lineOf(starts, item.index);
        const allowed = fileName === 'main.rs' ? '`fn main`, `mod`, `use` and `const`' : '`mod`, `use`, `pub use` and `const`';
        return {
            rule: 'root-composition',
            line,
            text: `Code in a crate root in FILE: on line ${line}, \`${item.kind} ${item.name}\` sits in ${fileName}, which composes the crate and holds only ${allowed}. Move it into the module that owns it and call it from there.`,
        };
    });
}

function conventionsIndex(workspace) {
    if (conventionsIndexes.has(workspace)) return conventionsIndexes.get(workspace);
    const envNames = new Set();
    const buildEnv = new Set();
    const routeModules = new Set();
    for (const file of rustFiles(path.join(workspace, CONVENTIONS))) {
        const content = readFile(file) || '';
        const code = serde.production(file, content);
        if (!code) continue;
        for (const match of code.skeleton.matchAll(ENV_CONST)) envNames.add(match[1]);
        if (file.startsWith(path.join(workspace, CONVENTIONS_BUILD) + path.sep)) {
            for (const string of code.strings) for (const match of string.value.matchAll(RUSTC_ENV)) buildEnv.add(match[1]);
        }
        for (const match of code.skeleton.matchAll(INLINE_MODULE)) {
            const open = match.index + match[0].length - 1;
            const close = closingBrace(code.skeleton, open);
            if (code.strings.some(string => string.start > open && string.start < close && string.value.startsWith('/api/'))) {
                routeModules.add(match[1]);
            }
        }
        const segments = moduleSegments(path.relative(path.join(workspace, CONVENTIONS), file).split(path.sep));
        if (segments.length > 0 && code.strings.some(string => string.value.startsWith('/api/'))) routeModules.add(segments[segments.length - 1]);
    }
    const index = { envNames, buildEnv, routeModules };
    conventionsIndexes.set(workspace, index);
    return index;
}

function freeFunctions(code) {
    const depths = depthMap(code.skeleton);
    const fns = [];
    for (const match of code.skeleton.matchAll(FREE_FN)) {
        if (depths[match.index] !== 0) continue;
        const open = code.skeleton.indexOf('{', match.index);
        const semi = code.skeleton.indexOf(';', match.index);
        if (open < 0 || (semi >= 0 && semi < open)) continue;
        const close = closingBrace(code.skeleton, open);
        if (close < 0) continue;
        fns.push({ name: match[1], index: match.index, open, close, body: code.skeleton.slice(open, close + 1) });
    }
    return fns;
}

function hostRoot(conventions) {
    const parts = [];
    if (conventions.envNames.size) parts.push(`\\b(?:${[...conventions.envNames].join('|')})\\b`);
    if (conventions.routeModules.size) parts.push(`\\b(?:${[...conventions.routeModules].join('|')})\\s*::`);
    return parts.length ? new RegExp(parts.join('|')) : null;
}

function localClosure(fns, seeds) {
    const host = new Set(seeds);
    for (let grew = host.size > 0; grew; ) {
        grew = false;
        const call = new RegExp(`(?<![\\w$.:])(?:${[...host].join('|')})\\s*\\(`);
        for (const fn of fns) {
            if (host.has(fn.name) || !call.test(fn.body)) continue;
            host.add(fn.name);
            grew = true;
        }
    }
    return host;
}

function reachingFunctions(entry, hits) {
    const seeds = entry.fns.filter(fn => hits.some(at => at > fn.open && at < fn.close)).map(fn => fn.name);
    return localClosure(entry.fns, seeds);
}

function rootHits(skeleton, root) {
    return root ? [...skeleton.matchAll(new RegExp(root.source, 'g'))].map(match => match.index) : [];
}

function parsedEntry(entry) {
    if (entry.fns) return entry;
    const code = serde.production(entry.file, entry.raw);
    entry.skeleton = code ? code.skeleton : '';
    entry.fns = code ? freeFunctions(code) : [];
    entry.leaves = code ? useLeaves(code.skeleton) : [];
    return entry;
}

function libSources(workspace) {
    if (libSourceCache.has(workspace)) return libSourceCache.get(workspace);
    const sources = [];
    const libs = path.join(workspace, 'libs');
    let crates = [];
    try {
        crates = fs.readdirSync(libs, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => path.join(libs, entry.name));
    } catch {}
    for (const crate of crates) {
        if (crate === path.join(workspace, 'libs', 'conventions')) continue;
        const manifest = readFile(path.join(crate, 'Cargo.toml'));
        const ident = manifest && packageName(manifest)?.replace(/-/g, '_');
        if (!ident) continue;
        for (const file of rustFiles(path.join(crate, 'src'))) {
            const parts = path.relative(path.join(crate, 'src'), file).split(path.sep);
            if (parts[0] === 'bin') continue;
            const raw = readFile(file);
            if (raw) sources.push({ ident, file, segments: moduleSegments(parts), raw });
        }
    }
    libSourceCache.set(workspace, sources);
    return sources;
}

function daemonModules(workspace) {
    if (daemonModuleCache.has(workspace)) return daemonModuleCache.get(workspace);
    const names = [...conventionsIndex(workspace).envNames].filter(name => name.startsWith(DAEMON_ENV_PREFIX));
    const modules = new Set();
    const pattern = names.length ? new RegExp(`\\b(?:${names.join('|')})\\b`) : null;
    for (const entry of pattern ? libSources(workspace) : []) {
        if (entry.segments.length === 0 || !pattern.test(entry.raw)) continue;
        if (pattern.test(parsedEntry(entry).skeleton)) modules.add(`${entry.ident}::${entry.segments[0]}`);
    }
    daemonModuleCache.set(workspace, modules);
    return modules;
}

function workspaceIndex(workspace) {
    if (workspaceIndexes.has(workspace)) return workspaceIndexes.get(workspace);
    const conventions = conventionsIndex(workspace);
    const root = hostRoot(conventions);
    const hostFns = [];
    const sources = root ? libSources(workspace) : [];
    const known = sources.filter(entry => root.test(entry.raw));
    const marked = new Set();
    const imported = entry => (leaf, fn) => libImport(leaf, fn) || (fn.ident === entry.ident && crateImport(leaf, fn));
    while (known.length) {
        for (let grew = true; grew; ) {
            grew = false;
            const matcher = hostMatcher(hostFns);
            for (const entry of known.map(parsedEntry)) {
                const hits = [...rootHits(entry.skeleton, root), ...callSites(entry.skeleton, matcher, entry.leaves, imported(entry), entry.file).map(site => site.index)];
                for (const name of reachingFunctions(entry, hits)) {
                    const key = `${entry.file}\0${name}`;
                    if (marked.has(key)) continue;
                    marked.add(key);
                    hostFns.push({
                        name,
                        file: entry.file,
                        ident: entry.ident,
                        segments: entry.segments,
                        owner: `${entry.ident}::${entry.segments.join('::')}`.replace(/::$/, ''),
                        qualifiers: new Set([entry.ident, ...entry.segments]),
                    });
                    grew = true;
                }
            }
        }
        const names = [...new Set(hostFns.map(fn => fn.name))];
        if (names.length === 0) break;
        const mention = new RegExp(`(?<![\\w$])(?:${names.join('|')})\\s*(?:\\(|::\\s*<)`);
        const fresh = sources.filter(entry => !known.includes(entry) && mention.test(entry.raw));
        if (fresh.length === 0) break;
        known.push(...fresh);
    }
    const index = { conventions, root, hostFns, matcher: hostMatcher(hostFns) };
    workspaceIndexes.set(workspace, index);
    return index;
}

function useLeaves(skeleton) {
    const leaves = [];
    for (const match of skeleton.matchAll(/(?<![\w$])use\s+/g)) {
        const start = match.index + match[0].length;
        let depth = 0;
        let end = start;
        for (; end < skeleton.length; end++) {
            if (skeleton[end] === '{') depth++;
            else if (skeleton[end] === '}' && --depth < 0) break;
            else if (skeleton[end] === ';' && depth === 0) break;
        }
        expandUse(skeleton, start, end, '', leaves);
    }
    return leaves;
}

function expandUse(text, start, end, prefix, leaves) {
    const open = text.indexOf('{', start);
    if (open < 0 || open >= end) {
        const leaf = (prefix + text.slice(start, end)).replace(/\s+as\s+[A-Za-z_]\w*\s*$/, '').replace(/\s+/g, '');
        if (leaf) leaves.push(leaf.replace(/^::/, ''));
        return;
    }
    const head = prefix + text.slice(start, open).replace(/\s+/g, '');
    let depth = 0;
    let from = open + 1;
    for (let index = open; index < end; index++) {
        if (text[index] === '{') depth++;
        else if (text[index] === '}' && --depth === 0) {
            if (text.slice(from, index).trim()) expandUse(text, from, index, head, leaves);
            break;
        } else if (text[index] === ',' && depth === 1) {
            if (text.slice(from, index).trim()) expandUse(text, from, index, head, leaves);
            from = index + 1;
        }
    }
}

function hostMatcher(fns) {
    const byName = new Map();
    for (const fn of fns) {
        if (!byName.has(fn.name)) byName.set(fn.name, []);
        byName.get(fn.name).push(fn);
    }
    const pattern = byName.size
        ? new RegExp(`(?<![\\w$])(?:([A-Za-z_]\\w*)\\s*::\\s*)?(${[...byName.keys()].join('|')})\\s*(?:::\\s*<[^>]*>\\s*)?\\(`, 'g')
        : null;
    return { byName, pattern };
}

function callSites(skeleton, matcher, leaves, isLocalImport, file = null) {
    if (!matcher.pattern) return [];
    const sites = [];
    for (const match of skeleton.matchAll(matcher.pattern)) {
        const before = skeleton.slice(Math.max(0, match.index - 8), match.index);
        if (/(?:\bfn|[.])\s*$/.test(before)) continue;
        const candidates = matcher.byName.get(match[2]).filter(fn => fn.file !== file);
        const hit = match[1]
            ? candidates.find(fn => fn.qualifiers.has(match[1]))
            : candidates.find(fn => leaves.some(leaf => isLocalImport(leaf, fn)));
        if (hit) sites.push({ index: match.index, fn: hit, spelled: match[0].replace(/\s*(?:::\s*<[^>]*>\s*)?\($/, '').replace(/\s+/g, '') });
    }
    return sites;
}

function libImport(leaf, fn) {
    return leaf.endsWith(`::${fn.name}`) && fn.qualifiers.has(leaf.split('::')[0]);
}

function crateIndex(context, names, index) {
    if (crateIndexes.has(context.root)) return crateIndexes.get(context.root);
    const src = path.join(context.root, 'src');
    const homes = new Set(['root', 'adapter', 'config', 'presentation']);
    const entries = [];
    for (const file of rustFiles(src)) {
        const parts = path.relative(src, file).split(path.sep);
        if (parts[0] === 'bin') continue;
        const segments = moduleSegments(parts);
        if (!homes.has(layerOf(segments, names))) continue;
        const raw = readFile(file);
        if (raw) entries.push(parsedEntry({ file, segments, raw }));
    }
    const hostFns = [];
    const marked = new Set();
    const lib = entries.map(entry => [...rootHits(entry.skeleton, index.root), ...callSites(entry.skeleton, index.matcher, entry.leaves, libImport).map(site => site.index)]);
    for (let grew = true; grew; ) {
        grew = false;
        const matcher = hostMatcher(hostFns);
        entries.forEach((entry, at) => {
            const hits = [...lib[at], ...callSites(entry.skeleton, matcher, entry.leaves, crateImport, entry.file).map(site => site.index)];
            for (const name of reachingFunctions(entry, hits)) {
                const key = `${entry.file}\0${name}`;
                if (marked.has(key)) continue;
                marked.add(key);
                hostFns.push({ name, file: entry.file, owner: `crate::${entry.segments.join('::')}`.replace(/::$/, ''), segments: entry.segments, qualifiers: new Set(entry.segments.length ? entry.segments : ['crate']) });
                grew = true;
            }
        });
    }
    const result = { hostFns, matcher: hostMatcher(hostFns) };
    crateIndexes.set(context.root, result);
    return result;
}

function crateImport(leaf, fn) {
    if (!leaf.endsWith(`::${fn.name}`)) return false;
    const head = leaf.slice(0, -fn.name.length - 2).split('::');
    const tail = fn.segments[fn.segments.length - 1];
    return head[0] === 'crate' ? head.slice(1).join('::') === fn.segments.join('::') : head[head.length - 1] === tail;
}

function hostCalls(filePath, code, context, segments, names, starts) {
    const source = layerOf(segments, names);
    if (!context.plugin || !context.workspace || !['platform', 'capability'].includes(source)) return [];
    const index = workspaceIndex(context.workspace);
    if (!index.root) return [];
    const found = [];
    const seen = new Set();
    const add = (at, what) => {
        const line = lineOf(starts, at);
        if (seen.has(`${line}:${what}`)) return;
        seen.add(`${line}:${what}`);
        found.push({
            rule: 'host-call',
            line,
            text: `Host call in a ${source} module in FILE: on line ${line}, ${what}. Host config, host env and calls to qol-tray belong to the adapter layer: read or call it there and pass the value in.`,
        });
    };
    const mentionsConventions = /\bqol_conventions\b/.test(code.skeleton);
    for (const match of code.skeleton.matchAll(/\b(ENV_[A-Z0-9_]+)\b/g)) {
        if (mentionsConventions && index.conventions.envNames.has(match[1])) add(match.index, `it reads qol_conventions::${match[1]}, which the host injects`);
    }
    for (const name of index.conventions.routeModules) {
        for (const match of code.skeleton.matchAll(new RegExp(`(?<![\\w$])${name}\\s*::`, 'g'))) {
            if (mentionsConventions) add(match.index, `it names a qol-tray API route through qol_conventions::${name}`);
        }
    }
    const leaves = useLeaves(code.skeleton);
    for (const site of callSites(code.skeleton, index.matcher, leaves, libImport)) {
        add(site.index, `\`${site.spelled}\` calls ${site.fn.owner}::${site.fn.name}, which reads what the host injects`);
    }
    const crate = crateIndex(context, names, index);
    for (const site of callSites(code.skeleton, crate.matcher, leaves, crateImport, path.resolve(filePath))) {
        add(site.index, `\`${site.spelled}\` calls ${site.fn.owner}::${site.fn.name}, which reads what the host injects`);
    }
    return found.sort((a, b) => a.line - b.line);
}

function manifestIds(crateRoot) {
    const ids = new Set();
    const tables = [['plugin.toml', ['action']], ['qol-runtime.toml', ['action', 'query']]];
    for (const [name, kinds] of tables) {
        const text = readFile(path.join(crateRoot, name));
        if (text === null) continue;
        let doc;
        try {
            doc = toml.parse(text);
        } catch {
            continue;
        }
        for (const kind of kinds) {
            const table = doc.value[kind];
            if (table && typeof table === 'object' && !Array.isArray(table)) for (const id of Object.keys(table)) ids.add(id);
        }
    }
    return ids;
}

function actionMatches(code, ids, starts) {
    if (ids.size === 0) return [];
    const found = [];
    for (const match of code.skeleton.matchAll(/(?<![\w$])match\b/g)) {
        const open = code.skeleton.indexOf('{', match.index);
        if (open < 0) continue;
        const close = closingBrace(code.skeleton, open);
        if (close < 0) continue;
        const depths = depthMap(code.skeleton.slice(open + 1, close));
        const named = new Set();
        for (const string of code.strings) {
            if (string.start <= open || string.end > close || depths[string.start - open - 1] !== 0) continue;
            if (!/^\s*(?:=>|\||if\b)/.test(code.skeleton.slice(string.end, string.end + 8))) continue;
            if (ids.has(string.value)) named.add(string.value);
        }
        if (named.size < 2) continue;
        const line = lineOf(starts, match.index);
        found.push({
            rule: 'action-table',
            line,
            text: `Plugin action table outside the adapter layer in FILE: on line ${line}, a match names the plugin's own action or query ids ${[...named].map(id => `"${id}"`).join(', ')}. The adapter parses an action id once into a typed command; this module takes that type.`,
        });
    }
    return found;
}

function daemonTransport(code, daemonModules, starts) {
    if (daemonModules.size === 0) return [];
    const found = [];
    const seen = new Set();
    const report = (index, module) => {
        const line = lineOf(starts, index);
        if (seen.has(line)) return;
        seen.add(line);
        found.push({
            rule: 'daemon-transport',
            line,
            text: `Daemon transport outside the adapter layer in FILE: on line ${line}, it reaches ${module}, the daemon socket the host launches the plugin with. Only the adapter layer runs or calls the daemon; this module takes typed commands from it.`,
        });
    };
    for (const module of daemonModules) {
        const [crate, top] = module.split('::');
        const direct = new RegExp(`(?<![\\w$])${crate}\\s*::\\s*${top}\\b`, 'g');
        for (const match of code.skeleton.matchAll(direct)) report(match.index, module);
        const group = new RegExp(`(?<![\\w$])${crate}\\s*::\\s*\\{`, 'g');
        for (const match of code.skeleton.matchAll(group)) {
            const heads = groupHeads(code.skeleton, match.index + match[0].length - 1);
            const head = heads.find(item => item.name === top);
            if (head) report(head.index, module);
        }
    }
    return found;
}

function adapterOnly(code, context, segments, names, starts) {
    if (!context.plugin || !context.workspace) return [];
    const source = layerOf(segments, names);
    if (source === 'root' || source === 'adapter') return [];
    return [...actionMatches(code, manifestIds(context.root), starts), ...daemonTransport(code, daemonModules(context.workspace), starts)];
}

function manifestEnvReads(code, context, segments, starts) {
    if (!context.workspace) return [];
    if (!/(?<![\w$])(?:option_)?env!/.test(code.skeleton)) return [];
    const names = conventionsIndex(context.workspace).buildEnv;
    if (names.size === 0) return [];
    const found = [];
    const counts = new Map();
    for (const string of code.strings) {
        if (!names.has(string.value)) continue;
        if (!/(?<![\w$])(?:option_)?env!\s*\(\s*$/.test(code.skeleton.slice(Math.max(0, string.start - 24), string.start))) continue;
        const count = (counts.get(string.value) || 0) + 1;
        counts.set(string.value, count);
        if (segments.length === 0 && count === 1) continue;
        const line = lineOf(starts, string.start);
        found.push({
            rule: 'manifest-env',
            line,
            text: segments.length === 0
                ? `Second read of ${string.value} in FILE: on line ${line}, the crate root reads env!("${string.value}") again. Read it once into one const and use that const.`
                : `Manifest value read outside the crate root in FILE: on line ${line}, env!("${string.value}") copies a value the build script takes from plugin.toml. Read it once in the crate root (\`pub(crate) const PLUGIN_ID: &str = env!("QOL_PLUGIN_ID");\` is the form) and use crate::<CONST> here.`,
        });
    }
    return found;
}

function findings(filePath, content) {
    if (!filePath.endsWith('.rs') || !content) return [];
    const names = vocabulary();
    if (!names) return [];
    const context = crateOf(filePath);
    if (!context) return [];
    const code = serde.production(path.resolve(filePath), content);
    if (!code) return [];
    const segments = moduleSegments(context.parts);
    const starts = rustCfg.lineStarts(content);
    const base = path.basename(filePath);
    return [
        ...upwardImports(code, context, segments, names, starts),
        ...exposedPlatform(code, segments, names, starts),
        ...rootComposition(code, context, starts),
        ...hostCalls(filePath, code, context, segments, names, starts),
        ...adapterOnly(code, context, segments, names, starts),
        ...manifestEnvReads(code, context, segments, starts),
    ].map(finding => ({ ...finding, message: `${finding.text.replace('FILE', base)}\n[qol-arch-code] fix it in this edit (${SECTION})` }));
}

function resetCaches() {
    vocabularyCache = undefined;
    conventionsIndexes.clear();
    libSourceCache.clear();
    daemonModuleCache.clear();
    workspaceIndexes.clear();
    crateIndexes.clear();
}

module.exports = { findings, parseVocabulary, layerOf, moduleSegments, resetCaches };
