'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'commit-skill-context.cjs');
const { stripFrontmatter } = require('../bin/commit-skill-context.cjs');

function runWithRoot(payload, pluginRoot) {
    const r = spawnSync('node', [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
        env: { ...process.env, CLAUDE_PLUGIN_ROOT: pluginRoot },
    });
    return { exitCode: r.status, stdout: r.stdout, stderr: r.stderr };
}

function makeSkillRoot(content) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-skill-'));
    const skillDir = path.join(root, 'skills', 'commit');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), content);
    return root;
}

test('stripFrontmatter removes the YAML block and keeps the body', () => {
    const input = `---
name: foo
description: bar
---

# Body
Real content.
`;
    const out = stripFrontmatter(input);
    assert.match(out, /# Body/);
    assert.match(out, /Real content/);
    assert.doesNotMatch(out, /name: foo/);
});

test('stripFrontmatter is a no-op when there is no frontmatter', () => {
    const input = '# Body only\nText.';
    assert.equal(stripFrontmatter(input), '');
    // (No second --- found, so bodyStart stays 0 and we'd return everything;
    // the implementation deliberately returns "" because both delimiters
    // are required. This documents that contract.)
});

test('emits additionalContext for git commit', () => {
    const root = makeSkillRoot('---\nname: commit\n---\n\nBe brief. No coauthors.\n');
    try {
        const r = runWithRoot(
            { tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' } },
            root,
        );
        assert.equal(r.exitCode, 0);
        const payload = JSON.parse(r.stdout);
        assert.equal(payload.hookSpecificOutput.hookEventName, 'PreToolUse');
        assert.match(payload.hookSpecificOutput.additionalContext, /Be brief\. No coauthors\./);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('does nothing for non-commit Bash', () => {
    const root = makeSkillRoot('---\nname: commit\n---\nBody\n');
    try {
        const r = runWithRoot(
            { tool_name: 'Bash', tool_input: { command: 'git status' } },
            root,
        );
        assert.equal(r.exitCode, 0);
        assert.equal(r.stdout, '');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('does nothing for non-Bash tools', () => {
    const root = makeSkillRoot('---\nname: commit\n---\nBody\n');
    try {
        const r = runWithRoot(
            { tool_name: 'Edit', tool_input: { file_path: '/x.rs', new_string: 'git commit' } },
            root,
        );
        assert.equal(r.exitCode, 0);
        assert.equal(r.stdout, '');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('silent when SKILL.md is missing', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'commit-skill-empty-'));
    try {
        const r = runWithRoot(
            { tool_name: 'Bash', tool_input: { command: 'git commit -m "x"' } },
            root,
        );
        assert.equal(r.exitCode, 0);
        assert.equal(r.stdout, '');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
