'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'qol-cicd-context.cjs');
const {
    stripFrontmatter,
    CI_HOOK_PATTERN,
    QOL_WORKSPACE_PATTERN,
} = require('../bin/qol-cicd-context.cjs');

function run(payload, env = {}) {
    const r = spawnSync('node', [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, ...env },
    });
    return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

test('CI_HOOK_PATTERN matches workflow/hook tooling keywords', () => {
    assert.ok(CI_HOOK_PATTERN.test('cargo install cargo-husky'));
    assert.ok(CI_HOOK_PATTERN.test('brew install lefthook'));
    assert.ok(CI_HOOK_PATTERN.test('cat .github/workflows/lint.yml'));
    assert.ok(CI_HOOK_PATTERN.test('vim .git/hooks/pre-commit'));
    assert.ok(CI_HOOK_PATTERN.test('qol-install-hooks'));
    assert.ok(CI_HOOK_PATTERN.test('grep workflow_call .github/'));
});

test('CI_HOOK_PATTERN does not match unrelated bash', () => {
    assert.ok(!CI_HOOK_PATTERN.test('ls -la'));
    assert.ok(!CI_HOOK_PATTERN.test('cargo build'));
    assert.ok(!CI_HOOK_PATTERN.test('git status'));
});

test('QOL_WORKSPACE_PATTERN matches qol-tools paths', () => {
    assert.ok(QOL_WORKSPACE_PATTERN.test('/Users/x/repos/private/qol-tools/plugin-alt-tab'));
    assert.ok(QOL_WORKSPACE_PATTERN.test('cd qol-tools/qol-cicd && ls'));
    assert.ok(!QOL_WORKSPACE_PATTERN.test('/Users/x/other-project'));
});

test('stripFrontmatter peels the YAML header', () => {
    const body = stripFrontmatter('---\nname: x\n---\nhello world\n');
    assert.equal(body.trim(), 'hello world');
});

test('stripFrontmatter returns empty when no frontmatter', () => {
    assert.equal(stripFrontmatter('plain markdown'), '');
});

test('injects context for matching Bash invocation in qol-tools cwd', () => {
    const r = run({
        tool_name: 'Bash',
        tool_input: { command: 'cat .github/workflows/lint.yml' },
        cwd: '/Users/x/repos/private/qol-tools/plugin-alt-tab',
    });
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(parsed.hookSpecificOutput.additionalContext, /qol-cicd/);
});

test('silent when command matches but cwd is outside qol-tools', () => {
    const r = run({
        tool_name: 'Bash',
        tool_input: { command: 'cat .github/workflows/lint.yml' },
        cwd: '/Users/x/other-project',
    }, { PWD: '/Users/x/other-project' });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim(), '');
});

test('silent for non-Bash tool', () => {
    const r = run({
        tool_name: 'Read',
        tool_input: { file_path: '/qol-tools/x/.github/workflows/a.yml' },
        cwd: '/qol-tools/x',
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim(), '');
});

test('silent for empty stdin', () => {
    const r = spawnSync('node', [HOOK], { input: '', encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
});

test('silent for non-JSON stdin', () => {
    const r = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), '');
});
