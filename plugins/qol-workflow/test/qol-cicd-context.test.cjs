'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'qol-cicd-context.cjs');
const {
    stripFrontmatter,
    CICD_TOPIC_PATTERN,
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

test('CICD_TOPIC_PATTERN matches CI/workflow/hook prose', () => {
    assert.ok(CICD_TOPIC_PATTERN.test('how do I set up CI for this repo'));
    assert.ok(CICD_TOPIC_PATTERN.test('add a pre-push hook'));
    assert.ok(CICD_TOPIC_PATTERN.test('the workflow keeps failing'));
    assert.ok(CICD_TOPIC_PATTERN.test('should we use lefthook or cargo-husky'));
    assert.ok(CICD_TOPIC_PATTERN.test('cargo fmt failed in CI'));
    assert.ok(CICD_TOPIC_PATTERN.test('qol-cicd reusable workflow'));
});

test('CICD_TOPIC_PATTERN ignores unrelated prose', () => {
    assert.ok(!CICD_TOPIC_PATTERN.test('refactor the picker layout'));
    assert.ok(!CICD_TOPIC_PATTERN.test('the popup ghost is misaligned'));
    assert.ok(!CICD_TOPIC_PATTERN.test('what is the focused monitor'));
});

test('QOL_WORKSPACE_PATTERN scopes to qol repository paths', () => {
    assert.ok(QOL_WORKSPACE_PATTERN.test('/Users/x/repos/private/qol-tools/plugin-alt-tab'));
    assert.ok(QOL_WORKSPACE_PATTERN.test('/media/x/Git/qol-monorepo'));
    assert.ok(QOL_WORKSPACE_PATTERN.test('/media/x/Git/qol-skills/plugins/qol-workflow'));
    assert.ok(QOL_WORKSPACE_PATTERN.test('C:\\Git\\plugin-launcher'));
    assert.ok(!QOL_WORKSPACE_PATTERN.test('/Users/x/repos/my-qol-project'));
    assert.ok(!QOL_WORKSPACE_PATTERN.test('/Users/x/other-project'));
});

test('stripFrontmatter peels the YAML header', () => {
    const body = stripFrontmatter('---\nname: x\n---\nhello world\n');
    assert.equal(body.trim(), 'hello world');
});

test('stripFrontmatter returns empty when no frontmatter', () => {
    assert.equal(stripFrontmatter('plain markdown'), '');
});

test('injects context for matching prompt in the monorepo cwd', () => {
    const r = run({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'why did the CI workflow fail with rustfmt',
        cwd: '/media/x/Git/qol-monorepo',
    });
    assert.equal(r.exitCode, 0);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
    const context = parsed.hookSpecificOutput.additionalContext;
    assert.match(context, /qol-\* or plugin-\* repository path/);
    assert.doesNotMatch(context, /territory in qol-tools/);
    assert.match(context, /qol-project:qol-cicd/);
    assert.match(context, /qol-project:qol-arch-cicd/);
    assert.match(context, /qol-monorepo product workflows/);
    assert.doesNotMatch(context, /qol-cicd\/\.github\/workflows/);
});

test('injects repository-local guidance for a qol-skills CI prompt', () => {
    const r = run({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'update the manifest sync CI workflow',
        cwd: '/media/x/Git/qol-skills',
    });
    assert.equal(r.exitCode, 0);
    const context = JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /qol-skills automation/);
    assert.match(context, /qol-skills, inspect its own \.github workflows/);
    assert.doesNotMatch(context, /qol-cicd\/\.github\/workflows/);
});

test('silent when prompt matches but cwd is outside qol/plugin repository paths', () => {
    const r = run({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'add a pre-push hook',
        cwd: '/Users/x/other-project',
    }, { PWD: '/Users/x/other-project' });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim(), '');
});

test('silent when cwd is a qol repository but prompt is off-topic', () => {
    const r = run({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'fix the ghost popup placement',
        cwd: '/media/x/Git/qol-monorepo',
    });
    assert.equal(r.exitCode, 0);
    assert.equal(r.stdout.trim(), '');
});

test('silent for non-UserPromptSubmit event', () => {
    const r = run({
        hook_event_name: 'PreToolUse',
        prompt: 'CI workflow',
        cwd: '/Users/x/repos/private/qol-tools/plugin-alt-tab',
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
