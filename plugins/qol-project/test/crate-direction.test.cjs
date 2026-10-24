'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'check-qol-arch-cicd.cjs');
const { lintFile } = require(HOOK);
const { violations } = require('../bin/crate-direction.cjs');

const ROOT_MANIFEST = `[workspace]
members = ["libs/*", "plugins/*", "apps/*", "tools/*"]

[workspace.dependencies]
qol-config = { path = "libs/config" }
qol-lights = { path = "plugins/lights" }
qol-tray = { path = "apps/tray" }
qol-cli = { path = "tools/cli" }
gpui = { path = "vendor/gpui/crates/gpui" }
serde = "1"
`;

function workspace() {
    const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qac-crates-')), 'qol-monorepo');
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'Cargo.toml'), ROOT_MANIFEST);
    return root;
}

function member(root, relative) {
    const dir = path.join(root, ...relative.split('/'));
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, 'Cargo.toml');
}

const PACKAGE = name => `[package]\nname = "${name}"\nversion = "0.1.0"\n\n`;

const CASES = [
    ['lib on a lib', 'libs/fs', '[dependencies]\nqol-config = { workspace = true }\n', []],
    ['lib on vendor', 'libs/gpui', '[dependencies]\ngpui = { workspace = true }\n', []],
    ['lib on a registry crate', 'libs/fs', '[dependencies]\nserde = { workspace = true }\nanyhow = "1"\n', []],
    ['lib on a plugin through the workspace', 'libs/fs', '[dependencies]\nqol-lights = { workspace = true }\n', ['libs/fs -> plugins/lights at line 6']],
    ['lib on the tray by path', 'libs/fs', '[dependencies]\nqol-tray = { path = "../../apps/tray" }\n', ['libs/fs -> apps/tray at line 6']],
    ['lib on a tool as a dev dependency', 'libs/fs', '[dev-dependencies]\nqol-cli = { workspace = true }\n', ['libs/fs -> tools/cli at line 6']],
    ['lib on a plugin under a target table', 'libs/fs', '[target.\'cfg(unix)\'.dependencies]\nqol-lights = { workspace = true }\n', ['libs/fs -> plugins/lights at line 6']],
    ['plugin on a lib', 'plugins/sound', '[dependencies]\nqol-config = { workspace = true }\n', []],
    ['plugin on another plugin', 'plugins/sound', '[dependencies]\nqol-lights = { workspace = true }\n', ['plugins/sound -> plugins/lights at line 6']],
    ['plugin on the tray as a build dependency', 'plugins/sound', '[build-dependencies]\nqol-tray = { workspace = true }\n', ['plugins/sound -> apps/tray at line 6']],
    ['plugin sub-crate on its own plugin', 'plugins/lights/client', '[dependencies]\nqol-lights = { path = ".." }\n', []],
    ['tray on a plugin is out of scope', 'apps/tray', '[dependencies]\nqol-lights = { workspace = true }\n', []],
    ['tool on a plugin is out of scope', 'tools/cli', '[dependencies]\nqol-lights = { workspace = true }\n', []],
    ['path outside the workspace', 'libs/fs', '[dependencies]\nother = { path = "../../../elsewhere" }\n', []],
];

for (const [name, relative, deps, expected] of CASES) {
    test(`direction: ${name}`, () => {
        const root = workspace();
        const file = member(root, relative);
        const found = violations(file, PACKAGE(relative.split('/').pop()) + deps)
            .map(v => `${v.from} -> ${v.target} at line ${v.line}`);
        assert.deepEqual(found, expected);
    });
}

test('direction: the workspace manifest and a manifest outside any workspace are ignored', () => {
    const root = workspace();
    assert.deepEqual(violations(path.join(root, 'Cargo.toml'), ROOT_MANIFEST), []);
    const lone = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qac-lone-')), 'libs', 'fs', 'Cargo.toml');
    assert.deepEqual(violations(lone, '[dependencies]\nqol-lights = { path = "../../plugins/lights" }\n'), []);
});

test('direction: a manifest that does not parse is ignored', () => {
    const root = workspace();
    assert.deepEqual(violations(member(root, 'libs/fs'), '[dependencies\nbroken'), []);
});

function run(payload) {
    const result = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
    return { exitCode: result.status, stderr: result.stderr };
}

test('hook: a Write that adds a plugin to a lib is blocked', () => {
    const root = workspace();
    const file = member(root, 'libs/fs');
    const result = run({ tool_name: 'Write', cwd: root, tool_input: { file_path: file, content: PACKAGE('qol-fs') + '[dependencies]\nqol-lights = { workspace = true }\n' } });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /line 6: libs\/fs depends on qol-lights \(plugins\/lights\)/);
    assert.match(result.stderr, /qol-shared-libs skill, "Dependency rules"/);
});

test('hook: an Edit is judged on the whole manifest it leaves', () => {
    const root = workspace();
    const file = member(root, 'plugins/sound');
    fs.writeFileSync(file, PACKAGE('qol-sound') + '[dependencies]\nqol-lights = { workspace = true }\n');
    const unrelated = run({ tool_name: 'Edit', cwd: root, tool_input: { file_path: file, old_string: 'version = "0.1.0"', new_string: 'version = "0.2.0"' } });
    assert.equal(unrelated.exitCode, 2);
    const fixed = run({ tool_name: 'Edit', cwd: root, tool_input: { file_path: file, old_string: 'qol-lights = { workspace = true }', new_string: 'qol-config = { workspace = true }' } });
    assert.equal(fixed.exitCode, 0);
});

test('lintFile reports an outward dependency whatever the baseline holds', () => {
    const root = workspace();
    const file = member(root, 'plugins/sound');
    const content = PACKAGE('qol-sound') + '[dependencies]\nqol-lights = { workspace = true }\n';
    assert.equal(lintFile(file, content).length, 1);
    assert.equal(lintFile(file, content, content).length, 1);
    assert.deepEqual(lintFile(file, PACKAGE('qol-sound'), content), []);
});
