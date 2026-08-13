'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'inject-qol-memory-continue.cjs');
const SCHEMA = 'qol-memory-continue-v1';

const SID = '019f8e9c-aaaa-0000-0000-000000000001';
const OTHER_SID = '019f9abc-bbbb-0000-0000-000000000002';
const CWD = '/sandbox/proj';

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qol-continue-'));
}

function key(i) {
  return 'k' + String(i).padStart(15, '0');
}

function unit(i, over) {
  return {
    key: key(i),
    source: 'pi',
    file: '20260813T120000_' + SID.slice(0, 8) + '.jsonl',
    session: OTHER_SID,
    cwd: CWD,
    kind: 'user',
    ts: '2026-08-14T09:00:00.000Z',
    text: 'the archive holds every transcript in chronological sequence order',
    ...over,
  };
}

function writeUnits(store, units) {
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'units.jsonl'), units.map((u) => JSON.stringify(u)).join('\n') + '\n');
}

function writeMarker(store, cwds) {
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'continue.marker.json'), JSON.stringify({ schema: SCHEMA, cwds }, null, 2) + '\n');
}

function markerEntry(ts, unitsCount) {
  return { ts, session: SID, units_count: unitsCount, updated: ts };
}

function run(store, payload, env) {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({
      cwd: CWD,
      session_id: SID,
      session_file: '/sandbox/proj/.pi/sessions/20260813T120000_' + SID.slice(0, 8) + '.jsonl',
      reason: 'resume',
      ...payload,
    }),
    encoding: 'utf8',
    env: { ...process.env, QOL_MEMORY_STORE: store, ...(env || {}) },
  });
  return { exit: r.status, stdout: r.stdout };
}

function contextOf(result) {
  if (!result.stdout.trim()) return '';
  return JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
}

function blockLines(context) {
  return context.split('\n').filter((l) => l.startsWith('  NEW '));
}

function readMarker(store) {
  return JSON.parse(fs.readFileSync(path.join(store, 'continue.marker.json'), 'utf8'));
}

function readLog(store) {
  const p = path.join(store, 'hook.log');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('delta: only units after the marker surface, newest first', () => {
  const store = sandbox();
  writeUnits(store, [
    unit(1, { ts: '2026-08-14T09:00:00.000Z', text: 'alpha decision one held in the archive ledger' }),
    unit(2, { ts: '2026-08-14T10:00:00.000Z', text: 'beta decision two held in the archive ledger' }),
    unit(3, { ts: '2026-08-14T07:00:00.000Z', text: 'gamma decision three held in the archive ledger' }),
  ]);
  writeMarker(store, { [CWD]: markerEntry('2026-08-14T08:00:00.123Z', 3) });
  const r = run(store, {});
  assert.strictEqual(r.exit, 0);
  const ctx = contextOf(r);
  assert.match(ctx, /^\[qol-memory continue\] 2 unit\(s\) landed in the store since your last session here \(2026-08-14T08:00:00Z\):$/m);
  const lines = blockLines(ctx);
  assert.strictEqual(lines.length, 2);
  assert.match(lines[0], /^  NEW 2026-08-14T10:00:00\.000Z user /);
  assert.match(lines[1], /^  NEW 2026-08-14T09:00:00\.000Z user /);
});

test('self-echo: the current session is excluded even when its ts is after the marker', () => {
  const store = sandbox();
  writeUnits(store, [
    unit(1, { session: SID, ts: '2026-08-14T10:00:00.000Z', text: 'echo decision one held in the archive ledger' }),
    unit(2, { session: SID, ts: '2026-08-14T10:01:00.000Z', text: 'echo decision two held in the archive ledger' }),
    unit(3, { ts: '2026-08-14T10:02:00.000Z', text: 'other decision one held in the archive ledger' }),
    unit(4, { ts: '2026-08-14T10:03:00.000Z', text: 'other decision two held in the archive ledger' }),
  ]);
  writeMarker(store, { [CWD]: markerEntry('2026-08-14T08:00:00.000Z', 4) });
  const ctx = contextOf(run(store, {}));
  const lines = blockLines(ctx);
  assert.strictEqual(lines.length, 2);
  for (const l of lines) {
    assert.doesNotMatch(l, new RegExp(SID.slice(0, 8)));
    assert.match(l, new RegExp(OTHER_SID.slice(0, 8)));
  }
});

test('boilerplate-marked units are excluded', () => {
  const store = sandbox();
  writeUnits(store, [
    unit(1, { ts: '2026-08-14T10:00:00.000Z', text: '[qol session bridge] implement the bounded task below' }),
    unit(2, { ts: '2026-08-14T10:01:00.000Z', text: 'Base directory for this skill: /media/kmrh47/WD_SN850X/Git/qol-skills' }),
    unit(3, { ts: '2026-08-14T10:02:00.000Z', text: 'continued from a previous conversation in the worktree' }),
    unit(4, { ts: '2026-08-14T10:03:00.000Z', text: 'plain decision one held in the archive ledger' }),
    unit(5, { ts: '2026-08-14T10:04:00.000Z', text: 'plain decision two held in the archive ledger' }),
  ]);
  writeMarker(store, { [CWD]: markerEntry('2026-08-14T08:00:00.000Z', 5) });
  const ctx = contextOf(run(store, {}));
  const lines = blockLines(ctx);
  assert.strictEqual(lines.length, 2);
  assert.match(ctx, /plain decision two/);
  assert.match(ctx, /plain decision one/);
  assert.doesNotMatch(ctx, /session bridge|Base directory|continued from a previous/);
});

test('short units are excluded', () => {
  const store = sandbox();
  writeUnits(store, [
    unit(1, { ts: '2026-08-14T10:00:00.000Z', text: 'too short' }),
    unit(2, { ts: '2026-08-14T10:01:00.000Z', text: 'exactly forty chars, padding padding padding p' }),
    unit(3, { ts: '2026-08-14T10:02:00.000Z', text: 'another real decision held in the archive ledger' }),
  ]);
  writeMarker(store, { [CWD]: markerEntry('2026-08-14T08:00:00.000Z', 3) });
  const ctx = contextOf(run(store, {}));
  const lines = blockLines(ctx);
  assert.strictEqual(lines.length, 2);
  assert.doesNotMatch(ctx, /too short/);
});

test('per-session caps: at most 2 user + 1 compaction per session, k=3 total', () => {
  const store = sandbox();
  const units = [
    unit(1, { kind: 'user', ts: '2026-08-14T09:00:00.000Z', text: 'user note one held in the archive ledger' }),
    unit(2, { kind: 'user', ts: '2026-08-14T09:01:00.000Z', text: 'user note two held in the archive ledger' }),
    unit(3, { kind: 'user', ts: '2026-08-14T09:02:00.000Z', text: 'user note three held in the archive ledger' }),
    unit(4, { kind: 'user', ts: '2026-08-14T09:03:00.000Z', text: 'user note four held in the archive ledger' }),
    unit(5, { kind: 'user', ts: '2026-08-14T09:04:00.000Z', text: 'user note five held in the archive ledger' }),
    unit(6, { kind: 'compaction', ts: '2026-08-14T09:05:00.000Z', text: 'compaction summary one held in the archive ledger' }),
    unit(7, { kind: 'compaction', ts: '2026-08-14T09:06:00.000Z', text: 'compaction summary two held in the archive ledger' }),
  ];
  writeUnits(store, units);
  writeMarker(store, { [CWD]: markerEntry('2026-08-14T08:00:00.000Z', units.length) });
  const ctx = contextOf(run(store, {}));
  const lines = blockLines(ctx);
  assert.strictEqual(lines.length, 3);
  assert.match(lines[0], /compaction 019f9abc /);
  assert.match(lines[1], /user 019f9abc /);
  assert.match(lines[2], /user 019f9abc /);
  assert.doesNotMatch(ctx, /note one|note two|note three|summary one/);
});

test('gate: delta of 1 abstains silently, delta of 2 fires', () => {
  const store = sandbox();
  writeUnits(store, [
    unit(1, { ts: '2026-08-14T10:00:00.000Z', text: 'lone decision one held in the archive ledger' }),
  ]);
  writeMarker(store, { [CWD]: markerEntry('2026-08-14T08:00:00.000Z', 1) });
  const r = run(store, {});
  assert.strictEqual(r.exit, 0);
  assert.strictEqual(r.stdout, '');
  const log = readLog(store);
  assert.ok(log.some((l) => l.stage === 'gate-miss' && l.reason === 'below-min-delta' && l.delta === 1));

  writeUnits(store, [
    unit(1, { ts: '2026-08-14T10:00:00.000Z', text: 'pair decision one held in the archive ledger' }),
    unit(2, { ts: '2026-08-14T10:01:00.000Z', text: 'pair decision two held in the archive ledger' }),
  ]);
  writeMarker(store, { [CWD]: markerEntry('2026-08-14T08:00:00.000Z', 2) });
  const r2 = run(store, {});
  assert.strictEqual(r2.exit, 0);
  assert.notStrictEqual(r2.stdout, '');
});

test('disabled: env kill-switch and flag file both abstain without advancing the marker', () => {
  const store = sandbox();
  writeUnits(store, [
    unit(1, { ts: '2026-08-14T10:00:00.000Z', text: 'quiet decision one held in the archive ledger' }),
    unit(2, { ts: '2026-08-14T10:01:00.000Z', text: 'quiet decision two held in the archive ledger' }),
  ]);
  writeMarker(store, { [CWD]: markerEntry('2026-08-14T08:00:00.000Z', 2) });
  const before = fs.readFileSync(path.join(store, 'continue.marker.json'), 'utf8');

  const re = run(store, {}, { QOL_MEMORY_CONTINUE_DISABLE: '1' });
  assert.strictEqual(re.exit, 0);
  assert.strictEqual(re.stdout, '');
  assert.strictEqual(fs.readFileSync(path.join(store, 'continue.marker.json'), 'utf8'), before);
  assert.ok(readLog(store).some((l) => l.stage === 'disabled' && l.reason === 'env'));

  fs.writeFileSync(path.join(store, 'continue.disabled'), '');
  const rf = run(store, {});
  assert.strictEqual(rf.exit, 0);
  assert.strictEqual(rf.stdout, '');
  assert.strictEqual(fs.readFileSync(path.join(store, 'continue.marker.json'), 'utf8'), before);
  assert.ok(readLog(store).some((l) => l.stage === 'disabled' && l.reason === 'flag-file'));
});

test('crash safety: missing or unreadable units.jsonl abstains, marker untouched, exit 0', () => {
  const store = sandbox();
  writeMarker(store, { [CWD]: markerEntry('2026-08-14T08:00:00.000Z', 2) });
  const before = fs.readFileSync(path.join(store, 'continue.marker.json'), 'utf8');

  const rm = run(store, {});
  assert.strictEqual(rm.exit, 0);
  assert.strictEqual(rm.stdout, '');
  assert.strictEqual(fs.readFileSync(path.join(store, 'continue.marker.json'), 'utf8'), before);
  assert.ok(readLog(store).some((l) => l.stage === 'abstain' && l.reason === 'read-error'));

  writeUnits(store, [
    unit(1, { ts: '2026-08-14T10:00:00.000Z', text: 'crash decision one held in the archive ledger' }),
    unit(2, { ts: '2026-08-14T10:01:00.000Z', text: 'crash decision two held in the archive ledger' }),
  ]);
  fs.rmSync(path.join(store, 'units.jsonl'));
  fs.mkdirSync(path.join(store, 'units.jsonl'));
  const rc = run(store, {});
  assert.strictEqual(rc.exit, 0);
  assert.strictEqual(rc.stdout, '');
  assert.strictEqual(fs.readFileSync(path.join(store, 'continue.marker.json'), 'utf8'), before);
});

test('marker write: atomic, after a successful run, preserves other cwds, advances on abstain too', () => {
  const store = sandbox();
  writeUnits(store, [
    unit(1, { ts: '2026-08-13T12:00:00.000Z', text: 'marker decision one held in the archive ledger' }),
    unit(2, { ts: '2026-08-13T12:01:00.000Z', text: 'marker decision two held in the archive ledger' }),
    unit(3, { ts: '2026-08-13T12:02:00.000Z', text: 'marker decision three held in the archive ledger' }),
  ]);
  writeMarker(store, { '/other/proj': markerEntry('2026-08-14T07:00:00.000Z', 1) });
  const r = run(store, {});
  assert.strictEqual(r.exit, 0);
  assert.notStrictEqual(r.stdout, '');
  const m = readMarker(store);
  assert.strictEqual(m.schema, SCHEMA);
  assert.ok(m.cwds['/other/proj']);
  assert.strictEqual(m.cwds['/other/proj'].units_count, 1);
  const e = m.cwds[CWD];
  assert.strictEqual(e.units_count, 3);
  assert.strictEqual(e.session, SID);
  assert.ok(Date.now() - Date.parse(e.ts) < 10000);
  assert.ok(!fs.existsSync(path.join(store, 'continue.marker.json.tmp')));

  writeUnits(store, [
    unit(1, { ts: '2026-08-13T12:00:00.000Z', text: 'marker decision one held in the archive ledger' }),
    unit(2, { ts: '2026-08-13T12:01:00.000Z', text: 'marker decision two held in the archive ledger' }),
    unit(3, { ts: '2026-08-13T12:02:00.000Z', text: 'marker decision three held in the archive ledger' }),
    unit(9, { ts: new Date(Date.now() + 60000).toISOString(), text: 'marker decision nine held in the archive ledger' }),
  ]);
  const r2 = run(store, {});
  assert.strictEqual(r2.exit, 0);
  assert.strictEqual(r2.stdout, '');
  const e2 = readMarker(store).cwds[CWD];
  assert.strictEqual(e2.units_count, 4);
  assert.notStrictEqual(e2.ts, e.ts);
});

test('store reset: marker units_count above the current line count yields empty delta and refreshes the marker', () => {
  const store = sandbox();
  writeUnits(store, [
    unit(1, { ts: '2026-08-14T10:00:00.000Z', text: 'reset decision one held in the archive ledger' }),
    unit(2, { ts: '2026-08-14T10:01:00.000Z', text: 'reset decision two held in the archive ledger' }),
  ]);
  writeMarker(store, { [CWD]: markerEntry('2026-08-14T08:00:00.000Z', 100) });
  const r = run(store, {});
  assert.strictEqual(r.exit, 0);
  assert.strictEqual(r.stdout, '');
  assert.strictEqual(readMarker(store).cwds[CWD].units_count, 2);
  assert.ok(readLog(store).some((l) => l.reason === 'store-reset'));
});

test('seal interplay: tail-only path when marker postdates the seal, full path otherwise', () => {
  const store = sandbox();
  const prefixUnit = unit(1, { session: '019f9def-cccc-0000-0000-000000000003', ts: '2026-08-14T10:00:00.000Z', text: 'sealed prefix decision held in the archive ledger' });
  const tailUnits = [
    unit(2, { ts: '2026-08-14T09:30:00.000Z', text: 'tail decision one held in the archive ledger' }),
    unit(3, { ts: '2026-08-14T09:31:00.000Z', text: 'tail decision two held in the archive ledger' }),
  ];
  const prefixText = JSON.stringify(prefixUnit) + '\n';
  const blob = zlib.gzipSync(prefixText);
  fs.mkdirSync(store, { recursive: true });
  fs.writeFileSync(path.join(store, 'units.jsonl'), prefixText + tailUnits.map((u) => JSON.stringify(u)).join('\n') + '\n');
  fs.writeFileSync(path.join(store, 'units.seal.gz'), blob);
  fs.writeFileSync(path.join(store, 'units.seal.json'), JSON.stringify({
    schema: 'qol-memory-seal-v1',
    prefix_len: Buffer.byteLength(prefixText),
    blob: 'units.seal.gz',
    blob_len: blob.length,
    sealed_units: 1,
    created: '2026-08-14T08:00:00.000Z',
  }, null, 2) + '\n');

  writeMarker(store, { [CWD]: markerEntry('2026-08-14T09:00:00.000Z', 3) });
  const ctx = contextOf(run(store, {}));
  const lines = blockLines(ctx);
  assert.strictEqual(lines.length, 2);
  assert.doesNotMatch(ctx, /sealed prefix decision/);

  writeMarker(store, { [CWD]: markerEntry('2026-08-14T07:00:00.000Z', 3) });
  const ctxFull = contextOf(run(store, {}));
  const linesFull = blockLines(ctxFull);
  assert.strictEqual(linesFull.length, 3);
  assert.match(ctxFull, /sealed prefix decision/);
  assert.match(linesFull[0], /10:00:00/);
  assert.match(linesFull[1], /09:31:00/);
  assert.match(linesFull[2], /09:30:00/);

  const consistentStore = sandbox();
  const prefixUnit2 = unit(4, { session: '019f9def-cccc-0000-0000-000000000003', ts: '2026-08-14T06:30:00.000Z', text: 'consistent sealed prefix decision in the archive ledger' });
  const prefixText2 = JSON.stringify(prefixUnit2) + '\n';
  const blob2 = zlib.gzipSync(prefixText2);
  fs.writeFileSync(path.join(consistentStore, 'units.jsonl'), prefixText2 + tailUnits.map((u) => JSON.stringify(u)).join('\n') + '\n');
  fs.writeFileSync(path.join(consistentStore, 'units.seal.gz'), blob2);
  fs.writeFileSync(path.join(consistentStore, 'units.seal.json'), JSON.stringify({
    schema: 'qol-memory-seal-v1',
    prefix_len: Buffer.byteLength(prefixText2),
    blob: 'units.seal.gz',
    blob_len: blob2.length,
    sealed_units: 1,
    created: '2026-08-14T08:00:00.000Z',
  }, null, 2) + '\n');
  writeMarker(consistentStore, { [CWD]: markerEntry('2026-08-14T09:00:00.000Z', 3) });
  const cTail = contextOf(run(consistentStore, {}));
  writeMarker(consistentStore, { [CWD]: markerEntry('2026-08-14T07:00:00.000Z', 3) });
  const cFull = contextOf(run(consistentStore, {}));
  assert.deepStrictEqual(blockLines(cTail), blockLines(cFull));
  assert.strictEqual(blockLines(cTail).length, 2);
});

test('determinism: identical store, marker and payload yield byte-identical stdout', () => {
  const store = sandbox();
  writeUnits(store, [
    unit(1, { ts: '2026-08-14T10:00:00.000Z', text: 'fixed decision one held in the archive ledger' }),
    unit(2, { ts: '2026-08-14T10:01:00.000Z', text: 'fixed decision two held in the archive ledger' }),
    unit(3, { ts: '2026-08-14T10:02:00.000Z', text: 'fixed decision three held in the archive ledger' }),
  ]);
  const markerText = JSON.stringify({ schema: SCHEMA, cwds: { [CWD]: markerEntry('2026-08-14T08:00:00.000Z', 3) } }, null, 2) + '\n';
  fs.writeFileSync(path.join(store, 'continue.marker.json'), markerText);
  const r1 = run(store, {});
  fs.writeFileSync(path.join(store, 'continue.marker.json'), markerText);
  const r2 = run(store, {});
  assert.strictEqual(r1.exit, 0);
  assert.strictEqual(r2.exit, 0);
  assert.strictEqual(r1.stdout, r2.stdout);
});

test('exit contract: always exit 0; stdout is the additionalContext JSON or empty', () => {
  const store = sandbox();
  writeUnits(store, [
    unit(1, { ts: '2026-08-14T10:00:00.000Z', text: 'contract decision one held in the archive ledger' }),
    unit(2, { ts: '2026-08-14T10:01:00.000Z', text: 'contract decision two held in the archive ledger' }),
  ]);
  writeMarker(store, { [CWD]: markerEntry('2026-08-14T08:00:00.000Z', 2) });
  const r = run(store, {});
  assert.strictEqual(r.exit, 0);
  const parsed = JSON.parse(r.stdout);
  assert.match(parsed.hookSpecificOutput.additionalContext, /^\[qol-memory continue\]/);

  const empty = spawnSync('node', [HOOK], { input: '', encoding: 'utf8', env: { ...process.env, QOL_MEMORY_STORE: store } });
  assert.strictEqual(empty.status, 0);
  assert.strictEqual(empty.stdout, '');

  const garbage = spawnSync('node', [HOOK], { input: 'not json at all', encoding: 'utf8', env: { ...process.env, QOL_MEMORY_STORE: store } });
  assert.strictEqual(garbage.status, 0);
  assert.strictEqual(garbage.stdout, '');
});

test('format: exact block shape, 140-char truncation, whitespace collapse, provenance on every line', () => {
  const store = sandbox();
  const longText = Array.from({ length: 30 }, (_, i) => 'word' + String(i).padStart(2, '0')).join('   ') + '  ' + 'tailpad'.repeat(40);
  writeUnits(store, [
    unit(1, { ts: '2026-08-14T10:00:00.000Z', kind: 'compaction', text: 'line one\n\nline two    spaced\tout  ' + 'x'.repeat(200) }),
    unit(2, { ts: '2026-08-14T10:01:00.000Z', text: longText }),
  ]);
  writeMarker(store, { [CWD]: markerEntry('2026-08-14T08:00:00.000Z', 2) });
  const ctx = contextOf(run(store, {}));
  const lines = blockLines(ctx);
  assert.strictEqual(lines.length, 2);
  const lineRe = /^  NEW \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z (user|compaction) [A-Za-z0-9._-]{8} [A-Za-z0-9]{8} ".{1,140}"$/;
  for (const l of lines) {
    assert.match(l, lineRe);
    const snip = l.slice(l.indexOf('"') + 1, l.lastIndexOf('"'));
    assert.ok(snip.length <= 140);
  }
  const first = lines.find((l) => l.includes(' compaction '));
  const snip = first.slice(first.indexOf('"') + 1, first.lastIndexOf('"'));
  assert.strictEqual(snip.length, 140);
  assert.doesNotMatch(snip, /\s{2,}|\n/);
  assert.match(ctx, /landed in the store since your last session here \(2026-08-14T08:00:00Z\):/);
});
