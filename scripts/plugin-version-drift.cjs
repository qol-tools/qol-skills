#!/usr/bin/env node
/*
 * Report plugins whose content changed after their last version bump.
 *
 * The plugin caches of Claude Code, Codex, and Kimi Code key on the published
 * version. Editing a skill without bumping means a consumer's `/reload-plugins`
 * can keep serving the previous build, and the edit looks like a silent no-op.
 * `release-plugins.yml` also mints a release per NEW version, so an unbumped
 * plugin never gets a zip asset either.
 *
 * Usage:
 *   node scripts/plugin-version-drift.cjs [--root <dir>] [--check]
 *
 * --check exits 1 when any plugin has drifted, for CI.
 *
 * Manifest directories and tests are excluded from "content": regenerating a
 * manifest or fixing a test is not a shipped behavior change.
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MANIFEST_DIRS = ['.claude-plugin', '.codex-plugin', '.kimi-plugin'];
const NON_CONTENT_DIRS = [...MANIFEST_DIRS, 'test'];

function parseArgs(argv) {
  const options = { root: process.cwd(), check: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') options.root = argv[++i];
    else if (argv[i] === '--check') options.check = true;
  }
  return options;
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function assertFullHistory(root) {
  if (git(root, ['rev-parse', '--is-shallow-repository']) !== 'true') return;

  throw new Error(
    'Shallow clone: the last version bump can predate the available history, ' +
      'so drift silently under-reports. Run `git fetch --unshallow`, or check out ' +
      'with fetch-depth: 0 in CI.',
  );
}

function pluginNames(root) {
  const dir = path.join(root, 'plugins');
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function lastVersionCommit(root, name) {
  const manifest = `plugins/${name}/.claude-plugin/plugin.json`;
  const output = git(root, ['log', '-1', '--format=%H', '-G"version"', '--', manifest]);
  return output.length > 0 ? output : undefined;
}

function contentCommitsSince(root, name, since) {
  const pathspec = [
    `plugins/${name}`,
    ...NON_CONTENT_DIRS.map((dir) => `:(exclude)plugins/${name}/${dir}`),
  ];
  const output = git(root, ['rev-list', '--count', `${since}..HEAD`, '--', ...pathspec]);
  return Number.parseInt(output, 10) || 0;
}

function versionDrift(root) {
  assertFullHistory(root);

  const drifted = [];
  for (const name of pluginNames(root)) {
    const manifestFile = path.join(root, 'plugins', name, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(manifestFile)) continue;

    const since = lastVersionCommit(root, name);
    if (since === undefined) continue;

    const commits = contentCommitsSince(root, name, since);
    if (commits === 0) continue;

    const { version } = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    drifted.push({ name, version, commits });
  }
  return drifted.sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name));
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  let drifted;

  try {
    drifted = versionDrift(options.root);
  } catch (error) {
    console.error(error.message);
    return 1;
  }

  if (drifted.length === 0) {
    console.log('Every plugin version covers its current content.');
    return 0;
  }

  console.error('Plugins changed since their last version bump:');
  for (const { name, version, commits } of drifted) {
    console.error(`- ${name} (v${version}): ${commits} content commit(s)`);
  }
  console.error('');
  console.error('Bump each plugin.json version, then re-run scripts/sync-plugin-manifests.cjs.');

  return options.check ? 1 : 0;
}

module.exports = { versionDrift, pluginNames, assertFullHistory, NON_CONTENT_DIRS };

if (require.main === module) {
  process.exit(main());
}
