'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const workflowRoot = path.resolve(__dirname, '..');
const gitTrees = fs.readFileSync(
    path.join(workflowRoot, 'skills', 'git-trees', 'SKILL.md'),
    'utf8',
);
const gitPush = fs.readFileSync(
    path.join(workflowRoot, 'skills', 'git-push', 'SKILL.md'),
    'utf8',
);

test('git-trees preserves the mandatory Cargo.lock merge-driver contract', () => {
    assert.match(gitTrees, /mandatory Cargo\.lock merge driver/);
    assert.match(gitTrees, /\.gitattributes.*\/Cargo\.lock.*merge=cargo-lock/);
    assert.match(gitTrees, /qol setup/);
    assert.match(gitTrees, /git check-attr merge -- Cargo\.lock/);
    assert.match(gitTrees, /git config --get merge\.cargo-lock\.driver/);
    assert.match(gitTrees, /\.githooks\/cargo-lock-merge %O %A %B %P/);
    assert.match(gitTrees, /never resolve a root `Cargo\.lock` conflict by hand/i);
});

test('git-push routes pull and rebase through the canonical driver contract', () => {
    assert.match(gitPush, /Cargo\.lock.*merge-driver contract/);
    assert.match(gitPush, /qol-workflow:git-trees/);
});
