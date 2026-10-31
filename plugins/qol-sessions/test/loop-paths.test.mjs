import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EXIT,
  LoopError,
  assertKey,
  attemptDir,
  commonDir,
  listAttempts,
  loopDir,
  readAttempts,
  readJson,
  readLoop,
  worktreePath,
  writeJson,
  writeLoop,
} from "../src/loop/paths.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loop-paths-"));
}

test("keys are validated as lowercase slugs up to 64 characters", () => {
  const good = ["a", "0", "feature1", "a-b-c", "a-v2", "a-1b", "x".repeat(64)];
  const bad = ["", "-a", "A", "a_b", "a b", "a/b", "../x", "x".repeat(65), undefined, 7, "a-1", "a-12", "a-control", "feature-b-2"];
  for (const key of good) assert.equal(assertKey(key), key);
  for (const key of bad) {
    assert.throws(() => assertKey(key), (error) => error instanceof LoopError && error.exit === EXIT.usage, String(key));
  }
});

test("commonDir resolves the git common dir against cwd", () => {
  const calls = [];
  const exec = (argv, options) => {
    calls.push({ argv, cwd: options.cwd });
    return { status: 0, stdout: "../.git\n", stderr: "" };
  };
  assert.equal(commonDir("/work/main/sub", { exec }), "/work/main/.git");
  assert.deepEqual(calls[0], { argv: ["git", "rev-parse", "--git-common-dir"], cwd: "/work/main/sub" });
});

test("commonDir rejects a directory outside a repository", () => {
  const exec = () => ({ status: 128, stdout: "", stderr: "fatal" });
  assert.throws(() => commonDir("/nowhere", { exec }), (error) => error instanceof LoopError && error.exit === EXIT.usage);
});

test("loop and attempt paths follow the contract layout", () => {
  const common = "/r/main/.git";
  assert.equal(loopDir(common, "k1"), "/r/main/.git/qol-sessions/loops/k1");
  assert.equal(attemptDir("/d", 2), "/d/attempt-2");
  assert.equal(attemptDir("/d", 2, null), "/d/attempt-2");
  assert.equal(attemptDir("/d", 2, 1), "/d/attempt-2-1");
  assert.throws(() => loopDir(common, "../escape"), LoopError);
});

test("worktree paths sit beside the main clone under worktrees/loop-<key>", () => {
  assert.equal(worktreePath("/r/main", "k1"), "/r/worktrees/loop-k1/main");
  assert.equal(worktreePath("/r/main", "k1", 2), "/r/worktrees/loop-k1-2/main");
  assert.equal(worktreePath("/r/main", "k1", "control"), "/r/worktrees/loop-k1-control/main");
});

test("listAttempts sorts by round then implementer and ignores other entries", () => {
  const root = tmp();
  for (const name of ["attempt-2", "attempt-10", "attempt-1-2", "attempt-1-1", "control", "baseline", "attempt-x", "notes.txt"]) {
    fs.mkdirSync(path.join(root, name));
  }
  const found = listAttempts(root).map((entry) => [entry.name, entry.n, entry.index]);
  assert.deepEqual(found, [
    ["attempt-1-1", 1, 1],
    ["attempt-1-2", 1, 2],
    ["attempt-2", 2, null],
    ["attempt-10", 10, null],
  ]);
  assert.deepEqual(listAttempts(path.join(root, "missing")), []);
});

test("readJson returns null for missing or broken files and writeJson round-trips", () => {
  const root = tmp();
  const file = path.join(root, "nested", "x.json");
  assert.equal(readJson(file), null);
  writeJson(file, { a: 1 });
  assert.deepEqual(readJson(file), { a: 1 });
  assert.equal(fs.readFileSync(file, "utf8").endsWith("\n"), true);
  fs.writeFileSync(file, "{broken");
  assert.equal(readJson(file), null);
});

test("readLoop and writeLoop use loop.json", () => {
  const root = tmp();
  assert.equal(readLoop(root), null);
  writeLoop(root, { schema: 1, key: "k" });
  assert.deepEqual(readLoop(root), { schema: 1, key: "k" });
  assert.equal(fs.existsSync(path.join(root, "loop.json")), true);
});

test("readAttempts joins gate, lane and verdict files", () => {
  const root = tmp();
  const one = path.join(root, "attempt-1");
  fs.mkdirSync(one);
  writeJson(path.join(one, "gate.json"), { verdict: "findings" });
  writeJson(path.join(one, "lane.json"), { surface: "headless" });
  fs.mkdirSync(path.join(root, "attempt-2"));
  const [first, second] = readAttempts(root);
  assert.equal(first.gate.verdict, "findings");
  assert.equal(first.lane.surface, "headless");
  assert.equal(first.verdict, null);
  assert.equal(second.gate, null);
});
