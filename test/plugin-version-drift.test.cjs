'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { versionDrift } = require('../scripts/plugin-version-drift.cjs');

function git(root, ...args) {
  execFileSync('git', args, { cwd: root, stdio: 'pipe' });
}

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-skills-drift-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  return root;
}

function writeManifest(root, name, version) {
  const dir = path.join(root, 'plugins', name, '.claude-plugin');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'plugin.json'), `${JSON.stringify({ name, version }, null, 2)}\n`);
}

function writeSkill(root, name, body) {
  const dir = path.join(root, 'plugins', name, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), body);
}

function commit(root, message) {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
}

test('a plugin bumped in the same commit as its content has no drift', () => {
  const root = repo();
  writeManifest(root, 'alpha', '0.1.0');
  writeSkill(root, 'alpha', 'one');
  commit(root, 'add alpha');

  writeManifest(root, 'alpha', '0.2.0');
  writeSkill(root, 'alpha', 'two');
  commit(root, 'edit alpha and bump');

  assert.deepEqual(versionDrift(root), []);
});

test('content edited after the last bump is reported with its commit count', () => {
  const root = repo();
  writeManifest(root, 'alpha', '0.1.0');
  writeSkill(root, 'alpha', 'one');
  commit(root, 'add alpha');

  writeSkill(root, 'alpha', 'two');
  commit(root, 'edit alpha');
  writeSkill(root, 'alpha', 'three');
  commit(root, 'edit alpha again');

  assert.deepEqual(versionDrift(root), [{ name: 'alpha', version: '0.1.0', commits: 2 }]);
});

test('manifest and test edits do not count as shipped content', () => {
  const cases = [
    ['.codex-plugin/plugin.json', '{"name":"alpha"}'],
    ['.kimi-plugin/plugin.json', '{"name":"alpha"}'],
    ['test/alpha.test.cjs', '// test'],
  ];

  for (const [relative, body] of cases) {
    const root = repo();
    writeManifest(root, 'alpha', '0.1.0');
    writeSkill(root, 'alpha', 'one');
    commit(root, 'add alpha');

    const file = path.join(root, 'plugins', 'alpha', relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, body);
    commit(root, `touch ${relative}`);

    assert.deepEqual(versionDrift(root), [], `edited ${relative}`);
  }
});

test('drift is reported per plugin, busiest first', () => {
  const root = repo();
  writeManifest(root, 'alpha', '0.1.0');
  writeSkill(root, 'alpha', 'one');
  writeManifest(root, 'beta', '0.1.0');
  writeSkill(root, 'beta', 'one');
  commit(root, 'add plugins');

  writeSkill(root, 'beta', 'two');
  commit(root, 'edit beta');
  writeSkill(root, 'beta', 'three');
  commit(root, 'edit beta again');
  writeSkill(root, 'alpha', 'two');
  commit(root, 'edit alpha');

  assert.deepEqual(
    versionDrift(root).map((entry) => [entry.name, entry.commits]),
    [
      ['beta', 2],
      ['alpha', 1],
    ],
  );
});
