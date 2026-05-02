'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'commit-deny-coauthor.cjs');
const {
    COMMIT_INVOCATION,
    findOffendingPattern,
    extractFileArg,
} = require('../bin/commit-deny-coauthor.cjs');

function run(payload) {
    const r = spawnSync('node', [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
    });
    return { exitCode: r.status, stderr: r.stderr };
}

test('detects co-authored-by attribution', () => {
    assert.ok(findOffendingPattern('Co-Authored-By: Claude <noreply@anthropic.com>'));
    assert.ok(findOffendingPattern('co_authored_by:'));
    assert.ok(findOffendingPattern('CO-AUTHORED-BY:'));
});

test('detects "generated with Claude" variants', () => {
    assert.ok(findOffendingPattern('🤖 Generated with Claude Code'));
    assert.ok(findOffendingPattern('Generated with [Claude'));
});

test('detects anthropic.com email addresses', () => {
    assert.ok(findOffendingPattern('<noreply@anthropic.com>'));
    assert.ok(findOffendingPattern('<author@anthropic.com>'));
});

test('detects model attribution in trailers', () => {
    assert.ok(findOffendingPattern('Claude Opus 4.5'));
    assert.ok(findOffendingPattern('Claude Sonnet 4.6'));
});

test('lets clean commit messages through', () => {
    assert.equal(findOffendingPattern('feat(foo): add bar'), null);
    assert.equal(findOffendingPattern('docs: clarify the README'), null);
});

test('COMMIT_INVOCATION matches real commit shapes', () => {
    assert.ok(COMMIT_INVOCATION.test('git commit -m "foo"'));
    assert.ok(COMMIT_INVOCATION.test('cd /x && git commit'));
    // Known gap inherited from the bash original: tight regex skips
    // `git -C <path> commit ...`. Documented here so a future change
    // to broaden the pattern is intentional.
    assert.ok(!COMMIT_INVOCATION.test('git -C /repo commit -F msg.txt'));
});

test('COMMIT_INVOCATION ignores unrelated git invocations', () => {
    assert.ok(!COMMIT_INVOCATION.test('git log --oneline'));
    assert.ok(!COMMIT_INVOCATION.test('git diff'));
    assert.ok(!COMMIT_INVOCATION.test('git status'));
});

test('extractFileArg parses -F and --file forms', () => {
    assert.equal(extractFileArg('git commit -F msg.txt'), 'msg.txt');
    assert.equal(extractFileArg('git commit --file=msg.txt'), 'msg.txt');
    assert.equal(extractFileArg('git commit --file msg.txt'), 'msg.txt');
    assert.equal(extractFileArg('git commit -m "no file"'), null);
});

test('end-to-end: blocks inline -m commit with attribution', () => {
    const r = run({
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "feat: x\n\nCo-Authored-By: Claude"' },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /BLOCKED/);
});

test('end-to-end: passes clean inline commit', () => {
    const r = run({
        tool_name: 'Bash',
        tool_input: { command: 'git commit -m "feat: clean message"' },
    });
    assert.equal(r.exitCode, 0);
});

test('end-to-end: catches attribution in -F file', () => {
    const tmp = path.join(os.tmpdir(), `commit-msg-${Date.now()}.txt`);
    fs.writeFileSync(tmp, 'feat: x\n\nCo-Authored-By: Claude\n');
    try {
        const r = run({
            tool_name: 'Bash',
            tool_input: { command: `git commit -F ${tmp}` },
        });
        assert.equal(r.exitCode, 2);
    } finally {
        fs.unlinkSync(tmp);
    }
});

test('end-to-end: ignores non-Bash tools', () => {
    const r = run({
        tool_name: 'Edit',
        tool_input: { file_path: '/foo.rs', new_string: 'Co-Authored-By: Claude' },
    });
    assert.equal(r.exitCode, 0);
});

test('end-to-end: ignores non-commit Bash', () => {
    const r = run({
        tool_name: 'Bash',
        tool_input: { command: 'echo "Co-Authored-By: Claude"' },
    });
    assert.equal(r.exitCode, 0);
});
