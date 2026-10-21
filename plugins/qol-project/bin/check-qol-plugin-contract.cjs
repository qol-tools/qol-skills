#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const lintMode = require('./hook-lint-mode.cjs');
const { inQolRepo } = require('./qol-repo.cjs');
const toml = require('./toml-lite.cjs');
const rust = require('./rust-serde.cjs');

const INSPECTED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit']);
const CONTRACT_TYPES = {
    'plugin.toml': 'PluginManifest',
    'qol-config.toml': 'ConfigSpecV1',
    'qol-runtime.toml': 'RuntimeSpec',
};
const SCHEMA_DIRS = ['libs/plugin-api/src', 'libs/config/src', 'libs/conventions/src', 'libs/platform/src'];
const MARK_DIR = 'libs/theme/src';
const READER_DIRS = ['apps', 'libs'];
const LISTED = ['apps', 'libs', 'plugins', 'Cargo.toml'];
const ROOT_MARKER = path.join('libs', 'plugin-api', 'Cargo.toml');
const EXECUTABLE_KINDS = new Set(['run', 'settings']);
const DOCTOR_WIRING = /\.\s*doctor_(?:check|checks|provider|aggregate_provider)\s*\(/;
const UNSTORED_FALLBACK = { unstored: ['action', 'list', 'status', 'qr_code', 'gamepad', 'display_layout'], exceptions: [{ kind: 'number', field: 'active_query' }] };
const SEPARATORS = new Set(['_', '-', ' ', ':', '.', '/']);
const CONTRACT_PATH = /^(plugins\/[^/]+)\/(?:plugin|qol-config|qol-runtime)\.toml$/;
const SOURCE_PATH = /^(plugins\/[^/]+)\/(?:src\/.+\.rs|Cargo\.toml)$/;
const CANDIDATE_PATH = /[\\/]plugins[\\/][^\\/]+[\\/](?:plugin\.toml|qol-config\.toml|qol-runtime\.toml|Cargo\.toml|src[\\/].+\.rs)$|[\\/]libs[\\/](?:plugin-api|config|conventions|platform|theme)[\\/]src[\\/].+\.rs$/;
const SKILL = 'qol-tray:qol-tray-core, "Contracts are honoured to the letter"';
const MAX_LISTED = 12;
const CACHE_SLACK = 4;

const RULES = {
    parse: ['Contract does not parse', 'fix the TOML syntax'],
    schema: ['Contract struct is missing', 'teach the lint the struct that now parses this file'],
    unknown: ['Key is not part of the contract', 'fix the key against the Rust struct named here, or add the field to that struct and make the code use it'],
    type: ['Value has the wrong type', 'give the value the type the Rust struct declares'],
    missing: ['Required key is missing', 'add the key the Rust struct requires'],
    variant: ['Value is not an allowed name', 'use a name the Rust enum accepts'],
    unread: ['Key is accepted but nothing reads it', 'make the code read the field, or delete it from the struct and from every TOML'],
    target: ['Action has no execution target', 'give the plugin an enabled [daemon] socket or a [runtime] command, or delete the action'],
    dispatch: ['Action is never dispatched', 'handle this token in the plugin before declaring the action, or delete the action'],
    shortcut: ['Shortcut runs no declared action', 'point the shortcut at a run or settings [action.*] id'],
    duplicate: ['Shortcut id is declared twice', 'give every [[shortcuts]] entry its own id'],
    binary: ['Command is not built by this plugin', "name a binary the plugin's Cargo.toml builds"],
    icon: ['Icon names no mark', 'use a qol_theme::Mark name from libs/theme, or draw the mark there'],
    doctor: ['Doctor capability does not match the code', 'register doctor checks on the HeadlessApp, or set [capabilities] doctor to match the code'],
    menu: ['Menu items are ignored', 'delete the entry, or declare it as an [action.*] table the tray runs'],
    sectionAction: ['Section lists an undeclared action', 'list run or settings [action.*] ids from plugin.toml'],
    toggle: ['Toggle action names no stored setting', 'point config_key at a stored qol-config.toml field'],
    scope: ['Config scope names no stored setting', 'scope a stored qol-config.toml key or one of its parent paths'],
    binding: ['Setting is never read by the plugin', "read the key through a field of the plugin's Deserialize config struct before declaring it, or delete the setting"],
    unhandled: ['Runtime entry is never handled', "handle the id in the plugin's dispatch before declaring it, or delete it from qol-runtime.toml"],
};

function isTable(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function relative(root, file) {
    return path.relative(root, file).split(path.sep).join('/');
}

function sha1(text) {
    return crypto.createHash('sha1').update(text).digest('hex');
}

function parseToml(text) {
    if (text === null) return null;
    try {
        return toml.parse(text).value;
    } catch {
        return null;
    }
}

function git(root, args) {
    const result = spawnSync('git', ['-C', root, '--no-optional-locks', ...args], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
    });
    return result.status === 0 ? result.stdout.split('\0').filter(Boolean) : [];
}

function listing(root) {
    const shas = new Map();
    for (const line of git(root, ['ls-files', '-z', '-s', '--', ...LISTED])) {
        const tab = line.indexOf('\t');
        const [, sha, stage] = line.slice(0, tab).split(' ');
        shas.set(line.slice(tab + 1), stage === '0' ? sha : null);
    }
    const status = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', ...LISTED]);
    for (let index = 0; index < status.length; index++) {
        const code = status[index].slice(0, 2);
        const file = status[index].slice(3);
        if (/[RC]/.test(code[0])) index++;
        if (code.includes('D')) shas.delete(file);
        else shas.set(file, null);
    }
    return { shas, files: [...shas.keys()].sort() };
}

function lintVersion() {
    const hash = crypto.createHash('sha1');
    for (const file of [__filename, require.resolve('./rust-serde.cjs')]) hash.update(fs.readFileSync(file));
    return hash.digest('hex');
}

const cache = { file: null, version: null, entries: null, added: 0, fresh: new Set() };

function cacheEntries() {
    if (cache.entries) return cache.entries;
    cache.file = path.join(os.tmpdir(), 'qol-plugin-contract', 'facts.json');
    cache.version = lintVersion();
    cache.entries = new Map();
    try {
        const stored = JSON.parse(fs.readFileSync(cache.file, 'utf8'));
        if (stored.version === cache.version) cache.entries = new Map(Object.entries(stored.entries));
    } catch {}
    return cache.entries;
}

function saveCache(repo) {
    if (!cache.added) return;
    let entries = cache.entries;
    const tree = repo.tree();
    if (entries.size > CACHE_SLACK * tree.files.length) {
        const live = new Set(tree.files.map(file => `${file}\0${tree.shas.get(file)}`));
        entries = new Map([...entries].filter(([key]) => live.has(key) || cache.fresh.has(key)));
    }
    const temporary = `${cache.file}.${process.pid}.tmp`;
    try {
        fs.mkdirSync(path.dirname(cache.file), { recursive: true });
        fs.writeFileSync(temporary, JSON.stringify({ version: cache.version, entries: Object.fromEntries(entries) }));
        fs.renameSync(temporary, cache.file);
        cache.added = 0;
    } catch {
        try {
            fs.unlinkSync(temporary);
        } catch {}
    }
}

function functionBodies(skeleton, name) {
    const bodies = [];
    for (const match of skeleton.matchAll(new RegExp(`\\bfn\\s+${name}\\s*\\(`, 'g'))) {
        const open = skeleton.indexOf('{', match.index);
        if (open >= 0) bodies.push([open, rust.matchForward(skeleton, open)]);
    }
    return bodies;
}

function storageRules(skeleton) {
    let kinds = null;
    let negated = false;
    const exceptions = [];
    for (const [start, end] of functionBodies(skeleton, 'has_stored_value')) {
        const body = skeleton.slice(start, end);
        const named = [...body.matchAll(/\bSelf::(\w+)/g)].map(match => match[1]);
        if (named.length && !kinds) {
            kinds = named;
            negated = /!\s*matches!\s*\(/.test(body);
        }
        for (const match of body.matchAll(/\b\w+::(\w+)\s*&&\s*self\.(\w+)\.is_some\(\)/g)) exceptions.push({ kind: match[1], field: match[2] });
    }
    return kinds ? { kinds, negated, exceptions } : null;
}

function fileFacts(rel, content) {
    const lexed = rust.production(rel, content);
    if (!lexed) return null;
    const facts = {
        strings: [...new Set(lexed.strings.map(string => string.value))],
        reads: [...rust.fieldReads([{ file: rel, lexed }])],
        items: rust.fileItems(rel, lexed),
        doctor: DOCTOR_WIRING.test(lexed.skeleton),
    };
    if (/\bfn\s+from_name\b/.test(lexed.skeleton)) {
        const [body] = functionBodies(lexed.skeleton, 'name');
        if (body) facts.marks = lexed.strings.filter(string => string.start > body[0] && string.start < body[1]).map(string => string.value);
    }
    const storage = storageRules(lexed.skeleton);
    if (storage) facts.storage = storage;
    return facts;
}

function diskFacts(repo, rel) {
    const sha = repo.tree().shas.get(rel);
    let content;
    let key;
    if (sha) {
        key = `${rel}\0${sha}`;
    } else {
        content = repo.read(rel);
        if (content === null) return null;
        key = `${rel}\0c${sha1(content)}`;
    }
    const entries = cacheEntries();
    cache.fresh.add(key);
    if (entries.has(key)) return entries.get(key);
    if (content === undefined) content = repo.read(rel);
    const facts = content === null ? null : fileFacts(rel, content);
    entries.set(key, facts);
    cache.added++;
    return facts;
}

function invalidates(file, key) {
    if (key === 'reads') return /^(?:apps|libs)\//.test(file);
    if (key === 'schema' || key === 'storage') return SCHEMA_DIRS.some(dir => file.startsWith(`${dir}/`));
    if (key === 'marks') return file.startsWith(`${MARK_DIR}/`);
    if (key === 'workspace') return file === 'Cargo.toml';
    if (key.startsWith('plugin:')) return file.startsWith(`${key.slice(7)}/`) || file.startsWith('libs/') || file === 'Cargo.toml';
    return true;
}

function createRepo(root, overrides = new Map(), base = null) {
    const contents = new Map();
    const listings = new Map();
    const memos = new Map();
    const facts = new Map();
    const overridden = [...overrides.keys()].map(file => relative(root, file));
    let tree = null;
    const repo = {
        root,
        tree() {
            if (base) return base.tree();
            if (!tree) tree = listing(root);
            return tree;
        },
        read(rel) {
            const absolute = path.join(root, rel);
            if (overrides.has(absolute)) return overrides.get(absolute);
            if (base) return base.read(rel);
            if (!contents.has(rel)) {
                let text = null;
                try {
                    text = fs.readFileSync(absolute, 'utf8');
                } catch {}
                contents.set(rel, text);
            }
            return contents.get(rel);
        },
        list(dir) {
            if (base) {
                const listed = base.list(dir);
                const extra = overridden.filter(file => file.startsWith(`${dir}/`) && !listed.includes(file));
                return extra.length ? [...listed, ...extra] : listed;
            }
            if (!listings.has(dir)) listings.set(dir, repo.tree().files.filter(file => file.startsWith(`${dir}/`)));
            return listings.get(dir);
        },
        facts(rel) {
            const absolute = path.join(root, rel);
            if (overrides.has(absolute)) {
                if (!facts.has(rel)) facts.set(rel, fileFacts(rel, overrides.get(absolute)));
                return facts.get(rel);
            }
            if (base) return base.facts(rel);
            if (!facts.has(rel)) facts.set(rel, diskFacts(repo, rel));
            return facts.get(rel);
        },
        memo(key, compute) {
            if (base && !overridden.some(file => invalidates(file, key))) return base.memo(key, compute);
            if (!memos.has(key)) memos.set(key, compute());
            return memos.get(key);
        },
    };
    return repo;
}

const baseRepos = new Map();

function repoFor(root, overrides = new Map()) {
    if (!baseRepos.has(root)) baseRepos.set(root, createRepo(root));
    const base = baseRepos.get(root);
    return overrides.size ? createRepo(root, overrides, base) : base;
}

function rustFiles(repo, dir) {
    return repo.list(dir).filter(file => file.endsWith('.rs') && !rust.TEST_FILE.test(file));
}

function factsIn(repo, files) {
    return files.map(file => repo.facts(file)).filter(Boolean);
}

function contractSchema(repo) {
    return repo.memo('schema', () => rust.schemaOf(factsIn(repo, SCHEMA_DIRS.flatMap(dir => rustFiles(repo, dir))).map(facts => facts.items)));
}

function readers(repo) {
    return repo.memo('reads', () => {
        const fields = new Set();
        const strings = new Set();
        for (const facts of factsIn(repo, READER_DIRS.flatMap(dir => rustFiles(repo, dir)))) {
            for (const name of facts.reads) fields.add(name);
            for (const value of facts.strings) strings.add(value);
        }
        return { fields, strings };
    });
}

function markNames(repo) {
    return repo.memo('marks', () => {
        const owner = factsIn(repo, rustFiles(repo, MARK_DIR)).find(facts => facts.marks);
        return owner ? new Set(owner.marks) : null;
    });
}

function storage(repo) {
    return repo.memo('storage', () => {
        const kind = rust.lookup(contractSchema(repo), 'FieldKind');
        const rules = kind?.kind === 'enum' ? repo.facts(kind.file)?.storage : null;
        if (!rules) return { unstored: new Set(UNSTORED_FALLBACK.unstored), exceptions: UNSTORED_FALLBACK.exceptions };
        const wire = name => {
            const variant = kind.variants.find(entry => entry.rust === name);
            return variant ? rust.variantWire(variant, kind.renameAll) : name;
        };
        const listed = new Set(rules.kinds);
        return {
            unstored: new Set(kind.variants.filter(variant => rules.negated === listed.has(variant.rust)).map(variant => rust.variantWire(variant, kind.renameAll))),
            exceptions: rules.exceptions.map(exception => ({ kind: wire(exception.kind), field: exception.field })),
        };
    });
}

function isStored(repo, field) {
    if (!isTable(field) || typeof field.type !== 'string') return false;
    const { unstored, exceptions } = storage(repo);
    if (unstored.has(field.type)) return false;
    return !exceptions.some(exception => exception.kind === field.type && field[exception.field] !== undefined);
}

function pathDependencies(repo, dir, cargo) {
    const workspace = repo.memo('workspace', () => parseToml(repo.read('Cargo.toml')) ?? {});
    const shared = isTable(workspace.workspace?.dependencies) ? workspace.workspace.dependencies : {};
    const tables = [cargo.dependencies, ...Object.values(isTable(cargo.target) ? cargo.target : {}).map(target => target?.dependencies)];
    const found = new Set();
    for (const table of tables) {
        if (!isTable(table)) continue;
        for (const [name, spec] of Object.entries(table)) {
            if (!isTable(spec)) continue;
            if (typeof spec.path === 'string') found.add(path.posix.normalize(path.posix.join(dir, spec.path)));
            else if (spec.workspace === true && typeof shared[name]?.path === 'string') found.add(path.posix.normalize(shared[name].path));
        }
    }
    return [...found];
}

function binaries(dir, cargo, files) {
    const bins = new Set((Array.isArray(cargo.bin) ? cargo.bin : []).map(bin => bin?.name).filter(name => typeof name === 'string'));
    const name = cargo.package?.name;
    if (typeof name === 'string' && files.includes(`${dir}/src/main.rs`)) bins.add(name);
    if (cargo.package?.autobins !== false) {
        for (const file of files) {
            const match = /^src\/bin\/([^/]+?)(?:\.rs|\/main\.rs)$/.exec(file.slice(dir.length + 1));
            if (match) bins.add(match[1]);
        }
    }
    return bins;
}

function pluginFacts(repo, dir) {
    return repo.memo(`plugin:${dir}`, () => {
        const cargo = parseToml(repo.read(`${dir}/Cargo.toml`)) ?? {};
        const own = factsIn(repo, rustFiles(repo, `${dir}/src`));
        const deps = factsIn(repo, pathDependencies(repo, dir, cargo).flatMap(dep => rustFiles(repo, `${dep}/src`)));
        const all = [...own, ...deps];
        const strings = new Set();
        const reads = new Set();
        for (const facts of all) {
            for (const value of facts.strings) strings.add(value);
            for (const name of facts.reads) reads.add(name);
        }
        return {
            bins: binaries(dir, cargo, repo.list(`${dir}/src`)),
            strings,
            ownStrings: new Set(own.flatMap(facts => facts.strings)),
            reads,
            schema: rust.schemaOf(all.map(facts => facts.items)),
            doctorWired: own.some(facts => facts.doctor),
        };
    });
}

function mentions(strings, token) {
    if (strings.has(token)) return true;
    for (let at = 1; at < token.length; at++) {
        if (!strings.has(token.slice(0, at))) continue;
        if (strings.has(token.slice(at))) return true;
        if (SEPARATORS.has(token[at]) && strings.has(token.slice(at + 1))) return true;
    }
    return false;
}

function finding(file, line, rule, subject, detail) {
    return { file, line: line || 1, rule, subject, detail };
}

function stableSubject(tomlPath) {
    return tomlPath.replace(/\[\d+\]/g, '[]');
}

function schemaFindings(repo, doc, typeName) {
    const result = rust.checkDocument(contractSchema(repo), typeName, doc.value);
    if (!result) {
        return [finding(doc.file, 1, 'schema', typeName, `no Deserialize struct named ${typeName} exists under ${SCHEMA_DIRS.join(', ')}, so nothing checks this file`)];
    }
    const out = [];
    const fatal = 'so the tray refuses the whole file';
    const at = problem => (problem.table ? toml.keyLine(doc.lines, problem.table, problem.key) : 1);
    for (const problem of result.problems) {
        if (problem.kind === 'unknown') {
            out.push(finding(doc.file, at(problem), 'unknown', stableSubject(problem.path), `${problem.path} is not a field of ${problem.owner.name}, ${problem.strict ? fatal : 'so serde drops it and it does nothing'}`));
        } else if (problem.kind === 'type') {
            out.push(finding(doc.file, at(problem), 'type', stableSubject(problem.path || ''), `${problem.path || 'the file'} must be ${problem.expected}, not ${problem.actual}, ${fatal}`));
        } else if (problem.kind === 'missing') {
            const where = problem.path ? `${problem.path}.${problem.missing}` : problem.missing;
            out.push(finding(doc.file, at(problem), 'missing', stableSubject(where), `${where} is required by ${problem.owner.name}, ${fatal}`));
        } else if (problem.kind === 'variant') {
            out.push(finding(doc.file, at(problem), 'variant', stableSubject(problem.path), `${problem.path} = ${JSON.stringify(problem.actual)} is not one of ${problem.allowed.join(', ')}, ${fatal}`));
        }
    }
    const { fields, strings } = readers(repo);
    for (const use of result.used) {
        const line = toml.keyLine(doc.lines, use.table, use.key);
        if (use.swallowed) {
            if (!(fields.has(use.field.rust) && strings.has(use.key))) {
                out.push(finding(doc.file, line, 'unknown', stableSubject(use.path), `${use.path} is not a field of ${use.owner.name}; it lands in ${use.owner.name}.${use.field.rust}, and no code looks up "${use.key}" there`));
            }
        } else if (!fields.has(use.field.rust)) {
            out.push(finding(doc.file, line, 'unread', stableSubject(use.path), `${use.path} sets ${use.owner.name}.${use.field.rust}, which no code outside tests reads`));
        }
    }
    return out;
}

function executableIds(manifest) {
    const actions = isTable(manifest.action) ? manifest.action : {};
    const ids = new Set();
    if (Object.keys(actions).length) {
        for (const [id, action] of Object.entries(actions)) {
            if (isTable(action) && EXECUTABLE_KINDS.has(action.kind ?? 'run')) ids.add(id);
        }
        return ids;
    }
    const walk = items => {
        for (const item of Array.isArray(items) ? items : []) {
            if (!isTable(item)) continue;
            if (item.type === 'action' && typeof item.id === 'string') ids.add(item.id);
            if (item.type === 'submenu') walk(item.items);
        }
    };
    walk(isTable(manifest.menu) ? manifest.menu.items : []);
    return ids;
}

function checkboxIds(items) {
    const ids = [];
    for (const item of items) {
        if (!isTable(item)) continue;
        if (item.type === 'checkbox') ids.push(item.id);
        if (item.type === 'submenu' && Array.isArray(item.items)) ids.push(...checkboxIds(item.items));
    }
    return ids;
}

function storedKeys(repo, configDoc) {
    const keys = new Set();
    if (!configDoc || !isTable(configDoc.value) || !isTable(configDoc.value.field)) return keys;
    for (const [id, field] of Object.entries(configDoc.value.field)) {
        if (isStored(repo, field)) keys.add(typeof field.config_key === 'string' ? field.config_key : id);
    }
    return keys;
}

function routesFor(id, action, manifest, socket) {
    const runtime = isTable(manifest.runtime) ? manifest.runtime : null;
    const command = typeof runtime?.command === 'string' ? runtime.command : null;
    const daemon = isTable(manifest.daemon) ? manifest.daemon : null;
    const routes = [];
    if (socket) routes.push({ token: id, via: 'the daemon socket' });
    if (command && (!socket || daemon.command !== command)) {
        const args = Array.isArray(action.args) ? action.args.map(String) : [id];
        routes.push({ token: args[0], via: `\`${[command, ...args].join(' ')}\`` });
    }
    return routes;
}

function manifestFindings(repo, dir, docs) {
    const doc = docs['plugin.toml'];
    const manifest = doc.value;
    const lines = doc.lines;
    const out = [];
    const facts = pluginFacts(repo, dir);
    const actions = isTable(manifest.action) ? manifest.action : {};
    const hasConfig = repo.read(`${dir}/qol-config.toml`) !== null;
    const capabilities = isTable(manifest.capabilities) ? manifest.capabilities : {};
    const daemon = isTable(manifest.daemon) ? manifest.daemon : null;
    const socket = Boolean(daemon && daemon.enabled === true && typeof daemon.socket === 'string');
    const runtime = isTable(manifest.runtime) ? manifest.runtime : null;
    const stored = storedKeys(repo, docs['qol-config.toml']);
    const actionLine = id => toml.keyLine(lines, actions, id);

    for (const [id, action] of Object.entries(actions)) {
        if (!isTable(action)) continue;
        const kind = action.kind ?? 'run';
        if (kind === 'toggle-config' && !stored.has(action.config_key)) {
            out.push(finding(doc.file, actionLine(id), 'toggle', id, `[action.${id}] toggles config_key ${JSON.stringify(action.config_key ?? null)}, which no stored qol-config.toml field declares`));
        }
        if (!EXECUTABLE_KINDS.has(kind) || (kind === 'settings' && hasConfig)) continue;
        const routes = routesFor(id, action, manifest, socket);
        if (routes.length === 0) {
            out.push(finding(doc.file, actionLine(id), 'target', id, `[action.${id}] has no enabled [daemon] socket and no [runtime] command, so the tray cannot run it`));
        } else if (!routes.some(route => route.token === undefined || mentions(facts.strings, route.token))) {
            const how = routes.map(route => `as "${route.token}" through ${route.via}`).join(' or ');
            const tokens = [...new Set(routes.map(route => `"${route.token}"`))].join(' or ');
            out.push(finding(doc.file, actionLine(id), 'dispatch', id, `[action.${id}] reaches the plugin ${how}, but neither ${dir}/src nor its path dependencies mention ${tokens} outside tests`));
        }
    }

    const executable = executableIds(manifest);
    const seen = new Set();
    for (const shortcut of Array.isArray(manifest.shortcuts) ? manifest.shortcuts : []) {
        if (!isTable(shortcut)) continue;
        const line = toml.tableLine(lines, shortcut);
        const target = typeof shortcut.action === 'string' ? shortcut.action : 'open';
        if (!executable.has(target)) {
            out.push(finding(doc.file, line, 'shortcut', String(shortcut.id), `[[shortcuts]] ${shortcut.id} runs action "${target}", which plugin.toml does not declare as run or settings`));
        }
        if (seen.has(shortcut.id)) out.push(finding(doc.file, line, 'duplicate', String(shortcut.id), `[[shortcuts]] id "${shortcut.id}" appears more than once`));
        seen.add(shortcut.id);
    }

    const builds = facts.bins.size ? [...facts.bins].sort().join(', ') : 'no binary';
    if (typeof runtime?.command === 'string' && !facts.bins.has(runtime.command)) {
        out.push(finding(doc.file, toml.keyLine(lines, runtime, 'command'), 'binary', 'runtime', `[runtime] command = "${runtime.command}", but ${dir}/Cargo.toml builds ${builds}`));
    }
    if (daemon && typeof daemon.command === 'string' && !facts.bins.has(daemon.command)) {
        out.push(finding(doc.file, toml.keyLine(lines, daemon, 'command'), 'binary', 'daemon', `[daemon] command = "${daemon.command}", but ${dir}/Cargo.toml builds ${builds}`));
    }
    const dependencies = isTable(manifest.dependencies) && Array.isArray(manifest.dependencies.binaries) ? manifest.dependencies.binaries : [];
    for (const dependency of dependencies) {
        if (isTable(dependency) && typeof dependency.name === 'string' && !facts.bins.has(dependency.name)) {
            out.push(finding(doc.file, toml.tableLine(lines, dependency), 'binary', `dependency:${dependency.name}`, `[[dependencies.binaries]] name = "${dependency.name}", but ${dir}/Cargo.toml builds ${builds}`));
        }
    }

    const marks = markNames(repo);
    const info = isTable(manifest.plugin) ? manifest.plugin : {};
    if (marks && typeof info.icon === 'string' && !marks.has(info.icon)) {
        out.push(finding(doc.file, toml.keyLine(lines, info, 'icon'), 'icon', 'icon', `[plugin] icon = "${info.icon}" is not a qol_theme mark name, so the launcher and the settings rail fall back to the QoL mark`));
    }

    const doctorLine = toml.keyLine(lines, capabilities, 'doctor') || toml.keyLine(lines, manifest, 'capabilities');
    if (capabilities.doctor === true && !facts.doctorWired && !facts.ownStrings.has('doctor')) {
        out.push(finding(doc.file, doctorLine, 'doctor', 'declared', `[capabilities] doctor = true, but ${dir}/src registers no doctor checks, so the tray's doctor gets nothing from it`));
    }
    if (capabilities.doctor !== true && facts.doctorWired) {
        out.push(finding(doc.file, doctorLine, 'doctor', 'undeclared', `${dir}/src registers doctor checks, but [capabilities] doctor is not true, so the tray never runs them`));
    }

    const items = isTable(manifest.menu) && Array.isArray(manifest.menu.items) ? manifest.menu.items : [];
    const itemsLine = items.length ? toml.keyLine(lines, manifest.menu, 'items') : 0;
    if (Object.keys(actions).length && items.length) {
        out.push(finding(doc.file, itemsLine, 'menu', 'items', `[menu] items holds ${items.length} ${items.length === 1 ? 'entry' : 'entries'}, but plugin.toml declares [action.*], so the tray reads only the actions and never shows these`));
    } else {
        for (const id of checkboxIds(items)) {
            out.push(finding(doc.file, itemsLine, 'menu', `checkbox:${id}`, `[menu] checkbox "${id}" is never shown, because the tray turns only action and submenu entries into actions`));
        }
    }

    const declarations = isTable(manifest.config) ? manifest.config : {};
    const scopes = isTable(declarations.scope) ? declarations.scope : {};
    for (const name of Object.keys(scopes)) {
        if (![...stored].some(key => key === name || key.startsWith(`${name}.`))) {
            out.push(finding(doc.file, toml.keyLine(lines, scopes, name), 'scope', name, `[config] scope.${name} names no stored qol-config.toml key or parent of one, so the scope applies to nothing`));
        }
    }
    return out;
}

function chainMatches(schema, segments) {
    const matches = [];
    for (const defs of schema.types.values()) {
        for (const def of defs) {
            if (def.kind === 'struct' && def.deserialize) walkChain(schema, def, segments, 0, matches, new Set());
        }
    }
    return matches;
}

function walkChain(schema, def, segments, index, matches, seen) {
    if (seen.has(def)) return;
    seen.add(def);
    const members = rust.structMembers(schema, def);
    const entry = members.byWire.get(segments[index]);
    if (!entry) {
        if (index > 0 && members.catchAll.length) matches.push(true);
        return;
    }
    if (index === segments.length - 1) {
        matches.push(entry.field);
        return;
    }
    descend(schema, rust.shapeOf(schema, entry.field.type, entry.field.file), segments, index + 1, matches, seen);
}

function descend(schema, shape, segments, index, matches, seen) {
    if (shape.kind === 'option') return descend(schema, rust.shapeOf(schema, shape.item, shape.fromFile), segments, index, matches, seen);
    if (shape.kind === 'struct') return walkChain(schema, shape.def, segments, index, matches, new Set(seen));
    if (shape.kind === 'map') {
        if (index === segments.length - 1) {
            matches.push(true);
            return undefined;
        }
        return descend(schema, rust.shapeOf(schema, shape.value, shape.fromFile), segments, index + 1, matches, seen);
    }
    if (shape.kind === 'any') matches.push(true);
    return undefined;
}

function bindingGap(facts, key) {
    const segments = key.split('.');
    const matches = chainMatches(facts.schema, segments);
    if (matches.some(match => match === true || facts.reads.has(match.rust))) return null;
    if (matches.length) {
        const names = [...new Set(matches.map(match => match.rust))].join(', ');
        return `binds to the field ${names}, which no code outside tests reads`;
    }
    if (facts.strings.has(key) || facts.strings.has(segments[segments.length - 1])) return null;
    return 'matches no Deserialize struct field and no string';
}

function configFindings(repo, dir, docs) {
    const doc = docs['qol-config.toml'];
    const config = doc.value;
    const out = [];
    if (!isTable(config)) return out;
    const facts = pluginFacts(repo, dir);
    const fields = isTable(config.field) ? config.field : {};
    const sections = isTable(config.section) ? config.section : {};
    const manifest = docs['plugin.toml'] && isTable(docs['plugin.toml'].value) ? docs['plugin.toml'].value : null;
    const executable = manifest ? executableIds(manifest) : null;
    for (const [id, section] of Object.entries(sections)) {
        if (!executable || !isTable(section) || !Array.isArray(section.actions)) continue;
        for (const action of section.actions) {
            if (!executable.has(action)) {
                out.push(finding(doc.file, toml.keyLine(doc.lines, section, 'actions'), 'sectionAction', `${id}:${action}`, `[section.${id}] actions lists "${action}", which plugin.toml does not declare as run or settings`));
            }
        }
    }
    for (const [id, field] of Object.entries(fields)) {
        if (!isStored(repo, field)) continue;
        const key = typeof field.config_key === 'string' ? field.config_key : id;
        const gap = bindingGap(facts, key);
        if (gap) {
            out.push(finding(doc.file, toml.keyLine(doc.lines, fields, id), 'binding', id, `[field.${id}] stores "${key}", which ${gap} in ${dir}/src or its path dependencies`));
        }
    }
    return out;
}

function runtimeFindings(repo, dir, doc) {
    const out = [];
    if (!isTable(doc.value)) return out;
    const facts = pluginFacts(repo, dir);
    for (const table of ['action', 'query']) {
        const entries = isTable(doc.value[table]) ? doc.value[table] : {};
        for (const id of Object.keys(entries)) {
            if (!mentions(facts.strings, id)) {
                out.push(finding(doc.file, toml.keyLine(doc.lines, entries, id), 'unhandled', `${table}.${id}`, `[${table}.${id}] is declared, but neither ${dir}/src nor its path dependencies mention "${id}" outside tests, so nothing answers it`));
            }
        }
    }
    return out;
}

function computeFindings(repo, dir) {
    const findings = [];
    const docs = {};
    for (const name of Object.keys(CONTRACT_TYPES)) {
        const file = `${dir}/${name}`;
        const text = repo.read(file);
        if (text === null) continue;
        try {
            docs[name] = { file, ...toml.parse(text) };
        } catch (error) {
            findings.push(finding(file, error.line, 'parse', 'parse', error.message.replace(/ \(line \d+\)$/, '')));
        }
    }
    for (const [name, doc] of Object.entries(docs)) findings.push(...schemaFindings(repo, doc, CONTRACT_TYPES[name]));
    if (docs['plugin.toml'] && isTable(docs['plugin.toml'].value)) findings.push(...manifestFindings(repo, dir, docs));
    if (docs['qol-config.toml']) findings.push(...configFindings(repo, dir, docs));
    if (docs['qol-runtime.toml']) findings.push(...runtimeFindings(repo, dir, docs['qol-runtime.toml']));
    return findings;
}

function pluginFindings(repo, dir) {
    return repo.memo(`findings:${dir}`, () => computeFindings(repo, dir));
}

function pluginDirs(repo) {
    const dirs = repo.list('plugins').map(file => /^(plugins\/[^/]+)\/plugin\.toml$/.exec(file)?.[1]).filter(Boolean);
    return [...new Set(dirs)].sort();
}

const rootByDirectory = new Map();

function findRoot(filePath) {
    const start = path.dirname(path.resolve(filePath));
    if (rootByDirectory.has(start)) return rootByDirectory.get(start);
    let dir = start;
    let root = null;
    for (;;) {
        if (fs.existsSync(path.join(dir, ROOT_MARKER)) && fs.existsSync(path.join(dir, 'plugins'))) {
            root = dir;
            break;
        }
        const parent = path.dirname(dir);
        if (parent === dir) break;
        dir = parent;
    }
    rootByDirectory.set(start, root);
    return root;
}

function classify(root, filePath) {
    const rel = relative(root, filePath);
    let match;
    if ((match = CONTRACT_PATH.exec(rel))) return { kind: 'contract', rel, dirs: [match[1]] };
    if (rust.TEST_FILE.test(rel)) return null;
    if ((match = SOURCE_PATH.exec(rel))) return { kind: 'source', rel, dirs: [match[1]] };
    if (rel.endsWith('.rs') && [...SCHEMA_DIRS, MARK_DIR].some(dir => rel.startsWith(`${dir}/`))) return { kind: 'shared', rel, dirs: null };
    return null;
}

function findingsFor(root, target, overrides) {
    const repo = repoFor(root, overrides);
    return (target.dirs ?? pluginDirs(repo)).flatMap(dir => pluginFindings(repo, dir));
}

function identity(entry) {
    return `${entry.file}\0${entry.rule}\0${entry.subject}`;
}

function addedFindings(before, now) {
    const remaining = new Map();
    for (const entry of before) remaining.set(identity(entry), (remaining.get(identity(entry)) ?? 0) + 1);
    return now.filter(entry => {
        const left = remaining.get(identity(entry)) ?? 0;
        if (left === 0) return true;
        remaining.set(identity(entry), left - 1);
        return false;
    });
}

function message(entry, linted = entry.file) {
    const [title, hint] = RULES[entry.rule];
    const where = linted === entry.file ? `line ${entry.line}` : `${entry.file}:${entry.line}`;
    return `${title} in ${path.posix.basename(linted)}: ${entry.detail} (${where}).\n[qol-plugin-contract] ${hint} (${SKILL})`;
}

function deny(filePath, added) {
    const shown = added.slice(0, MAX_LISTED).map(entry => `  - ${entry.file}:${entry.line} ${RULES[entry.rule][0]}: ${entry.detail}`);
    if (added.length > MAX_LISTED) shown.push(`  … and ${added.length - MAX_LISTED} more`);
    const hints = [...new Set(added.map(entry => RULES[entry.rule][1]))];
    const count = added.length === 1 ? 'a plugin contract declaration' : `${added.length} plugin contract declarations`;
    const reason = `This edit to ${path.basename(filePath)} leaves ${count} the code does not honour:\n${shown.join('\n')}\n` +
        `[qol-plugin-contract] ${hints.join('; ')} (${SKILL})`;
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
        },
    }) + '\n');
}

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

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
    if (existing === null) return null;
    let content = existing;
    for (const edit of edits) {
        const next = applyEdit(content, edit.old_string, edit.new_string, edit.replace_all);
        if (next === null) return null;
        content = next;
    }
    return content;
}

function judge(root, target, absolute, existing, after) {
    if (lintMode.active() && existing === null && target.kind === 'contract') {
        for (const entry of findingsFor(root, target, new Map([[absolute, after]])).filter(item => item.file === target.rel)) {
            lintMode.report(process.stderr, message(entry));
        }
        return;
    }
    if (lintMode.active() && (existing === null || existing === after)) return;
    const now = findingsFor(root, target, new Map([[absolute, after]]));
    const before = findingsFor(root, target, lintMode.active() ? new Map([[absolute, existing]]) : new Map());
    const added = addedFindings(before, now);
    if (added.length === 0) return;
    if (lintMode.active()) {
        for (const entry of added) lintMode.report(process.stderr, message(entry, target.rel));
        return;
    }
    deny(absolute, added);
}

function evaluate(payload) {
    const tool = payload.tool_name || '';
    if (!INSPECTED_TOOLS.has(tool)) return;
    const input = payload.tool_input || {};
    const filePath = input.file_path || '';
    if (!CANDIDATE_PATH.test(filePath) || !inQolRepo(filePath)) return;
    const root = findRoot(filePath);
    if (!root) return;
    const target = classify(root, filePath);
    if (!target) return;
    const existing = readExistingFile(filePath);
    const after = prospectiveContent(tool, input, existing);
    if (after === null) return;
    try {
        judge(root, target, path.resolve(filePath), existing, after);
    } finally {
        saveCache(repoFor(root));
    }
}

function lintFile(filePath, content, baseline = null) {
    return lintMode.run(filePath, () => evaluate({
        tool_name: 'Write',
        tool_input: { file_path: filePath, content },
    }), baseline);
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

module.exports = { lintFile, LOCATORS: [], pluginFindings, repoFor, pluginDirs, message, saveCache, mentions };

if (require.main === module) {
    try {
        main();
    } catch {}
    process.exit(0);
}
