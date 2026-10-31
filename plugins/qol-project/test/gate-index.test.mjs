import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { appendGate, findTraps, gatesFile, readGates } from "../src/gate/index.mjs";

const NOW = "2026-10-31T00:00:00.000Z";
const DAY = 24 * 60 * 60 * 1000;

function commonDir() {
  return realpathSync.native(mkdtempSync(path.join(tmpdir(), "qac-gate-index-")));
}

function line(loop, extra = {}) {
  return {
    at: NOW,
    repo_id: "r1",
    loop,
    attempt: 1,
    tree: "t",
    judges_sha: "j",
    verdict: "findings",
    findings: [],
    ...extra,
  };
}

function finding(fingerprint, status = "caught") {
  return { fingerprint, judge: "clippy", rule: "unused", message: `message ${fingerprint}`, status };
}

test("appendGate creates the index, stamps a missing at and readGates reads it back", () => {
  const dir = commonDir();
  assert.deepEqual(readGates(dir), []);
  const result = appendGate(dir, { ...line("a"), at: undefined }, { now: () => NOW });
  assert.equal(result.file, gatesFile(dir));
  assert.equal(result.file, path.join(dir, "qac", "gates.jsonl"));
  appendGate(dir, line("b"), { now: () => NOW });
  const lines = readGates(dir);
  assert.deepEqual(lines.map(item => item.loop), ["a", "b"]);
  assert.equal(lines[0].at, NOW);
  assert.equal(existsSync(`${result.file}.lock`), false);
});

test("readGates skips malformed lines and missing files", () => {
  const dir = commonDir();
  mkdirSync(path.join(dir, "qac"), { recursive: true });
  writeFileSync(gatesFile(dir), `${JSON.stringify(line("a"))}\nnot json\n\n[1,2]\n${JSON.stringify(line("b"))}\n`);
  assert.deepEqual(readGates(dir).map(item => item.loop), ["a", "b"]);
});

test("a held lock is waited on and then reported busy after 2 seconds", () => {
  const dir = commonDir();
  const file = gatesFile(dir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.lock`, "");
  let clock = Date.now();
  const sleeps = [];
  const deps = { nowMs: () => clock, sleep: ms => { sleeps.push(ms); clock += 500; } };
  assert.throws(() => appendGate(dir, line("a"), deps), /could not lock/);
  assert.ok(sleeps.length >= 3);
  assert.equal(existsSync(`${file}.lock`), true);
  assert.deepEqual(readGates(dir), []);
});

test("a lock released while waiting lets the append through", () => {
  const dir = commonDir();
  const file = gatesFile(dir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.lock`, "");
  let sleeps = 0;
  const sleep = () => {
    sleeps += 1;
    if (sleeps === 2) unlinkSync(`${file}.lock`);
  };
  appendGate(dir, line("a"), { sleep });
  assert.equal(sleeps, 2);
  assert.deepEqual(readGates(dir).map(item => item.loop), ["a"]);
});

test("a stale lock older than 10 seconds is replaced", () => {
  const dir = commonDir();
  const file = gatesFile(dir);
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(`${file}.lock`, "");
  const old = new Date(Date.now() - 60000);
  utimesSync(`${file}.lock`, old, old);
  appendGate(dir, line("a"), {});
  assert.deepEqual(readGates(dir).map(item => item.loop), ["a"]);
  assert.equal(existsSync(`${file}.lock`), false);
});

test("retention keeps only lines of the newest distinct loop keys", () => {
  const dir = commonDir();
  const deps = { retentionLoops: 2, now: () => NOW };
  for (const loop of ["a", "b", "a", "c"]) appendGate(dir, line(loop), deps);
  assert.deepEqual(readGates(dir).map(item => item.loop), ["a", "a", "c"]);
  appendGate(dir, line("d"), deps);
  assert.deepEqual(readGates(dir).map(item => item.loop), ["c", "d"]);
});

test("retention defaults to 50 loops and accepts the count on the line", () => {
  const dir = commonDir();
  for (let i = 0; i < 52; i++) appendGate(dir, line(`loop-${i}`), { now: () => NOW });
  const loops = readGates(dir).map(item => item.loop);
  assert.equal(loops.length, 50);
  assert.equal(loops[0], "loop-2");
  appendGate(dir, { ...line("last"), retentionLoops: 1 }, { now: () => NOW });
  const stored = readGates(dir);
  assert.deepEqual(stored.map(item => item.loop), ["last"]);
  assert.equal("retentionLoops" in stored[0], false);
});

test("lines without a loop key are kept for 30 days", () => {
  const dir = commonDir();
  const now = Date.parse(NOW);
  mkdirSync(path.dirname(gatesFile(dir)), { recursive: true });
  const stored = [
    line(null, { at: new Date(now - 40 * DAY).toISOString(), tree: "old" }),
    line(null, { at: new Date(now - 10 * DAY).toISOString(), tree: "recent" }),
  ];
  writeFileSync(gatesFile(dir), stored.map(item => `${JSON.stringify(item)}\n`).join(""));
  assert.deepEqual(readGates(dir).map(item => item.tree), ["old", "recent"]);
  appendGate(dir, line("a"), { retentionLoops: 5, now: () => NOW });
  assert.deepEqual(readGates(dir).map(item => item.tree), ["recent", "t"]);
});

test("a Date or number now is accepted", () => {
  const dir = commonDir();
  appendGate(dir, line("a", { at: undefined }), { now: () => new Date(NOW) });
  assert.equal(readGates(dir)[0].at, NOW);
  appendGate(dir, line("b", { at: undefined }), { now: () => Date.parse(NOW) });
  assert.equal(readGates(dir)[1].at, NOW);
});

function trapLines() {
  return [
    line("L1", { findings: [finding("A"), finding("C")] }),
    line("L1", { findings: [finding("C")] }),
    line("L2", { findings: [finding("A"), finding("B", "baseline")] }),
    line("L3", { attempt: 2, findings: [finding("B"), finding("E")] }),
    line("L4", { attempt: 2, findings: [finding("B"), finding("A")] }),
    line("L5", { repo_id: "other", findings: [finding("E")] }),
    line("L6", { repo_id: "other", findings: [finding("E")] }),
    line(null, { findings: [finding("E")] }),
    line("L7", { findings: [finding("F", "flaky")] }),
    line("L8", { findings: [finding("F", "flaky")] }),
  ];
}

test("findTraps returns fingerprints caught on attempt 1 in at least two distinct loops of the repo", () => {
  const traps = findTraps(trapLines(), { repoId: "r1" });
  assert.deepEqual(traps, [
    { fingerprint: "A", judge: "clippy", rule: "unused", message: "message A", loops: ["L1", "L2"] },
  ]);
});

test("findTraps honours min and the repo filter", () => {
  const lines = trapLines();
  assert.deepEqual(findTraps(lines, { repoId: "r1", min: 1 }).map(trap => trap.fingerprint), ["A", "C"]);
  assert.deepEqual(findTraps(lines, { repoId: "r1", min: 3 }), []);
  assert.deepEqual(findTraps(lines, { repoId: "other" }).map(trap => trap.fingerprint), ["E"]);
  assert.deepEqual(findTraps(lines, { repoId: "nobody" }), []);
});

test("findTraps without a repo id spans all repos, and an empty log has no traps", () => {
  assert.deepEqual(findTraps(trapLines()).map(trap => trap.fingerprint), ["A", "E"]);
  assert.deepEqual(findTraps([]), []);
});
