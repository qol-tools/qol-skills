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

test('passes when subagent is the caller', () => {
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
    assert.equal(r.exitCode, 0);
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
