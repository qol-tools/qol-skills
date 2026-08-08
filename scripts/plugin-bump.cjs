'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const { versionDrift } = require('./plugin-version-drift.cjs');

function parseArgs(argv) {
  const options = { root: process.cwd() };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--root') options.root = argv[++i];
  }
  return options;
}

function bumpPatch(version) {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10));
  if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) {
    throw new Error(`cannot patch-bump non-numeric version: ${version}`);
  }
  parts[2] += 1;
  return parts.join('.');
}

function writePluginVersion(root, name, version) {
  const manifestFile = path.join(root, 'plugins', name, '.claude-plugin', 'plugin.json');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  manifest.version = version;
  fs.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
}

function syncManifests(root) {
  const syncScript = path.join(__dirname, 'sync-plugin-manifests.cjs');
  execFileSync(process.execPath, [syncScript, '--root', root], {
    cwd: root,
    stdio: 'inherit',
  });
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
    return 0;
  }

  for (const { name, version } of drifted) {
    const next = bumpPatch(version);
    writePluginVersion(options.root, name, next);
    console.log(`${name} ${version} -> ${next}`);
  }

  syncManifests(options.root);
  return 0;
}

module.exports = { bumpPatch };

if (require.main === module) {
  process.exit(main());
}
