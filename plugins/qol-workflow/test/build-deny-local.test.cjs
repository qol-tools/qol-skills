'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'build-deny-local.cjs');
const { findLocalCompile, inMonorepo } = require(HOOK);
const MONOREPO = '/media/x/Git/qol-monorepo';
const WORKTREE = '/media/x/Git/qol-monorepo-worktrees/topic';
const OTHER = '/home/someone/elsewhere';

function run(command, cwd = MONOREPO) {
    const r = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
        encoding: 'utf8',
    });
    if (!r.stdout.trim()) return { decision: null, exit: r.status };
    const out = JSON.parse(r.stdout).hookSpecificOutput;
    return { decision: out.permissionDecision, reason: out.permissionDecisionReason, exit: r.status };
}

test('deny text is a plain line then the tagged hint', () => {
    const r = run('cargo test -p qol');
    assert.equal(r.exit, 0);
    const lines = r.reason.split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^Local builds, tests and clippy in qol-monorepo are off: .*\(`cargo test`\)\.$/);
    assert.match(lines[1], /^\[build-deny-local\] .*qol pr try <number>.* # user approved local build/);
});

test('finds every compiling command', () => {
    const cases = {
        'cargo build -p qol': 'cargo build',
        'cargo b': 'cargo b',
        'cargo +nightly clippy --workspace -- -D warnings': 'cargo clippy',
        'cargo -q test': 'cargo test',
        'cargo --config net.offline=true check': 'cargo check',
        'cargo nextest run': 'cargo nextest',
        'cargo run -p qol-tray': 'cargo run',
        'cargo doc --no-deps': 'cargo doc',
        '~/.cargo/bin/cargo build': 'cargo build',
        'RUSTFLAGS=-Dwarnings cargo build': 'cargo build',
        'nice -n 19 cargo test': 'cargo test',
        'timeout 600 cargo clippy': 'cargo clippy',
        'env CARGO_TERM_COLOR=never cargo test': 'cargo test',
        'cd tools/cli && cargo build': 'cargo build',
        'git status; cargo check': 'cargo check',
        'cargo fmt --all && cargo test': 'cargo test',
        'cargo test 2>&1 | tail -5': 'cargo test',
        'echo $(cargo build)': 'cargo build',
        'qol build qol-tray': 'qol build',
        'qol -v check': 'qol check',
        'qol dev': 'qol dev',
        'qol install --dev': 'qol install',
        'qol setup': 'qol setup',
        'qol env up ubuntu --dev-worktree ../wt': 'qol env up --dev-worktree',
    };
    for (const [command, expected] of Object.entries(cases)) {
        assert.equal(findLocalCompile(command), expected, command);
    }
});

test('lets through commands that compile nothing', () => {
    const cases = [
        'cargo fmt --all',
        'cargo fmt --all -- --check',
        'cargo metadata --format-version 1',
        'cargo tree -p qol',
        'cargo update -p serde',
        'cargo hakari generate',
        'qac lint',
        'qol pr try 412',
        'qol pr try --off',
        'qol env up ubuntu',
        'qol doctor',
        'qol help build',
        'python3 -m py_compile .github/scripts/live_test.py',
        'git commit -m "fix: cargo build fails; cargo test too"',
        "rg 'cargo test' docs",
        'gh pr create --title "fix(cli): x" --body "run cargo build"',
        'ls # cargo build',
    ];
    for (const command of cases) {
        assert.equal(findLocalCompile(command), null, command);
    }
});

test('ignores a heredoc body', () => {
    const command = "git commit -F - <<'EOF'\nfix(cli): x\n\ncargo build\nEOF\ngit push";
    assert.equal(findLocalCompile(command), null);
    assert.equal(findLocalCompile("cat <<EOF > notes\ncargo test\nEOF\ncargo test"), 'cargo test');
});

test('scopes to qol-monorepo and its worktrees', () => {
    assert.equal(inMonorepo(MONOREPO, 'cargo build'), true);
    assert.equal(inMonorepo(WORKTREE, 'cargo build'), true);
    assert.equal(inMonorepo('/media/x/Git/worktrees/topic/qol-monorepo/libs', 'cargo build'), true);
    assert.equal(inMonorepo(OTHER, 'cargo build'), false);
    assert.equal(inMonorepo(OTHER, `cd ${WORKTREE} && cargo build`), true);
    assert.equal(inMonorepo(OTHER, `cargo build --manifest-path ${MONOREPO}/Cargo.toml`), true);
    assert.equal(inMonorepo('/media/x/Git/qol-monorepo-other', 'cargo build'), false);
});

test('denies in the monorepo and allows elsewhere', () => {
    assert.equal(run('cargo clippy --workspace').decision, 'deny');
    assert.equal(run('cargo test', WORKTREE).decision, 'deny');
    assert.equal(run('cargo test', OTHER).decision, null);
    assert.equal(run(`cd ${WORKTREE} && cargo build`, OTHER).decision, 'deny');
    assert.equal(run('cargo fmt --all').decision, null);
});

test('the approval comment lets a build through', () => {
    assert.equal(run('cargo build -p qol # user approved local build').decision, null);
    assert.equal(run('cargo build -p qol # intentional').decision, 'deny');
});

test('ignores other tools and bad input', () => {
    const other = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({ tool_name: 'Read', tool_input: { command: 'cargo build' }, cwd: MONOREPO }),
        encoding: 'utf8',
    });
    assert.equal(other.stdout, '');
    const bad = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
    assert.equal(bad.status, 0);
    assert.equal(bad.stdout, '');
});
