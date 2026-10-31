import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  EXIT,
  LoopError,
  SURFACES,
  acquireLoopLock,
  assertKey,
  attemptDir,
  commonDir,
  findOnPath,
  isArmed,
  listAttempts,
  loopDir,
  questionFile,
  readAttempts,
  readJson,
  readLoop,
  readQuestions,
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
  const cwd = path.resolve("/work/main/sub");
  assert.equal(commonDir(cwd, { exec }), path.resolve("/work/main/.git"));
  assert.deepEqual(calls[0], { argv: ["git", "rev-parse", "--git-common-dir"], cwd });
});

test("commonDir rejects a directory outside a repository", () => {
  const exec = () => ({ status: 128, stdout: "", stderr: "fatal" });
  assert.throws(() => commonDir("/nowhere", { exec }), (error) => error instanceof LoopError && error.exit === EXIT.usage);
});

test("loop and attempt paths follow the contract layout", () => {
  const common = path.join("/r", "main", ".git");
  assert.equal(loopDir(common, "k1"), path.join(common, "qol-sessions", "loops", "k1"));
  assert.equal(attemptDir("/d", 2), path.join("/d", "attempt-2"));
  assert.equal(attemptDir("/d", 2, null), path.join("/d", "attempt-2"));
  assert.equal(attemptDir("/d", 2, 1), path.join("/d", "attempt-2-1"));
  assert.throws(() => loopDir(common, "../escape"), LoopError);
});

test("worktree paths sit beside the main clone under worktrees/loop-<key>", () => {
  const main = path.join("/r", "main");
  assert.equal(worktreePath(main, "k1"), path.join("/r", "worktrees", "loop-k1", "main"));
  assert.equal(worktreePath(main, "k1", 2), path.join("/r", "worktrees", "loop-k1-2", "main"));
  assert.equal(worktreePath(main, "k1", "control"), path.join("/r", "worktrees", "loop-k1-control", "main"));
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

test("findOnPath walks PATH in order and joins with the platform separator", () => {
  const first = path.join("/a", "bin");
  const second = path.join("/b", "bin");
  const env = { PATH: [first, "", second].join(path.delimiter) };
  assert.equal(findOnPath("qac", { env, platform: "linux", exists: (file) => file === path.join(second, "qac") }), path.join(second, "qac"));
  assert.equal(findOnPath("qac", { env, platform: "linux", exists: () => true }), path.join(first, "qac"));
  assert.equal(findOnPath("qac", { env, platform: "linux", exists: () => false }), null);
  assert.equal(findOnPath("qac", { env: {}, platform: "linux", exists: () => true }), null);
});

test("findOnPath on win32 tries the PATHEXT extensions and ignores them elsewhere", () => {
  const dir = path.join("/tools", "bin");
  const env = { PATH: dir, PATHEXT: ".EXE;.CMD" };
  const seen = [];
  const exists = (file) => {
    seen.push(file);
    return file === path.join(dir, "claude.CMD");
  };
  assert.equal(findOnPath("claude", { env, platform: "win32", exists }), path.join(dir, "claude.CMD"));
  assert.deepEqual(seen, [path.join(dir, "claude.EXE"), path.join(dir, "claude.CMD")]);
  assert.equal(findOnPath("claude", { env, platform: "linux", exists }), null);
  const defaults = [];
  findOnPath("qol", { env: { PATH: dir }, platform: "win32", exists: (file) => defaults.push(file) && false });
  assert.deepEqual(defaults, [".COM", ".EXE", ".BAT", ".CMD", ""].map((extension) => path.join(dir, `qol${extension}`)));
  assert.equal(findOnPath("qol", { env: { Path: dir }, platform: "win32", exists: (file) => file === path.join(dir, "qol.EXE") }), path.join(dir, "qol.EXE"));
});

test("SURFACES names the three lane surfaces", () => {
  assert.deepEqual([...SURFACES], ["kitty", "headless", "handover"]);
});

test("question files are per implementer slot and readQuestions returns the ones that exist", () => {
  const dir = tmp();
  assert.equal(questionFile(dir, null), path.join(dir, "question.json"));
  assert.equal(questionFile(dir, 2), path.join(dir, "question-2.json"));
  writeJson(questionFile(dir, 2), { question: "b?" });
  assert.deepEqual(readQuestions(dir, [1, 2], {}), [{ question: "b?" }]);
  assert.deepEqual(readQuestions(dir, [null], {}), []);
});

test("a loop is armed only once its baseline gate could judge", () => {
  const dir = tmp();
  assert.equal(isArmed(dir, {}), false);
  writeJson(path.join(dir, "baseline", "gate.json"), { verdict: "could_not_judge" });
  assert.equal(isArmed(dir, {}), false);
  for (const verdict of ["clean", "findings", "flaky_only"]) {
    writeJson(path.join(dir, "baseline", "gate.json"), { verdict });
    assert.equal(isArmed(dir, {}), true, verdict);
  }
});

test("the loop lock is exclusive, names the holder, is released, and is broken only for a dead pid", () => {
  const dir = tmp();
  const lock = path.join(dir, "run.lock");
  const release = acquireLoopLock(dir, { pid: 111, pidAlive: () => true });
  assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, 111);
  assert.throws(
    () => acquireLoopLock(dir, { pid: 222, pidAlive: () => true }),
    (error) => error instanceof LoopError && error.exit === EXIT.usage && error.message.includes("pid 111"),
  );
  assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, 111);
  release();
  assert.equal(fs.existsSync(lock), false);
  fs.writeFileSync(lock, JSON.stringify({ pid: 333 }));
  const takeover = acquireLoopLock(dir, { pid: 444, pidAlive: (pid) => pid !== 333 });
  assert.equal(JSON.parse(fs.readFileSync(lock, "utf8")).pid, 444);
  takeover();
  fs.writeFileSync(lock, "not json");
  acquireLoopLock(dir, { pid: 555, pidAlive: () => true })();
  assert.equal(fs.existsSync(lock), false);
});

test("a release never removes a lock another process took over", () => {
  const dir = tmp();
  const release = acquireLoopLock(dir, { pid: 1, pidAlive: () => true });
  fs.writeFileSync(path.join(dir, "run.lock"), JSON.stringify({ pid: 2 }));
  release();
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "run.lock"), "utf8")).pid, 2);
});

test("the real process check treats the current pid as alive", () => {
  const dir = tmp();
  const release = acquireLoopLock(dir, {});
  assert.throws(() => acquireLoopLock(dir, {}), new RegExp(`pid ${process.pid}`));
  release();
});
