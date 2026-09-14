const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, writeFileSync, appendFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

function freshLib(store) {
  process.env.QOL_MEMORY_STORE = store;
  const file = require.resolve("../bin/qolmem-lib.cjs");
  delete require.cache[file];
  return require(file);
}

function retrievals(store, queries, offsetMs = 0) {
  const ts = new Date(Date.now() + offsetMs).toISOString();
  const write = offsetMs ? appendFileSync : writeFileSync;
  write(
    join(store, "retrievals.jsonl"),
    queries.map((query) => JSON.stringify({ source: "launcher", query, ts, verdict: "no-memory" })).join("\n") + "\n",
  );
}

test("a muted question leaves the queue and returns after unmuteKey", () => {
  const store = mkdtempSync(join(tmpdir(), "qolmem-mutes-"));
  retrievals(store, ["how many commits in qol monorepo"]);
  const lib = freshLib(store);

  const waiting = lib.unansweredQueue();
  assert.equal(waiting.length, 1);
  assert.equal(lib.muteEntries(waiting), 1);

  assert.deepEqual(lib.unansweredQueue(), []);
  const muted = lib.mutedQueue();
  assert.equal(muted.length, 1);
  assert.equal(muted[0].query, "how many commits in qol monorepo");

  assert.equal(lib.unmuteKey(muted[0].key), true);
  assert.equal(lib.unansweredQueue().length, 1);
  assert.deepEqual(lib.mutedQueue(), []);
});

test("muting a collapsed group mutes every variant and a re-ask with any spelling stays out", () => {
  const store = mkdtempSync(join(tmpdir(), "qolmem-mutes-variants-"));
  retrievals(store, ["what language is qol composed of"], -120000);
  retrievals(store, ["which language is qol composed of"], -60000);
  const lib = freshLib(store);

  const waiting = lib.unansweredQueue();
  assert.equal(waiting.length, 1, "the two spellings collapse to one waiting entry");
  lib.muteEntries(waiting);

  const [record] = lib.mutedQueue();
  assert.equal(record.norms.length, 2, "the mute covers both spellings");

  retrievals(store, ["what language is qol composed of"], 1000);
  assert.deepEqual(lib.unansweredQueue(), []);

  retrievals(store, ["which language is qol composed of"], 2000);
  assert.deepEqual(lib.unansweredQueue(), []);
});

test("unansweredQueue with all returns every group past the cap", () => {
  const store = mkdtempSync(join(tmpdir(), "qolmem-mutes-all-"));
  retrievals(store, ["how many commits in qol monorepo"], -240000);
  retrievals(store, ["where does the tray log live"], -180000);
  retrievals(store, ["what port does the daemon use"], -120000);
  retrievals(store, ["which plugin owns the camera"], -60000);
  const lib = freshLib(store);

  assert.equal(lib.unansweredQueue().length, 3);
  assert.equal(lib.unansweredQueue({ all: true }).length, 4);
});

test("a muted question asked again later stays muted", () => {
  const store = mkdtempSync(join(tmpdir(), "qolmem-mutes-reask-"));
  retrievals(store, ["how does the queue work"]);
  const lib = freshLib(store);

  lib.muteEntries(lib.unansweredQueue());
  assert.deepEqual(lib.unansweredQueue(), []);

  retrievals(store, ["how does the queue work"], 86400000);
  assert.deepEqual(lib.unansweredQueue(), []);
  assert.equal(lib.mutedQueue().length, 1);
});
