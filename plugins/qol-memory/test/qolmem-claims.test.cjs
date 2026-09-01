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

test("claiming a batch with a bare question-mark query writes its claim", () => {
  const store = mkdtempSync(join(tmpdir(), "qolmem-mark-claim-"));
  retrievals(store, ["trail animation?"]);
  const lib = freshLib(store);

  lib.claimQueries(lib.unansweredQueue());

  assert.deepEqual(lib.unansweredQueue(), []);
});

const http = require("node:http");

function askServer(verdictFor) {
  const asked = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      const body = JSON.parse(raw);
      asked.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(verdictFor(body.query)));
    });
  });
  return { server, asked };
}

function listen(server) {
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));
}

function stop(server) {
  return new Promise((resolve) => server.close(resolve));
}

test("two questions differing only in the interrogative collapse to one entry", () => {
  const store = mkdtempSync(join(tmpdir(), "qolmem-collapse-"));
  retrievals(store, ["what language is qol composed of"], -120000);
  retrievals(store, ["which language is qol composed of"], -60000);
  const lib = freshLib(store);

  const queue = lib.unansweredQueue();
  assert.equal(queue.length, 1);

  lib.claimQueries(queue);

  assert.deepEqual(lib.unansweredQueue(), [], "claiming the entry covers both spellings");
});

test("a question the store can now answer leaves the queue", async () => {
  const store = mkdtempSync(join(tmpdir(), "qolmem-drop-"));
  retrievals(store, ["what language is qol monorepo"]);
  retrievals(store, ["how to run kcd2 in debug mode"], 60000);
  const lib = freshLib(store);
  const { server, asked } = askServer((query) =>
    query === "what language is qol monorepo"
      ? { verdict: "answered", confidence: "medium", answer: { text: "Rust" } }
      : { verdict: "no-memory", confidence: "none" },
  );
  const port = await listen(server);
  process.env.QOL_TRAY_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.QOL_TRAY_HTTP_TOKEN = "t";

  try {
    const kept = await lib.dropAnswered(lib.unansweredQueue());

    assert.deepEqual(kept.map((e) => e.query), ["how to run kcd2 in debug mode"]);
    assert.equal(asked.length, 2);
    assert.equal(asked[0].no_log, true, "a re-ask must not append a retrieval event");
  } finally {
    await stop(server);
    delete process.env.QOL_TRAY_BASE_URL;
    delete process.env.QOL_TRAY_HTTP_TOKEN;
  }
});

test("a dropped question is claimed so it never refills the queue", async () => {
  const store = mkdtempSync(join(tmpdir(), "qolmem-drop-claim-"));
  retrievals(store, ["what language is qol monorepo"]);
  const lib = freshLib(store);
  const { server } = askServer(() => ({ verdict: "answered", confidence: "medium", answer: { text: "Rust" } }));
  const port = await listen(server);
  process.env.QOL_TRAY_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.QOL_TRAY_HTTP_TOKEN = "t";

  try {
    const kept = await lib.dropAnswered(lib.unansweredQueue());

    assert.deepEqual(kept, []);
    assert.deepEqual(lib.unansweredQueue(), [], "the dropped question stays out of the queue");
  } finally {
    await stop(server);
    delete process.env.QOL_TRAY_BASE_URL;
    delete process.env.QOL_TRAY_HTTP_TOKEN;
  }
});

test("candidates is not an answer and stays queued", async () => {
  const store = mkdtempSync(join(tmpdir(), "qolmem-candidates-"));
  retrievals(store, ["how to run kcd2 in debug mode"]);
  const lib = freshLib(store);
  const { server } = askServer(() => ({ verdict: "candidates", confidence: "low" }));
  const port = await listen(server);
  process.env.QOL_TRAY_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.QOL_TRAY_HTTP_TOKEN = "t";

  try {
    const kept = await lib.dropAnswered(lib.unansweredQueue());

    assert.equal(kept.length, 1);
  } finally {
    await stop(server);
    delete process.env.QOL_TRAY_BASE_URL;
    delete process.env.QOL_TRAY_HTTP_TOKEN;
  }
});

test("an unreachable store keeps the queue unfiltered", async () => {
  const store = mkdtempSync(join(tmpdir(), "qolmem-offline-"));
  retrievals(store, ["how to run kcd2 in debug mode"]);
  const lib = freshLib(store);
  const server = http.createServer(() => {});
  const port = await listen(server);
  await stop(server);
  process.env.QOL_TRAY_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.QOL_TRAY_HTTP_TOKEN = "t";

  try {
    const kept = await lib.dropAnswered(lib.unansweredQueue());

    assert.equal(kept.length, 1, "a store we cannot reach never removes a question");
  } finally {
    delete process.env.QOL_TRAY_BASE_URL;
    delete process.env.QOL_TRAY_HTTP_TOKEN;
  }
});
