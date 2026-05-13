'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'branch-deny-pid-branch-name.cjs');
const QOL_CWD = '/media/kmrh47/WD_SN850X/Git/qol-tools/qol-tray';
const OTHER_CWD = '/home/anywhere/else';

function run(command, cwd = QOL_CWD) {
    const r = spawnSync('node', [HOOK], {
        input: JSON.stringify({
            tool_name: 'Bash',
            tool_input: { command, cwd },
        }),
        encoding: 'utf8',
    });
    if (!r.stdout.trim()) return { decision: null, exit: r.status };
    const obj = JSON.parse(r.stdout);
    return {
        decision: obj.hookSpecificOutput && obj.hookSpecificOutput.permissionDecision,
        exit: r.status,
    };
}

test('blocks PID-prefixed branch names across every creation flag', () => {
    const cases = [
        'git checkout -b tray-32-integration',
        'git checkout -B alttab-2-fix',
        'git switch -c launcher-7-frecency',
        'git switch -C lights-3-pair',
        'git worktree add ../wt/tray-42-foo -b tray-42-foo',
        'git branch csess-1-resume',
    ];
    for (const cmd of cases) {
        const r = run(cmd);
        assert.equal(r.decision, 'deny', `expected deny for: ${cmd}`);
    }
});

test('allows topic-named branches', () => {
    const cases = [
        'git checkout -b wasm',
        'git switch -c theming',
        'git worktree add ../wt/qol-tray/wasm -b wasm',
        'git branch sync-v2',
    ];
    for (const cmd of cases) {
        const r = run(cmd);
        assert.equal(r.decision, null, `expected pass for: ${cmd}`);
    }
});

test('ignores non-creation git verbs', () => {
    const cases = [
        'git checkout main',
        'git status',
        'git log --oneline -5',
        'git push',
        'git branch -d tray-32-integration',
        'git branch -D alttab-2-foo',
        'git branch -m old new',
        'git branch -v',
    ];
    for (const cmd of cases) {
        const r = run(cmd);
        assert.equal(r.decision, null, `expected pass for: ${cmd}`);
    }
});

test('respects # intentional bypass', () => {
    const r = run('git checkout -b tray-99-only-here # intentional: single-repo refactor');
    assert.equal(r.decision, null);
});

test('ignores commands outside the qol-tools workspace', () => {
    const r = run('git checkout -b tray-32-foo', OTHER_CWD);
    assert.equal(r.decision, null);
});
