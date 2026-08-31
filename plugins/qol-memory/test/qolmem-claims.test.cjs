const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, writeFileSync } = require("node:fs");
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
  writeFileSync(
    join(store, "retrievals.jsonl"),
    queries.map((query) => JSON.stringify({ source: "launcher", query, ts, verdict: "no-memory" })).join("\n") + "\n",
  );
}

test("a claimed question leaves the queue", () => {
  const store = mkdtempSync(join(tmpdir(), "qolmem-claims-"));
  retrievals(store, ["how many commits in qol monorepo"]);
  const lib = freshLib(store);

  assert.equal(lib.unansweredQueue().length, 1);

  lib.claimQueries(lib.unansweredQueue());

  assert.deepEqual(lib.unansweredQueue(), []);
});

test("claiming a question also covers its typo prefixes", () => {
  const store = mkdtempSync(join(tmpdir(), "qolmem-prefix-"));
  retrievals(store, ["how to run kcd2 in normal mode", "how to run kcd2 in normal mod"]);
  const lib = freshLib(store);

  lib.claimQueries([{ query: "how to run kcd2 in normal mode" }]);

  assert.deepEqual(lib.unansweredQueue(), []);
});

test("a question asked again after its claim comes back", () => {
  const store = mkdtempSync(join(tmpdir(), "qolmem-reask-"));
  retrievals(store, ["what command is kcd2 debug mode"]);
  const lib = freshLib(store);

  lib.claimQueries(lib.unansweredQueue());
  assert.deepEqual(lib.unansweredQueue(), []);

  retrievals(store, ["what command is kcd2 debug mode"], 1000);
  assert.equal(lib.unansweredQueue().length, 1, "a fresh ask outranks an older claim");
});
