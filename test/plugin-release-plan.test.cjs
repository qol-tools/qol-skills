'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { releasePlan, readExistingTags } = require('../scripts/plugin-release-plan.cjs');

function fixture(plugins) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-skills-release-'));
  for (const [name, version] of plugins) {
    const dir = path.join(root, 'plugins', name, '.claude-plugin');
    fs.mkdirSync(dir, { recursive: true });
    const manifest = version === undefined ? { name } : { name, version };
    fs.writeFileSync(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
  }
  return root;
}

test('release plan names one tag and asset per plugin version', () => {
  const root = fixture([
    ['alpha', '1.2.3'],
    ['beta', '0.1.0'],
  ]);

  assert.deepEqual(releasePlan(root, new Set()), [
    { name: 'alpha', version: '1.2.3', tag: 'alpha-v1.2.3', asset: 'alpha-1.2.3.zip' },
    { name: 'beta', version: '0.1.0', tag: 'beta-v0.1.0', asset: 'beta-0.1.0.zip' },
  ]);
});

test('release plan skips versions that already have a tag', () => {
  const root = fixture([
    ['alpha', '1.2.3'],
    ['beta', '0.1.0'],
  ]);

  const plan = releasePlan(root, new Set(['alpha-v1.2.3']));

  assert.deepEqual(
    plan.map((entry) => entry.tag),
    ['beta-v0.1.0'],
    'a published version must never be re-released',
  );
});

test('release plan ignores plugins without a usable version', () => {
  const cases = [
    [[['alpha', undefined]], []],
    [[['alpha', '']], []],
    [[['alpha', '1.0.0']], ['alpha-v1.0.0']],
  ];

  for (const [plugins, expected] of cases) {
    const root = fixture(plugins);
    assert.deepEqual(
      releasePlan(root, new Set()).map((entry) => entry.tag),
      expected,
      `plugins: ${JSON.stringify(plugins)}`,
    );
  }
});

test('existing tags parse ignores blank lines and surrounding space', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-skills-tags-'));
  const file = path.join(root, 'tags.txt');
  fs.writeFileSync(file, 'alpha-v1.0.0\n\n  beta-v2.0.0  \n');

  assert.deepEqual([...readExistingTags(file)].sort(), ['alpha-v1.0.0', 'beta-v2.0.0']);
  assert.deepEqual([...readExistingTags(path.join(root, 'missing.txt'))], []);
});
