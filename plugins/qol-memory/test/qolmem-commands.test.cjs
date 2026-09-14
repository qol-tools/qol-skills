'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'qolmem-gen.cjs');
const CWD = '/sandbox/proj';

function makeStore(events) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qolmem-commands-store-'));
  writeFileSync(
    path.join(dir, 'retrievals.jsonl'),
    events.map((event) => JSON.stringify(event)).join('\n') + '\n',
  );
  return dir;
}

function runCommand(prompt, store, lanes) {
  const result = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ prompt, cwd: CWD }),
    env: {
      ...process.env,
      QOL_MEMORY_STORE: store,
      QOL_TRAY_BASE_URL: 'http://127.0.0.1:1',
      QOL_TRAY_HTTP_TOKEN: 't',
      QOL_SESSIONS_LANES_DIR: lanes,
    },
    encoding: 'utf8',
  });
  assert.strictEqual(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

test('list reports the waiting questions, mute moves one aside, unmute restores it', () => {
  const store = makeStore([
    {
      source: 'launcher',
      query: 'how many commits in qol monorepo',
      ts: new Date(Date.now() - 120000).toISOString(),
      verdict: 'no-memory',
    },
    {
      source: 'launcher',
      query: 'where does the tray log live',
      ts: new Date(Date.now() - 60000).toISOString(),
      verdict: 'no-memory',
    },
  ]);
  const lanes = mkdtempSync(path.join(os.tmpdir(), 'qolmem-commands-lanes-'));

  const listed = runCommand('qolmem list', store, lanes);
  assert.strictEqual(listed.decision, 'block');
  assert.match(listed.reason, /^qolmem: 2 waiting, 0 muted$/m);
  assert.match(listed.reason, /^1\. where does the tray log live \(\d+m\)$/m);
  assert.match(listed.reason, /^2\. how many commits in qol monorepo \(\d+m\)$/m);

  const muted = runCommand('qolmem mute 1', store, lanes);
  assert.strictEqual(muted.reason, 'qolmem: muted "where does the tray log live"; 1 waiting, 1 muted.');

  const afterMute = runCommand('qolmem list', store, lanes);
  const afterMuteLines = afterMute.reason.split('\n');
  assert.strictEqual(afterMuteLines.length, 4);
  assert.strictEqual(afterMuteLines[0], 'qolmem: 1 waiting, 1 muted');
  assert.match(afterMuteLines[1], /^1\. how many commits in qol monorepo \(\d+m\)$/);
  assert.strictEqual(afterMuteLines[2], 'muted:');
  assert.match(afterMuteLines[3], /^1\. where does the tray log live \(muted \d+m\)$/);

  const unmuted = runCommand('qolmem unmute 1', store, lanes);
  assert.strictEqual(unmuted.reason, 'qolmem: unmuted "where does the tray log live"; 2 waiting, 0 muted.');

  const restored = runCommand('qolmem list', store, lanes);
  assert.match(restored.reason, /^qolmem: 2 waiting, 0 muted$/m);
  assert.match(restored.reason, /^1\. where does the tray log live \(\d+m\)$/m);
});
