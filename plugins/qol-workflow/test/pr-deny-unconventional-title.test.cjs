'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prTitle } = require('../bin/pr-deny-unconventional-title.cjs');

const HOOK = path.join(__dirname, '..', 'bin', 'pr-deny-unconventional-title.cjs');

function repo({ gate }) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-pr-title-test-'));
    spawnSync('git', ['init', '--quiet', root]);
    if (gate) {
        fs.mkdirSync(path.join(root, '.githooks'));
        fs.writeFileSync(
            path.join(root, '.githooks', 'commit-msg'),
            '#!/usr/bin/env bash\nsubject="$(head -n1 "$1")"\n' +
                'printf "%s\\n" "$subject" | grep -qE "^(feat|fix|refactor)(\\([a-z-]+\\))?: .+" && exit 0\n' +
                'echo "not a conventional commit" >&2\nexit 1\n',
        );
    }
    return root;
}

function run(command, cwd) {
    const result = spawnSync('node', [HOOK], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd }),
        encoding: 'utf8',
    });
    if (!result.stdout.trim()) return null;
    return JSON.parse(result.stdout).hookSpecificOutput;
}

test('reads the title from every flag form', () => {
    assert.deepEqual(prTitle('gh pr create --title "feat: a b" --body x'), { verb: 'create', title: 'feat: a b' });
    assert.deepEqual(prTitle("gh pr edit 41 -t 'fix(peers): c'"), { verb: 'edit', title: 'fix(peers): c' });
    assert.deepEqual(prTitle('cd x && gh pr create --title=refactor:\\ d'), { verb: 'create', title: 'refactor: d' });
    assert.deepEqual(prTitle('gh pr create --fill'), { verb: 'create', title: null });
    assert.equal(prTitle('gh pr view 41'), null);
});

test('denies a sentence title and names the gate', () => {
    const root = repo({ gate: true });
    const denied = run('gh pr create --title "Launcher and settings marks" --body x', root);
    assert.equal(denied.permissionDecision, 'deny');
    assert.match(denied.permissionDecisionReason, /not a conventional commit/);
    assert.match(denied.permissionDecisionReason, /feat bumps minor/);
});

test('denies a renamed title on gh pr edit', () => {
    const root = repo({ gate: true });
    assert.equal(run('gh pr edit 41 --title "WORKSPACE-41 Consolidate state"', root).permissionDecision, 'deny');
});

test('allows a conventional title', () => {
    const root = repo({ gate: true });
    assert.equal(run('gh pr create --title "feat(launcher): draw marks" --body x', root), null);
});

test('denies gh pr create without a title and allows an edit without one', () => {
    const root = repo({ gate: true });
    assert.equal(run('gh pr create --fill', root).permissionDecision, 'deny');
    assert.equal(run('gh pr edit 41 --add-label x', root), null);
});

test('lets shell-built titles through for the merge queue to check', () => {
    const root = repo({ gate: true });
    assert.equal(run('gh pr create --title "$(git log -1 --format=%s)"', root), null);
});

test('ignores repositories without a commit-msg gate', () => {
    const root = repo({ gate: false });
    assert.equal(run('gh pr create --title "Anything goes"', root), null);
});
