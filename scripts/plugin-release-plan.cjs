#!/usr/bin/env node
/*
 * Emit the per-plugin release plan as JSON.
 *
 * Kimi Code installs a plugin from a GitHub URL or a zip URL, and its
 * `resolveGithubSource` takes only {owner, repo, ref} - there is no
 * subdirectory field, so a bare repo URL always downloads this whole
 * marketplace and `detectPluginRoot` finds no plugin manifest at its root.
 * A per-plugin zip asset is the only source form that lets one plugin out of
 * this monorepo install from a URL.
 *
 * Usage:
 *   node scripts/plugin-release-plan.cjs [--root <dir>] [--existing-tags <file>]
 *
 * --existing-tags takes a file of newline-separated tag names; plugins whose
 * tag is already present are omitted, so the workflow is idempotent and a
 * re-run after an unrelated push publishes nothing.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

function parseArgs(argv) {
  const options = { root: process.cwd(), existingTags: undefined };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') options.root = argv[++i];
    else if (argv[i] === '--existing-tags') options.existingTags = argv[++i];
  }
  return options;
}

function readExistingTags(file) {
  if (file === undefined) return new Set();
  if (!fs.existsSync(file)) return new Set();
  return new Set(
    fs
      .readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean),
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

function releasePlan(root, existingTags) {
  const plan = [];
  for (const name of pluginNames(root)) {
    const manifestFile = path.join(root, 'plugins', name, '.claude-plugin', 'plugin.json');
    if (!fs.existsSync(manifestFile)) continue;

    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    const version = manifest.version;
    if (typeof version !== 'string' || version.length === 0) continue;

    const tag = `${name}-v${version}`;
    if (existingTags.has(tag)) continue;

    plan.push({ name, version, tag, asset: `${name}-${version}.zip` });
  }
  return plan;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const plan = releasePlan(options.root, readExistingTags(options.existingTags));
  process.stdout.write(`${JSON.stringify(plan)}\n`);
  return 0;
}

module.exports = { releasePlan, pluginNames, readExistingTags };

if (require.main === module) {
  process.exit(main());
}
