'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');

const { bumpPatch } = require('../scripts/plugin-bump.cjs');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'plugin-bump.cjs');

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, stdio: 'pipe' });
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-skills-bump-'));
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  return root;
}

function writePlugin(root, name, version, skillBody) {
  const pluginDir = path.join(root, 'plugins', name);
  fs.mkdirSync(path.join(pluginDir, 'skills', name), { recursive: true });
  fs.mkdirSync(path.join(pluginDir, '.claude-plugin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, 'skills', name, 'SKILL.md'),
    `---\ndescription: ${name} skill.\n---\n${skillBody}\n`,
  );
  writeJson(path.join(pluginDir, '.claude-plugin', 'plugin.json'), {
    name,
    description: `${name} plugin.`,
    version,
    author: { name: 'KMRH47' },
  });
}

function writeMarketplace(root) {
  fs.mkdirSync(path.join(root, '.claude-plugin'), { recursive: true });
  writeJson(path.join(root, '.claude-plugin', 'marketplace.json'), {
    name: 'qol-skills',
    owner: { name: 'KMRH47' },
    plugins: [{ name: 'alpha', source: 'plugins/alpha' }],
  });
}

function commit(root, message) {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
}

function runBump(root) {
  return spawnSync('node', [SCRIPT, '--root', root], { encoding: 'utf8' });
}

test('bumpPatch raises the patch component only', () => {
  assert.equal(bumpPatch('0.1.0'), '0.1.1');
  assert.equal(bumpPatch('1.2.3'), '1.2.4');
  assert.equal(bumpPatch('0.0.0'), '0.0.1');
  assert.throws(() => bumpPatch('0.1'), /non-numeric version/);
  assert.throws(() => bumpPatch('a.b.c'), /non-numeric version/);
});

test('no drift leaves the tree untouched', () => {
  const root = repo();
  writePlugin(root, 'alpha', '0.1.0', 'one');
  writeMarketplace(root);
  commit(root, 'add alpha');
  writePlugin(root, 'alpha', '0.1.1', 'two');
  commit(root, 'edit alpha and bump');

  const before = fs.readFileSync(
    path.join(root, 'plugins', 'alpha', '.claude-plugin', 'plugin.json'),
    'utf8',
  );
  const result = runBump(root);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    fs.readFileSync(path.join(root, 'plugins', 'alpha', '.claude-plugin', 'plugin.json'), 'utf8'),
    before,
  );
  assert.equal(git(root, 'status', '--porcelain').length, 0);
});

test('drifted content is patch-bumped and the manifests resync', () => {
  const root = repo();
  writePlugin(root, 'alpha', '0.1.0', 'one');
  writeMarketplace(root);
  commit(root, 'add alpha');

  const skillFile = path.join(root, 'plugins', 'alpha', 'skills', 'alpha', 'SKILL.md');
  fs.writeFileSync(skillFile, '---\ndescription: alpha skill.\n---\ntwo\n');
  commit(root, 'edit alpha without a bump');

  const result = runBump(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /alpha 0\.1\.0 -> 0\.1\.1/);

  const claude = JSON.parse(
    fs.readFileSync(path.join(root, 'plugins', 'alpha', '.claude-plugin', 'plugin.json'), 'utf8'),
  );
  assert.equal(claude.version, '0.1.1');

  const codex = JSON.parse(
    fs.readFileSync(path.join(root, 'plugins', 'alpha', '.codex-plugin', 'plugin.json'), 'utf8'),
  );
  assert.equal(codex.version, '0.1.1');

  commit(root, 'chore(plugins): bump plugin versions');

  const drift = spawnSync(
    'node',
    [path.join(__dirname, '..', 'scripts', 'plugin-version-drift.cjs'), '--check', '--root', root],
    { encoding: 'utf8' },
  );
  assert.equal(drift.status, 0, drift.stderr);
});
