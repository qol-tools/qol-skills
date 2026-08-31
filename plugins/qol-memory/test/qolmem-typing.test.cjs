const test = require("node:test");
const assert = require("node:assert");
const { mkdtempSync, appendFileSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

function freshLib(store) {
  process.env.QOL_MEMORY_STORE = store;
  const file = require.resolve("../bin/qolmem-lib.cjs");
  delete require.cache[file];
  return require(file);
}

function keystroke(store, query, offsetMs, verdict = "no-memory") {
  appendFileSync(
    join(store, "retrievals.jsonl"),
    JSON.stringify({
      source: "launcher",
      query,
      ts: new Date(Date.now() - 60000 + offsetMs).toISOString(),
      verdict,
    }) + "\n",
  );
}

test("a typo state leaves the queue once the settled query lands", () => {
  const store = mkdtempSync(join(tmpdir(), "qolmem-typing-"));
  keystroke(store, "what lanagu", 0);
  keystroke(store, "what lanagug", 80);
  keystroke(store, "what lana", 940);
  keystroke(store, "what language is", 2320);
  keystroke(store, "what language is qol monorepo", 5890, "answered");

  assert.deepEqual(freshLib(store).unansweredQueue(), []);
});

test("two unrelated questions typed back to back both survive", () => {
  const store = mkdtempSync(join(tmpdir(), "qolmem-typing-distinct-"));
  keystroke(store, "how many commits in qol monorepo", 0);
  keystroke(store, "what language is the launcher", 1200);

  const queue = freshLib(store).unansweredQueue().map((entry) => entry.query);

  assert.equal(queue.length, 2);
});

test("a retyped question after the typing gap is not treated as an edit", () => {
  const store = mkdtempSync(join(tmpdir(), "qolmem-typing-gap-"));
  keystroke(store, "how to run kcd2 in normal mode", 0);
  keystroke(store, "how to run kcd2 in debug mode", 30000);

  const queue = freshLib(store).unansweredQueue().map((entry) => entry.query);

  assert.equal(queue.length, 2);
});

test("a lookup that is not phrased as a question is never queued", () => {
  const store = mkdtempSync(join(tmpdir(), "qolmem-token-"));
  keystroke(store, "kcd2", 0);
  keystroke(store, "trail animation", 30000);
  keystroke(store, "how to run kcd2", 60000);

  const queue = freshLib(store).unansweredQueue().map((entry) => entry.query);

  assert.deepEqual(queue, ["how to run kcd2"]);
});

test("an explicit question mark counts even without a question word", () => {
  const store = mkdtempSync(join(tmpdir(), "qolmem-mark-"));
  keystroke(store, "trail animation?", 0);

  assert.equal(freshLib(store).unansweredQueue().length, 1);
});
