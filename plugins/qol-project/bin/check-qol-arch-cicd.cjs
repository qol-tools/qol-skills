#!/usr/bin/env node
/*
 * qol-arch-cicd PreToolUse hook.
 *
 * Lints CI/release workflow YAML and Cargo.toml files in qol-tools repos for
 * the patterns that have historically broken cross-platform builds at
 * release time. Heuristic — workflow YAML can be arbitrarily complex, so the
 * checks favor false-negatives over false-positives. The deterministic
 * backstop is the matrix build itself; this hook just shortens the feedback
 * loop.
 *
 * Active on Edit/Write/MultiEdit/NotebookEdit of:
 *
 *   1. .github/workflows/*.yml under any /qol-<name>/ path — flags:
 *      a. cargo (build|test|clippy|deb|run) runs that lack
 *         RUSTFLAGS=-D warnings in the step or job env.
 *      b. Hardcoded `runs-on: ubuntu-latest` in any reusable plugin
 *         (workflow_call) workflow that consumes plugin.toml (matrix should derive from
 *         plugin.toml platforms).
 *      c. cargo invocations in workflows whose repo root has
 *         qol-config = { path = "../qol-config" } in Cargo.toml but where
 *         the workflow does not check out qol-tools/qol-config as a sibling.
 *   2. Cargo.toml under any /qol-<name>/ path — flags top-level [dependencies] entries for crates
 *      that are known platform-specific. These belong in
 *      [target.'cfg(target_os = "...")'.dependencies].
 *
 * qac lint alone (lintFile, never the edit hook) also checks every
 * workspace member's Cargo.toml: a [features] key that CI never turns on is
 * reported at its line. The rule reads the whole tree and ignores the
 * baseline.
 *
 * Bypass:
 *   touch .claude/bypass-qol-arch-cicd          # next 1 edit passes
 *   echo N > .claude/bypass-qol-arch-cicd       # next N edits pass
 *
 * Runs on Node — Claude Code requires Node, dependency is free across OSes.
 * Silent on errors — a failing hook must never block Claude irreversibly.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INSPECTED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

const WORKFLOW_PATH_RE = /[\\/]\.github[\\/]workflows[\\/][^\\/]+\.ya?ml$/;
const CARGO_TOML_BASENAME = 'Cargo.toml';

function crossPlatformBasename(p) {
    const parts = p.split(/[\\/]/);
    return parts[parts.length - 1] || p;
}

const PLATFORM_CRATES = new Set([
    'x11rb', 'xkbcommon', 'wayland-client', 'wayland-protocols', 'wayland-sys', 'wayland-backend',
    'objc2', 'core-foundation', 'core-graphics', 'cocoa', 'appkit',
    'windows', 'windows-sys', 'windows-targets',
]);

const lintMode = require('./hook-lint-mode.cjs');
const { inQolRepo } = require('./qol-repo.cjs');
const crateDirection = require('./crate-direction.cjs');
const toml = require('./toml-lite.cjs');
const { readExistingFile, prospectiveContent } = require('./hook-edit-content.cjs');

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function log(msg) {
    if (lintMode.active()) return;
    process.stderr.write(`[qol-arch-cicd] ${msg}\n`);
}

function extractNewContent(tool, input) {
    if (!input) return '';
    if (tool === 'Write') return input.content || '';
    if (tool === 'Edit') return input.new_string || '';
    if (tool === 'MultiEdit') {
        return (input.edits || [])
            .map(e => e.new_string || '')
            .join('\n\n');
    }
    if (tool === 'NotebookEdit') return input.new_source || '';
    return '';
}

function findCargoRunWithoutRustflags(content) {
    const lines = content.split(/\r?\n/);
    const cargoCmdRe = /\bcargo\s+(?:build|test|clippy|deb|run)\b/;
    const inlineRustflagsRe = /RUSTFLAGS\s*=\s*['"]?-D\s+warnings/;
    const envRustflagsRe = /^\s*RUSTFLAGS\s*:\s*[^#\n]*-D\s+warnings/m;

    const cargoLines = [];
    for (let i = 0; i < lines.length; i++) {
        if (cargoCmdRe.test(lines[i])) cargoLines.push(i);
    }
    if (cargoLines.length === 0) return [];

    const violations = [];
    for (const idx of cargoLines) {
        const line = lines[idx];
        if (inlineRustflagsRe.test(line)) continue;
        const stepStart = findEnclosingStepStart(lines, idx);
        const stepEnd = findEnclosingStepEnd(lines, idx);
        const stepBlock = lines.slice(stepStart, stepEnd + 1).join('\n');
        if (envRustflagsRe.test(stepBlock)) continue;
        const jobBlock = findEnclosingJobBlock(lines, idx);
        if (envRustflagsRe.test(jobBlock)) continue;
        if (envRustflagsRe.test(content)) {
            const before = lines.slice(0, idx).join('\n');
            if (envRustflagsRe.test(before)) continue;
        }
        violations.push({ lineno: idx + 1, text: line });
    }
    return violations;
}

function findEnclosingStepStart(lines, idx) {
    for (let i = idx; i >= 0; i--) {
        if (/^\s*-\s+/.test(lines[i])) return i;
    }
    return Math.max(0, idx - 20);
}

function findEnclosingStepEnd(lines, idx) {
    for (let i = idx + 1; i < lines.length; i++) {
        if (/^\s*-\s+/.test(lines[i])) return i - 1;
    }
    return Math.min(lines.length - 1, idx + 20);
}

function findEnclosingJobBlock(lines, idx) {
    let jobStart = 0;
    for (let i = idx; i >= 0; i--) {
        const m = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*$/.exec(lines[i]);
        if (m && m[1].length === 2) {
            jobStart = i;
            break;
        }
    }
    let jobEnd = lines.length - 1;
    for (let i = idx + 1; i < lines.length; i++) {
        const m = /^(\s*)([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*$/.exec(lines[i]);
        if (m && m[1].length <= 2) {
            jobEnd = i - 1;
            break;
        }
    }
    return lines.slice(jobStart, jobEnd + 1).join('\n');
}

function findHardcodedUbuntu(content) {
    const lines = content.split(/\r?\n/);
    const isReusable = /^\s*workflow_call\s*:/m.test(content);
    const usesPluginManifest = /plugin\.toml|inputs\.plugin_manifest/.test(content);
    if (!isReusable || !usesPluginManifest) return [];
    const violations = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const m = /^\s*runs-on\s*:\s*ubuntu-latest\s*$/.exec(line);
        if (m) {
            const blockStart = Math.max(0, i - 8);
            const blockEnd = Math.min(lines.length, i + 12);
            const block = lines.slice(blockStart, blockEnd).join('\n');
            if (/strategy:\s*\n[\s\S]*matrix:|\$\{\{\s*matrix\.os\s*\}\}|matrix_setup/.test(block)) continue;
            violations.push({ lineno: i + 1, text: line });
        }
    }
    return violations;
}

function findMissingQolConfigCheckout(filePath, content) {
    const repoRoot = filePath.replace(/[\\/]\.github[\\/]workflows[\\/].*$/, '');
    const cargoPath = path.join(repoRoot, 'Cargo.toml');
    let cargoText = '';
    try {
        cargoText = fs.readFileSync(cargoPath, 'utf8');
    } catch {
        return [];
    }
    if (!/qol-config\s*=\s*\{[^}]*path\s*=\s*"\.\.\/qol-config"/.test(cargoText)) return [];

    const cargoSteps = /\bcargo\s+(?:build|test|clippy|deb|run)\b/.test(content);
    if (!cargoSteps) return [];
    const checksOutQolConfig = /repository:\s*qol-tools\/qol-config/.test(content);
    if (checksOutQolConfig) return [];
    return [{ workflow: crossPlatformBasename(filePath), cargoTomlHasPathDep: true }];
}

function findUnconditionalPlatformCrates(content) {
    const lines = content.split(/\r?\n/);
    const violations = [];
    let inDeps = false;
    let inTargetDeps = false;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (/^\[/.test(trimmed)) {
            inDeps = /^\[(dependencies|dev-dependencies|build-dependencies)\]\s*$/.test(trimmed);
            inTargetDeps = /^\[target\./.test(trimmed);
            continue;
        }
        if (!inDeps || inTargetDeps) continue;
        const m = /^([a-z0-9_-]+)\s*=/i.exec(trimmed);
        if (!m) continue;
        const crate = m[1].toLowerCase();
        const isPlatformCrate = PLATFORM_CRATES.has(crate) || /^wayland-/.test(crate);
        if (isPlatformCrate) {
            violations.push({ lineno: i + 1, crate, text: line });
        }
    }
    return violations;
}

function blockRustflags(filePath, violations) {
    const detail = violations
        .map(v => `  line ${v.lineno}: ${v.text.trim()}`)
        .join('\n');
    lintMode.report(process.stderr, `qol-arch-cicd violation in ${filePath}.

Found cargo invocation(s) without RUSTFLAGS=-D warnings in env:

${detail}

Without RUSTFLAGS=-D warnings, dead_code / unused_imports / unused_mut and
the rest of the cross-platform-leakage warnings are warnings — and warnings
are silently ignored on a CI dashboard. With it, they become hard errors
that fail the build and surface the leak.

Add to the step (or to job-level env):

  env:
    RUSTFLAGS: -D warnings

Note: clippy's "-- -D warnings" only handles clippy lints. dead_code lives
in rustc and needs the env var. You typically want both.

Reference: qol-arch-cicd skill.

Bypass for this edit only:
  touch .claude/bypass-qol-arch-cicd
`);
}

function blockHardcodedUbuntu(filePath, violations) {
    const detail = violations
        .map(v => `  line ${v.lineno}: ${v.text.trim()}`)
        .join('\n');
    lintMode.report(process.stderr, `qol-arch-cicd violation in ${filePath}.

Found hardcoded "runs-on: ubuntu-latest" in a workflow that consumes
plugin.toml:

${detail}

Plugin CI must matrix on the platforms declared in plugin.toml. Otherwise
plugins that claim macOS or Windows support never see CI builds on those
OSes — and the dead_code / link / cfg failures only surface in production.

Pattern (matrix derived from plugin.toml at workflow start):

  jobs:
    matrix_setup:
      runs-on: ubuntu-latest
      outputs:
        runners: \${{ steps.detect.outputs.runners }}
      steps:
        - uses: actions/checkout@v4
        - id: detect
          run: |
            python3 - <<'PY'
            import json, os, tomllib
            p = tomllib.load(open(os.environ["PLUGIN_MANIFEST"], "rb"))
            platforms = p.get("plugin", {}).get("platforms", ["linux"])
            mapping = {"linux": "ubuntu-latest", "macos": "macos-latest", "windows": "windows-latest"}
            runners = [mapping[x] for x in platforms if x in mapping] or ["ubuntu-latest"]
            open(os.environ["GITHUB_OUTPUT"], "a").write(f"runners={json.dumps(runners)}\\n")
            PY

    test:
      needs: matrix_setup
      strategy:
        fail-fast: false
        matrix:
          os: \${{ fromJSON(needs.matrix_setup.outputs.runners) }}
      runs-on: \${{ matrix.os }}

Reference: qol-arch-cicd skill.

Bypass for this edit only:
  touch .claude/bypass-qol-arch-cicd
`);
}

function blockMissingQolConfig(filePath) {
    lintMode.report(process.stderr, `qol-arch-cicd violation in ${filePath}.

This workflow runs cargo, and the repo's Cargo.toml has
qol-config = { path = "../qol-config" }, but the workflow does not check
out qol-tools/qol-config as a sibling.

This is exactly the asymmetry that broke qol-tray v3.10.0 — ci.yml had the
sibling-checkout-and-rewrite, release.yml didn't. cargo deb failed at
release time on a green main.

Add to every cargo-running job in this workflow:

  - name: Checkout qol-config sibling
    uses: actions/checkout@v4
    with:
      repository: qol-tools/qol-config
      path: qol-config

  - name: Rewrite qol-config path dependency for CI checkout layout
    shell: bash
    run: |
      python3 - <<'PY'
      from pathlib import Path
      m = Path("Cargo.toml")
      t = m.read_text()
      m.write_text(t.replace(
          'qol-config = { path = "../qol-config" }',
          'qol-config = { path = "qol-config" }',
      ))
      PY

Reference: qol-arch-cicd skill.

Bypass for this edit only:
  touch .claude/bypass-qol-arch-cicd
`);
}

function blockPlatformCrates(filePath, violations) {
    const detail = violations
        .map(v => `  line ${v.lineno}: ${v.crate} — ${v.text.trim()}`)
        .join('\n');
    lintMode.report(process.stderr, `qol-arch-cicd violation in ${filePath}.

Found platform-specific crate(s) in unconditional [dependencies]:

${detail}

These crates only build on a specific OS. Declaring them at the top of
[dependencies] makes Cargo try to fetch and compile them on every OS,
wasting build time and (often) failing to link on the wrong platform.

Move them under a target gate:

  [target.'cfg(target_os = "linux")'.dependencies]
  x11rb = "0.13"
  xkbcommon = "0.7"

  [target.'cfg(target_os = "macos")'.dependencies]
  objc2 = "0.5"
  core-foundation = "0.10"

  [target.'cfg(target_os = "windows")'.dependencies]
  windows = { version = "0.58", features = ["Win32_UI_WindowsAndMessaging"] }

Then "use" the crate unconditionally in src/<feature>/platform/<os>.rs —
the manifest-level cfg guarantees it's only present when relevant.

Reference: qol-arch-cicd skill.

Bypass for this edit only:
  touch .claude/bypass-qol-arch-cicd
`);
}

function blockCrateDirection(filePath, violations) {
    const detail = violations
        .map(v => `  line ${v.line}: ${v.from} depends on ${v.dependency} (${v.target})`)
        .join('\n');
    lintMode.report(process.stderr, `qol-arch-cicd violation in ${filePath}.

Found dependencies that point outward:

${detail}

Crates depend inward only. A crate under libs/ depends on libs/ and vendor/,
never on plugins/, apps/ or tools/, and a plugin never depends on another
plugin, on apps/ or on tools/. Put the neutral contract both sides need in
libs/ and have each crate use it directly.

Reference: qol-shared-libs skill, "Dependency rules".

Bypass for this edit only:
  touch .claude/bypass-qol-arch-cicd
`);
}

const SEPARATOR = Symbol('separator');
const DEPENDENCY_KINDS = ['dependencies', 'dev-dependencies', 'build-dependencies'];
const coverageByRoot = new Map();

function readText(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

function parseToml(text) {
    if (text === null) return null;
    try {
        return toml.parse(text);
    } catch {
        return null;
    }
}

function isTable(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function strings(value) {
    return Array.isArray(value) ? value.filter(item => typeof item === 'string') : [];
}

function expandGlob(root, pattern) {
    let dirs = [root];
    for (const segment of pattern.split(/[\\/]/).filter(part => part && part !== '.')) {
        if (!/[*?]/.test(segment)) {
            dirs = dirs.map(dir => path.join(dir, segment));
            continue;
        }
        const re = new RegExp(`^${segment.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);
        const next = [];
        for (const dir of dirs) {
            let entries = [];
            try {
                entries = fs.readdirSync(dir, { withFileTypes: true });
            } catch {
                continue;
            }
            for (const entry of entries) {
                if (entry.isDirectory() && re.test(entry.name)) next.push(path.join(dir, entry.name));
            }
        }
        dirs = next;
    }
    return dirs;
}

function workspaceMembers(root, workspace) {
    const excluded = strings(workspace.exclude).flatMap(pattern => expandGlob(root, pattern));
    const isExcluded = dir => excluded.some(skip => dir === skip || dir.startsWith(skip + path.sep));
    const dirs = new Set([root, ...strings(workspace.members).flatMap(pattern => expandGlob(root, pattern))]);
    const members = [];
    for (const dir of dirs) {
        if (dir !== root && isExcluded(dir)) continue;
        const manifest = path.join(dir, 'Cargo.toml');
        const doc = parseToml(readText(manifest));
        const name = doc?.value.package?.name;
        if (typeof name !== 'string') continue;
        members.push({ dir, manifest, name, doc });
    }
    return members;
}

function dependencyTables(value) {
    const tables = [];
    const collect = scope => {
        for (const kind of DEPENDENCY_KINDS) {
            if (isTable(scope?.[kind])) tables.push(scope[kind]);
        }
    };
    collect(value);
    for (const target of Object.values(isTable(value.target) ? value.target : {})) collect(target);
    return tables;
}

function dependencyPackage(key, spec, shared) {
    if (!isTable(spec)) return key;
    if (typeof spec.package === 'string') return spec.package;
    const inherited = spec.workspace === true && isTable(shared?.[key]) ? shared[key].package : null;
    return typeof inherited === 'string' ? inherited : key;
}

function shellTokens(line) {
    const tokens = [];
    let current = null;
    const flush = () => {
        if (current !== null) tokens.push(current);
        current = null;
    };
    const expression = index => {
        const end = line.indexOf('}}', index);
        return end < 0 ? line.length : end + 2;
    };
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (line.startsWith('${{', i)) {
            const stop = expression(i);
            current = (current ?? '') + line.slice(i, stop);
            i = stop - 1;
        } else if (c === '"' || c === "'") {
            let j = i + 1;
            current = current ?? '';
            while (j < line.length && line[j] !== c) {
                if (line.startsWith('${{', j)) {
                    const stop = expression(j);
                    current += line.slice(j, stop);
                    j = stop;
                } else if (c === '"' && line[j] === '\\' && j + 1 < line.length) {
                    current += line[j + 1];
                    j += 2;
                } else {
                    current += line[j++];
                }
            }
            i = j;
        } else if (c === '\\' && i + 1 < line.length) {
            current = (current ?? '') + line[++i];
        } else if (/\s/.test(c)) {
            flush();
        } else if (';|&<>'.includes(c)) {
            flush();
            if (tokens[tokens.length - 1] !== SEPARATOR) tokens.push(SEPARATOR);
        } else if (c === '#' && current === null) {
            break;
        } else {
            current = (current ?? '') + c;
        }
    }
    flush();
    return tokens;
}

function logicalLines(text) {
    const raw = text.split(/\r?\n/);
    const lines = [];
    for (let i = 0; i < raw.length; i++) {
        let line = raw[i];
        const folded = /^(\s*)(?:-\s+)?run:\s*>[-+]?\s*$/.exec(line);
        if (folded) {
            const parts = [];
            while (i + 1 < raw.length && (raw[i + 1].trim() === '' || raw[i + 1].search(/\S/) > folded[1].length)) parts.push(raw[++i].trim());
            lines.push(parts.join(' '));
            continue;
        }
        while (/\\\s*$/.test(line) && i + 1 < raw.length) line = `${line.replace(/\\\s*$/, '')} ${raw[++i].trim()}`;
        if (!/^\s*#/.test(line)) lines.push(line);
    }
    return lines;
}

function cargoCommand(args) {
    const command = { packages: new Set(), excluded: new Set(), features: [], allFeatures: false, workspace: false };
    const packageName = value => value.replace(/[@:].*$/, '');
    const valued = (arg, i, long, short) => {
        if (arg === long || (short && arg === short)) {
            const value = args[i + 1];
            return value !== undefined && !value.startsWith('-') ? { value, used: 1 } : { value: null, used: 0 };
        }
        if (arg.startsWith(`${long}=`)) return { value: arg.slice(long.length + 1), used: 0 };
        if (short && arg.startsWith(short) && !arg.startsWith('--')) return { value: arg.slice(short.length).replace(/^=/, ''), used: 0 };
        return null;
    };
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (arg === '--') break;
        if (arg === '--all-features') command.allFeatures = true;
        else if (arg === '--workspace' || arg === '--all') command.workspace = true;
        for (const [long, short, apply] of [
            ['--package', '-p', value => command.packages.add(packageName(value))],
            ['--exclude', null, value => command.excluded.add(packageName(value))],
            ['--features', '-F', value => command.features.push(value)],
        ]) {
            const found = valued(arg, i, long, short);
            if (!found) continue;
            if (found.value !== null) apply(found.value);
            i += found.used;
            break;
        }
    }
    return command;
}

function workflowCommands(text) {
    const commands = [];
    for (const line of logicalLines(text)) {
        const tokens = shellTokens(line);
        for (let i = 0; i < tokens.length; i++) {
            if (tokens[i] !== 'cargo') continue;
            let end = i + 1;
            while (end < tokens.length && tokens[end] !== SEPARATOR) end++;
            const args = tokens.slice(i + 1, end);
            commands.push(cargoCommand(args[0]?.startsWith('+') ? args.slice(1) : args));
            i = end;
        }
    }
    return commands;
}

function buildCoverage(root) {
    const rootDoc = parseToml(readText(path.join(root, 'Cargo.toml')));
    const workspace = rootDoc?.value.workspace;
    if (!isTable(workspace)) return null;
    const members = workspaceMembers(root, workspace);
    const byName = new Map(members.map(member => [member.name, member]));
    const covered = new Set();
    const queue = [];
    const cover = (name, feature) => {
        const key = `${name}\0${feature}`;
        const member = byName.get(name);
        if (!member || covered.has(key) || !(feature in (member.doc.value.features ?? {}))) return;
        covered.add(key);
        queue.push([member, feature]);
    };
    const coverAll = member => {
        for (const feature of Object.keys(isTable(member.doc.value.features) ? member.doc.value.features : {})) cover(member.name, feature);
    };

    const workflowDir = path.join(root, '.github', 'workflows');
    let workflows = [];
    try {
        workflows = fs.readdirSync(workflowDir).filter(file => /\.ya?ml$/.test(file)).sort();
    } catch {
        return null;
    }
    for (const file of workflows) {
        for (const command of workflowCommands(readText(path.join(workflowDir, file)) ?? '')) {
            for (const spelled of command.features.flatMap(value => value.split(/[\s,]+/)).filter(value => value && !value.includes('$'))) {
                const slash = spelled.indexOf('/');
                if (slash > 0) cover(spelled.slice(0, slash).replace(/\?$/, ''), spelled.slice(slash + 1));
                else for (const name of command.packages) cover(name, spelled);
            }
            if (!command.allFeatures) continue;
            for (const member of members) {
                if (command.packages.has(member.name) || (command.workspace && !command.excluded.has(member.name))) coverAll(member);
            }
        }
    }

    const shared = isTable(workspace.dependencies) ? workspace.dependencies : {};
    const coverDependencies = (table, aliases) => {
        for (const [key, spec] of Object.entries(table)) {
            const name = dependencyPackage(key, spec, shared);
            aliases?.set(key, name);
            if (isTable(spec)) for (const feature of strings(spec.features)) cover(name, feature);
        }
    };
    coverDependencies(shared, null);
    const aliasesByMember = new Map();
    for (const member of members) {
        const aliases = new Map();
        aliasesByMember.set(member.name, aliases);
        for (const table of dependencyTables(member.doc.value)) coverDependencies(table, aliases);
        const plugin = parseToml(readText(path.join(member.dir, 'plugin.toml')));
        for (const feature of strings(plugin?.value.build?.features)) cover(member.name, feature);
        cover(member.name, 'default');
    }

    while (queue.length > 0) {
        const [member, feature] = queue.pop();
        for (const entry of strings(member.doc.value.features[feature])) {
            if (entry.startsWith('dep:')) continue;
            const slash = entry.indexOf('/');
            if (slash < 0) {
                cover(member.name, entry);
                continue;
            }
            const dependency = entry.slice(0, slash).replace(/\?$/, '');
            cover(aliasesByMember.get(member.name).get(dependency) ?? dependency, entry.slice(slash + 1));
        }
    }
    return { members: new Map(members.map(member => [path.resolve(member.manifest), member])), covered };
}

function coverageOf(root) {
    if (!coverageByRoot.has(root)) coverageByRoot.set(root, buildCoverage(root));
    return coverageByRoot.get(root);
}

function uncoveredFeatures(filePath, content) {
    if (crossPlatformBasename(filePath) !== CARGO_TOML_BASENAME || !inQolRepo(filePath)) return [];
    const root = crateDirection.workspaceRoot(path.dirname(filePath));
    const coverage = root && coverageOf(root);
    const member = coverage?.members.get(path.resolve(filePath));
    const doc = member && parseToml(content);
    if (!doc || !isTable(doc.value.features)) return [];
    return Object.keys(doc.value.features)
        .filter(feature => feature !== 'default' && !coverage.covered.has(`${member.name}\0${feature}`))
        .map(feature => ({ name: member.name, feature, line: toml.keyLine(doc.lines, doc.value.features, feature) }));
}

function featureGapMessage(filePath, gap) {
    return `Cargo feature never built by CI in ${crossPlatformBasename(filePath)}: on line ${gap.line}, no workflow cargo step, dependent crate or plugin.toml [build] features turns on ${gap.name} feature \`${gap.feature}\`, so its code never compiles. Turn it on in one of them, or remove the feature.`;
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
    return evaluate(payload);
}

function evaluate(payload) {
    const tool = payload.tool_name || payload.tool || '';
    if (!INSPECTED_TOOLS.has(tool)) return 0;

    const input = payload.tool_input || {};
    const filePath = input.file_path || input.notebook_path || '';
    if (!filePath) return 0;
    if (!inQolRepo(filePath)) return 0;

    const isWorkflow = WORKFLOW_PATH_RE.test(filePath);
    const isCargo = crossPlatformBasename(filePath) === CARGO_TOML_BASENAME;
    if (!isWorkflow && !isCargo) return 0;

    const cwd = payload.cwd || process.cwd();
    const marker = path.join(cwd, '.claude', 'bypass-qol-arch-cicd');
    if (!lintMode.active() && fs.existsSync(marker) && fs.statSync(marker).isFile()) {
        try {
            const raw = fs.readFileSync(marker, 'utf8').trim();
            const count = /^\d+$/.test(raw) ? Number(raw) : 1;
            if (count > 1) {
                fs.writeFileSync(marker, String(count - 1));
                log(`bypass consumed (${count - 1} remaining) — ${crossPlatformBasename(filePath)}`);
            } else {
                fs.unlinkSync(marker);
                log(`bypass consumed (marker removed) — ${crossPlatformBasename(filePath)}`);
            }
        } catch {
            // ignore
        }
        return 0;
    }

    const newContent = extractNewContent(tool, input);
    if (!newContent) return 0;

    if (isWorkflow) {
        const cargoNoRustflags = findCargoRunWithoutRustflags(newContent);
        if (cargoNoRustflags.length > 0) {
            blockRustflags(filePath, cargoNoRustflags);
            return 2;
        }
        const hardcoded = findHardcodedUbuntu(newContent);
        if (hardcoded.length > 0) {
            blockHardcodedUbuntu(filePath, hardcoded);
            return 2;
        }
        const missingQolConfig = findMissingQolConfigCheckout(filePath, newContent);
        if (missingQolConfig.length > 0) {
            blockMissingQolConfig(filePath);
            return 2;
        }
    }

    if (isCargo) {
        const platformCrates = findUnconditionalPlatformCrates(newContent);
        if (platformCrates.length > 0) {
            blockPlatformCrates(filePath, platformCrates);
            return 2;
        }
        const manifest = prospectiveContent(tool, input, readExistingFile(filePath));
        const outward = crateDirection.violations(filePath, manifest);
        if (outward.length > 0) {
            blockCrateDirection(filePath, outward);
            return 2;
        }
    }

    return 0;
}

function lintFile(filePath, content, baseline = null) {
    return lintMode.run(filePath, () => {
        evaluate({
            tool_name: 'Write',
            tool_input: { file_path: filePath, content },
            cwd: path.dirname(filePath),
        });
        for (const gap of uncoveredFeatures(filePath, content)) {
            lintMode.report(process.stderr, featureGapMessage(filePath, gap));
        }
    }, baseline);
}

module.exports = { lintFile };

if (require.main === module) process.exit(main());
