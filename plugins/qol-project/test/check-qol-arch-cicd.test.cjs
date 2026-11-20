'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'check-qol-arch-cicd.cjs');

function run(payload) {
    const result = spawnSync('node', [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
    });
    return { exitCode: result.status, stderr: result.stderr };
}

function makeRepoFixture(cargoToml) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-tools-fixture-'));
    const repoDir = path.join(root, 'qol-tools', 'fakerepo');
    fs.mkdirSync(path.join(repoDir, '.github', 'workflows'), { recursive: true });
    fs.writeFileSync(path.join(repoDir, 'Cargo.toml'), cargoToml);
    return repoDir;
}

test('blocks workflow with cargo build but no RUSTFLAGS=-D warnings', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/.github/workflows/ci.yml',
            content: `jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build
        run: cargo build --release
`,
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /qol-arch-cicd/);
    assert.match(r.stderr, /RUSTFLAGS/);
});

test('passes workflow with RUSTFLAGS=-D warnings in step env', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/.github/workflows/ci.yml',
            content: `jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - name: Build
        env:
          RUSTFLAGS: -D warnings
        run: cargo build --release
`,
        },
    });
    assert.equal(r.exitCode, 0);
});

test('passes workflow with RUSTFLAGS=-D warnings as inline shell var', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/.github/workflows/ci.yml',
            content: `jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: RUSTFLAGS="-D warnings" cargo build
`,
        },
    });
    assert.equal(r.exitCode, 0);
});

test('blocks reusable plugin workflow hardcoding ubuntu-latest', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/qol-cicd/.github/workflows/plugin-ci.yml',
            content: `on:
  workflow_call:
    inputs:
      plugin_manifest:
        type: string
        default: plugin.toml

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - env:
          RUSTFLAGS: -D warnings
        run: cargo build
`,
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /matrix on the platforms declared in plugin\.toml/);
});

test('passes plugin workflow with matrix derived from plugin.toml', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/qol-cicd/.github/workflows/plugin-ci.yml',
            content: `on:
  workflow_call:
    inputs:
      plugin_manifest:
        type: string
        default: plugin.toml

jobs:
  matrix_setup:
    runs-on: ubuntu-latest
    outputs:
      runners: \${{ steps.detect.outputs.runners }}
    steps:
      - uses: actions/checkout@v4

  test:
    needs: matrix_setup
    strategy:
      fail-fast: false
      matrix:
        os: \${{ fromJSON(needs.matrix_setup.outputs.runners) }}
    runs-on: \${{ matrix.os }}
    steps:
      - env:
          RUSTFLAGS: -D warnings
        run: cargo build
`,
        },
    });
    assert.equal(r.exitCode, 0);
});

test('passes non-plugin workflow with hardcoded ubuntu-latest', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/qol-tray/.github/workflows/ci.yml',
            content: `jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - env:
          RUSTFLAGS: -D warnings
        run: cargo clippy
`,
        },
    });
    assert.equal(r.exitCode, 0);
});

test('blocks workflow that runs cargo without sibling qol-config checkout when Cargo.toml has path dep', () => {
    const repoDir = makeRepoFixture(`[package]
name = "qol-tray"
version = "0.1.0"
edition = "2021"

[dependencies]
qol-config = { path = "../qol-config" }
`);
    const wf = path.join(repoDir, '.github', 'workflows', 'release.yml');
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: wf,
            content: `jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - env:
          RUSTFLAGS: -D warnings
        run: cargo deb
`,
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /sibling/);
});

test('passes when workflow does check out qol-config sibling', () => {
    const repoDir = makeRepoFixture(`[package]
name = "qol-tray"
version = "0.1.0"

[dependencies]
qol-config = { path = "../qol-config" }
`);
    const wf = path.join(repoDir, '.github', 'workflows', 'release.yml');
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: wf,
            content: `jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/checkout@v4
        with:
          repository: qol-tools/qol-config
          path: qol-config
      - env:
          RUSTFLAGS: -D warnings
        run: cargo deb
`,
        },
    });
    assert.equal(r.exitCode, 0);
});

test('blocks Cargo.toml with x11rb in unconditional [dependencies]', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/Cargo.toml',
            content: `[package]
name = "foo"
version = "0.1.0"

[dependencies]
serde = "1"
x11rb = "0.13"
`,
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /x11rb/);
});

test('passes Cargo.toml with x11rb in [target.cfg(linux)]', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/Cargo.toml',
            content: `[package]
name = "foo"
version = "0.1.0"

[dependencies]
serde = "1"

[target.'cfg(target_os = "linux")'.dependencies]
x11rb = "0.13"
`,
        },
    });
    assert.equal(r.exitCode, 0);
});

test('blocks Cargo.toml with objc2 unconditional', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/Cargo.toml',
            content: `[dependencies]
objc2 = "0.5"
`,
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /objc2/);
});

test('blocks Cargo.toml with windows-sys unconditional', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/Cargo.toml',
            content: `[dependencies]
windows-sys = "0.52"
`,
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /windows-sys/);
});

test('passes Cargo.toml with no platform-specific crates', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/Cargo.toml',
            content: `[dependencies]
serde = "1"
tokio = "1"
anyhow = "1"
`,
        },
    });
    assert.equal(r.exitCode, 0);
});

test('passes outside qol-tools workspace', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/other/Cargo.toml',
            content: `[dependencies]
x11rb = "0.13"
`,
        },
    });
    assert.equal(r.exitCode, 0);
});

test('blocks CI architecture violations when subagent is the caller', () => {
    const r = run({
        tool_name: 'Write',
        agent_type: 'qol-tray-backend',
        tool_input: {
            file_path: '/x/qol-tools/foo/Cargo.toml',
            content: `[dependencies]
x11rb = "0.13"
`,
        },
    });
    assert.equal(r.exitCode, 2);
});

test('passes workflow files that do not run cargo', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/qol-tools/foo/.github/workflows/labels.yml',
            content: `jobs:
  label:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/labeler@v5
`,
        },
    });
    assert.equal(r.exitCode, 0);
});

test('passes Edit tool when new_string is benign', () => {
    const r = run({
        tool_name: 'Edit',
        tool_input: {
            file_path: '/x/qol-tools/foo/Cargo.toml',
            old_string: 'old',
            new_string: 'serde = "1"',
        },
    });
    assert.equal(r.exitCode, 0);
});

test('blocks Edit on workflow when new_string adds bare cargo run', () => {
    const r = run({
        tool_name: 'Edit',
        tool_input: {
            file_path: '/x/qol-tools/foo/.github/workflows/ci.yml',
            old_string: 'old',
            new_string: '      - run: cargo build\n',
        },
    });
    assert.equal(r.exitCode, 2);
});

test('handles Windows-style backslash paths (regression: D:\\\\... fixture on win runners)', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: 'D:\\a\\qol-tools\\foo\\.github\\workflows\\ci.yml',
            content: `jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: cargo build
`,
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /RUSTFLAGS/);
});

test('handles Windows-style backslash paths for Cargo.toml', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: 'C:\\dev\\qol-tools\\foo\\Cargo.toml',
            content: `[dependencies]
x11rb = "0.13"
`,
        },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /x11rb/);
});

test('blocks platform crate in a qol-monorepo Cargo.toml', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/plugins/foo/Cargo.toml',
            content: `[dependencies]
x11rb = "0.13"
`,
        },
    });
    assert.equal(r.exitCode, 2);
});

test('passes non-reusable release workflow with a linux-only cargo job', () => {
    const r = run({
        tool_name: 'Write',
        tool_input: {
            file_path: '/x/Git/qol-monorepo/.github/workflows/plugin-version.yml',
            content: `on:
  workflow_dispatch:

jobs:
  linux_candidate:
    runs-on: ubuntu-latest
    env:
      RUSTFLAGS: -D warnings
    steps:
      - name: Read every plugin.toml
        run: python3 plan.py
      - run: cargo build --release
`,
        },
    });
    assert.equal(r.exitCode, 0);
});

const { lintFile } = require(HOOK);

const GAP = /never built by CI/;

function workspaceTree(files, { members = '["crates/*"]', exclude = '[]', workflow = null } = {}) {
    const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qol-feature-coverage-')), 'qol-monorepo');
    const all = {
        'Cargo.toml': `[workspace]\nmembers = ${members}\nexclude = ${exclude}\n`,
        ...files,
    };
    if (workflow !== null) all['.github/workflows/ci.yml'] = workflow;
    for (const [name, text] of Object.entries(all)) {
        fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
        fs.writeFileSync(path.join(root, name), text);
    }
    return root;
}

function crate(name, body = '') {
    return `[package]\nname = "${name}"\nversion = "0.1.0"\n${body}`;
}

function gapsOf(root, dir, baseline = null) {
    const file = path.join(root, dir, 'Cargo.toml');
    return lintFile(file, fs.readFileSync(file, 'utf8'), baseline).filter(message => GAP.test(message));
}

function ciRun(command) {
    return `jobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - name: Build\n        env:\n          RUSTFLAGS: -D warnings\n        run: ${command}\n`;
}

function ciBlock(lines) {
    return `jobs:\n  build:\n    runs-on: ubuntu-latest\n    env:\n      RUSTFLAGS: -D warnings\n    steps:\n      - run: |\n${lines.map(line => `          ${line}`).join('\n')}\n`;
}

const APP = (features = 'extra = []') => ({ 'crates/app/Cargo.toml': crate('app', `\n[features]\n${features}\n`) });

test('feature coverage reports an uncovered feature at its line in plain words', () => {
    const root = workspaceTree(APP('default = []\nextra = []\nother = []'), { workflow: ciRun('cargo build --locked') });
    const gaps = gapsOf(root, 'crates/app');
    assert.equal(gaps.length, 2);
    assert.match(gaps[0], /^Cargo feature never built by CI in Cargo\.toml: on line 7, no workflow cargo step, dependent crate or plugin\.toml \[build\] features turns on app feature `extra`, so its code never compiles\./);
    assert.match(gaps[0], /Turn it on in one of them, or remove the feature\.$/);
    assert.match(gaps[1], /on line 8, .* app feature `other`/);
    assert.doesNotMatch(gaps.join('\n'), /feature `default`/);
});

test('feature coverage ignores the baseline', () => {
    const root = workspaceTree(APP(), { workflow: ciRun('cargo build') });
    const file = path.join(root, 'crates/app/Cargo.toml');
    const content = fs.readFileSync(file, 'utf8');
    assert.equal(lintFile(file, content, content).filter(message => GAP.test(message)).length, 1);
    assert.equal(lintFile(file, content, null).filter(message => GAP.test(message)).length, 1);
});

test('feature coverage stays out of the edit hook', () => {
    const root = workspaceTree(APP(), { workflow: ciRun('cargo build') });
    const r = run({
        tool_name: 'Write',
        tool_input: { file_path: path.join(root, 'crates/app/Cargo.toml'), content: fs.readFileSync(path.join(root, 'crates/app/Cargo.toml'), 'utf8') },
    });
    assert.equal(r.exitCode, 0);
    assert.doesNotMatch(r.stderr, GAP);
});

test('a CI step names the feature as pkg/feat in every spelling', () => {
    const commands = [
        'cargo build --features app/extra',
        'cargo build --features=app/extra',
        'cargo build -F app/extra',
        'cargo build -Fapp/extra',
        'cargo build --features other,app/extra',
        'cargo build --features "other app/extra"',
        "cargo build --features 'app/extra other'",
        'cargo clippy --locked --keep-going -p app --all-targets --features app/extra -- -D warnings',
        'cargo build --features app?/extra',
        'cargo +nightly build --features app/extra',
    ];
    for (const command of commands) {
        const root = workspaceTree(APP(), { workflow: ciRun(command) });
        assert.deepEqual(gapsOf(root, 'crates/app'), [], command);
    }
});

test('a CI step names a bare feature only while it selects the package', () => {
    const covered = [
        'cargo build -p app --features extra',
        'cargo build --package app -F extra',
        'cargo build --package=app --features=extra',
        'cargo build -papp --features extra',
        'cargo build -p other -p app --features extra',
        'cargo build -p app@0.1.0 --features extra',
    ];
    for (const command of covered) {
        const root = workspaceTree(APP(), { workflow: ciRun(command) });
        assert.deepEqual(gapsOf(root, 'crates/app'), [], command);
    }
    const uncovered = [
        'cargo build --features extra',
        'cargo build -p other --features extra',
        'cargo build --workspace --features extra',
    ];
    for (const command of uncovered) {
        const root = workspaceTree(APP(), { workflow: ciRun(command) });
        assert.equal(gapsOf(root, 'crates/app').length, 1, command);
    }
});

test('a multi-line run block with backslash continuations is one command', () => {
    const root = workspaceTree(APP(), {
        workflow: ciBlock([
            'cargo clippy --locked \\',
            '  -p app \\',
            '  --all-targets \\',
            '  --features extra \\',
            '  -- -D warnings',
        ]),
    });
    assert.deepEqual(gapsOf(root, 'crates/app'), []);
});

test('a folded run block is one command', () => {
    const root = workspaceTree(APP(), {
        workflow: `jobs:\n  build:\n    steps:\n      - run: >\n          cargo build -p app\n          --features extra\n`,
    });
    assert.deepEqual(gapsOf(root, 'crates/app'), []);
});

test('commands are separated at shell operators and arguments after -- are not cargo flags', () => {
    const root = workspaceTree(APP(), {
        workflow: ciBlock([
            'cargo build -p app && cargo test --features extra',
            'cargo test -p app -- --features extra',
            'cargo fmt -p app; cargo build -F extra',
            '# cargo build -p app --features extra',
        ]),
    });
    assert.equal(gapsOf(root, 'crates/app').length, 1);
});

test('--all-features covers the selected package and --workspace covers every member', () => {
    const selected = workspaceTree(APP(), { workflow: ciRun('cargo clippy -p app --all-features') });
    assert.deepEqual(gapsOf(selected, 'crates/app'), []);
    const wide = workspaceTree(APP(), { workflow: ciRun('cargo test --workspace --all-features') });
    assert.deepEqual(gapsOf(wide, 'crates/app'), []);
    const legacy = workspaceTree(APP(), { workflow: ciRun('cargo test --all --all-features') });
    assert.deepEqual(gapsOf(legacy, 'crates/app'), []);
});

test('--all-features alone, for another package, or with the package excluded covers nothing', () => {
    for (const command of [
        'cargo build --all-features',
        'cargo build -p other --all-features',
        'cargo build --workspace --exclude app --all-features',
        'cargo build --workspace --exclude=app --all-features',
        'cargo build --workspace',
    ]) {
        const root = workspaceTree(APP(), { workflow: ciRun(command) });
        assert.equal(gapsOf(root, 'crates/app').length, 1, command);
    }
});

test('a value written as a GitHub expression or shell variable cannot be resolved and covers nothing', () => {
    for (const command of [
        'cargo build -p app --features ${{ matrix.features }}',
        'cargo build -p app --features "${{ matrix.a }} ${{ matrix.b }}"',
        'cargo build --features app/${{ matrix.feature }}',
        'cargo build -p ${{ matrix.package }} --features extra',
        'cargo build -p app --features $FEATURES',
        'cargo build $BUILD_ARGS',
    ]) {
        const root = workspaceTree(APP(), { workflow: ciRun(command) });
        assert.equal(gapsOf(root, 'crates/app').length, 1, command);
    }
});

test('a resolvable value next to an unresolvable one still counts', () => {
    const root = workspaceTree(APP(), { workflow: ciRun('cargo build -p app --features ${{ matrix.f }},extra') });
    assert.deepEqual(gapsOf(root, 'crates/app'), []);
});

test('a dependent crate turns a feature on in any dependency table', () => {
    const tables = [
        '[dependencies]\napp = { path = "../app", features = ["extra"] }',
        '[dev-dependencies]\napp = { path = "../app", features = ["extra"] }',
        '[build-dependencies]\napp = { path = "../app", features = ["extra"] }',
        `[target.'cfg(target_os = "linux")'.dependencies]\napp = { path = "../app", features = ["extra"] }`,
        `[target.'cfg(windows)'.dev-dependencies]\napp = { path = "../app", features = ["extra"] }`,
        '[dependencies.app]\npath = "../app"\nfeatures = ["extra"]',
    ];
    for (const table of tables) {
        const root = workspaceTree({
            ...APP(),
            'crates/user/Cargo.toml': crate('user', `\n${table}\n`),
        }, { workflow: ciRun('cargo build') });
        assert.deepEqual(gapsOf(root, 'crates/app'), [], table);
    }
});

test('a dependency entry without that feature, or from a crate outside the workspace, covers nothing', () => {
    const root = workspaceTree({
        ...APP(),
        'crates/user/Cargo.toml': crate('user', '\n[dependencies]\napp = { path = "../app", features = ["other"] }\n'),
        'outside/Cargo.toml': crate('outside', '\n[dependencies]\napp = { path = "../crates/app", features = ["extra"] }\n'),
    }, { workflow: ciRun('cargo build') });
    assert.equal(gapsOf(root, 'crates/app').length, 1);
});

test('root workspace.dependencies features and workspace-inherited entries count', () => {
    const root = workspaceTree({
        ...APP(),
        'Cargo.toml': '[workspace]\nmembers = ["crates/*"]\n\n[workspace.dependencies]\napp = { path = "crates/app", features = ["extra"] }\n',
    }, { workflow: ciRun('cargo build') });
    assert.deepEqual(gapsOf(root, 'crates/app'), []);
    const inherited = workspaceTree({
        ...APP(),
        'crates/user/Cargo.toml': crate('user', '\n[dependencies]\napp = { workspace = true, features = ["extra"] }\n'),
    }, { workflow: ciRun('cargo build') });
    assert.deepEqual(gapsOf(inherited, 'crates/app'), []);
});

test('a renamed dependency covers the package it names', () => {
    const root = workspaceTree({
        ...APP(),
        'crates/user/Cargo.toml': crate('user', '\n[dependencies]\nrenamed = { package = "app", path = "../app", features = ["extra"] }\n'),
    }, { workflow: ciRun('cargo build') });
    assert.deepEqual(gapsOf(root, 'crates/app'), []);
});

test('a plugin.toml [build] features list covers the plugin features', () => {
    const root = workspaceTree({
        ...APP('extra = []\nother = []'),
        'crates/app/plugin.toml': '[plugin]\nname = "app"\n\n[build]\nfeatures = ["extra"]\n',
    }, { workflow: ciRun('cargo build') });
    const gaps = gapsOf(root, 'crates/app');
    assert.equal(gaps.length, 1);
    assert.match(gaps[0], /feature `other`/);
});

test('the default list covers its entries and itself is never reported', () => {
    const root = workspaceTree(APP('default = ["extra"]\nextra = []\nother = []'), { workflow: ciRun('cargo build') });
    const gaps = gapsOf(root, 'crates/app');
    assert.equal(gaps.length, 1);
    assert.match(gaps[0], /feature `other`/);
});

test('a covered feature covers the features its list names, through any chain', () => {
    const root = workspaceTree({
        'crates/app/Cargo.toml': crate('app', '\n[features]\ntop = ["middle"]\nmiddle = ["lower", "dep:serde"]\nlower = []\nunrelated = []\nserde = []\n'),
    }, { workflow: ciRun('cargo build -p app --features top') });
    const gaps = gapsOf(root, 'crates/app');
    assert.deepEqual(gaps.map(message => /feature `(\w+)`/.exec(message)[1]), ['unrelated', 'serde']);
});

test('a covered feature covers the dependency features it names with pkg/feat and pkg?/feat', () => {
    const root = workspaceTree({
        'crates/app/Cargo.toml': crate('app', '\n[features]\nextra = []\nmore = []\n'),
        'crates/user/Cargo.toml': crate('user', '\n[dependencies]\napp = { path = "../app", optional = true }\n\n[features]\nall = ["app/extra", "app?/more"]\n'),
    }, { workflow: ciRun('cargo build -p user --features all') });
    assert.deepEqual(gapsOf(root, 'crates/app'), []);
    assert.deepEqual(gapsOf(root, 'crates/user'), []);
});

test('a dep: entry is an optional dependency and covers no feature', () => {
    const root = workspaceTree({
        'crates/app/Cargo.toml': crate('app', '\n[features]\nextra = ["dep:serde"]\nserde = []\n'),
    }, { workflow: ciRun('cargo build -p app --features extra') });
    const gaps = gapsOf(root, 'crates/app');
    assert.equal(gaps.length, 1);
    assert.match(gaps[0], /feature `serde`/);
});

test('excluded directories and non-member manifests are not reported', () => {
    const root = workspaceTree({
        ...APP(),
        'crates/skipped/Cargo.toml': crate('skipped', '\n[features]\nextra = []\n'),
        'elsewhere/Cargo.toml': crate('elsewhere', '\n[features]\nextra = []\n'),
    }, { exclude: '["crates/skipped"]', workflow: ciRun('cargo build') });
    assert.equal(gapsOf(root, 'crates/app').length, 1);
    assert.deepEqual(gapsOf(root, 'crates/skipped'), []);
    assert.deepEqual(gapsOf(root, 'elsewhere'), []);
});

test('a repository without workflows reports nothing', () => {
    const root = workspaceTree(APP());
    assert.deepEqual(gapsOf(root, 'crates/app'), []);
});

test('the workspace is read once per repository root in a lint run', () => {
    const root = workspaceTree(APP(), { workflow: ciRun('cargo build') });
    assert.equal(gapsOf(root, 'crates/app').length, 1);
    fs.writeFileSync(path.join(root, '.github/workflows/ci.yml'), ciRun('cargo build -p app --features extra'));
    assert.equal(gapsOf(root, 'crates/app').length, 1);
});

test('feature coverage reads other workflow files too', () => {
    const root = workspaceTree({
        ...APP(),
        '.github/workflows/release.yaml': ciRun('cargo build -p app --features extra'),
    }, { workflow: ciRun('cargo build') });
    assert.deepEqual(gapsOf(root, 'crates/app'), []);
});
