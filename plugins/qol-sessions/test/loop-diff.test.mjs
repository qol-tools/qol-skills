import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { captureDiff, changedPaths } from "../src/loop/diff.mjs";
import { deleteBranch, removeWorktree } from "../src/loop/paths.mjs";
import { addWorktree } from "../src/loop/worktree.mjs";

function cleanEnv() {
  const env = { ...process.env };
  for (const name of Object.keys(env)) if (name.startsWith("GIT_")) delete env[name];
  return { ...env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
}

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t.invalid", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    env: cleanEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repo() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qols-diff-repo-"));
  git(dir, "init", "-q");
  writeFileSync(path.join(dir, "a.txt"), "one\n");
  writeFileSync(path.join(dir, ".gitignore"), "ignored.log\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return dir;
}

test("captureDiff includes edits and untracked files, skips ignored ones, and leaves the real index alone", () => {
  const dir = repo();
  writeFileSync(path.join(dir, "a.txt"), "two\n");
  writeFileSync(path.join(dir, "b.txt"), "new\n");
  writeFileSync(path.join(dir, "ignored.log"), "noise\n");
  const patch = captureDiff(dir, "HEAD", { env: cleanEnv() });
  assert.match(patch, /diff --git a\/a\.txt b\/a\.txt/);
  assert.match(patch, /\+two/);
  assert.match(patch, /diff --git a\/b\.txt b\/b\.txt/);
  assert.match(patch, /\+new/);
  assert.doesNotMatch(patch, /ignored\.log/);
  const status = git(dir, "status", "--porcelain");
  assert.match(status, /\?\? b\.txt/);
  assert.match(status, /M a\.txt/);
  assert.equal(git(dir, "diff", "--cached", "--name-only"), "");
  assert.deepEqual(changedPaths(patch), ["a.txt", "b.txt"]);
});

test("captureDiff keeps added lines of a file git would treat as binary", () => {
  const dir = repo();
  writeFileSync(path.join(dir, ".gitattributes"), "* -diff\n");
  writeFileSync(path.join(dir, "zero-byte.txt"), "a\0\ntest.skip('x')\n");
  const patch = captureDiff(dir, "HEAD", { env: cleanEnv() });
  assert.doesNotMatch(patch, /Binary files|GIT binary patch/);
  assert.match(patch, /^\+test\.skip\('x'\)$/m);
});

test("captureDiff of an untouched tree is empty", () => {
  const dir = repo();
  assert.equal(captureDiff(dir, "HEAD", { env: cleanEnv() }), "");
});

test("captureDiff runs read-tree, add -A and diff --cached on a temporary index, then removes it", () => {
  const calls = [];
  const removed = [];
  const deps = {
    env: { PATH: "/bin" },
    mkdtemp: () => "/tmp/qols-diff-x",
    rmdir: (dir) => removed.push(dir),
    exec: (argv, options) => {
      calls.push({ argv, cwd: options.cwd, index: options.env.GIT_INDEX_FILE });
      return { status: 0, stdout: argv[1] === "diff" ? "PATCH" : "", stderr: "" };
    },
  };
  assert.equal(captureDiff("/wt", "abc123", deps), "PATCH");
  assert.deepEqual(
    calls.map((call) => call.argv),
    [
      ["git", "read-tree", "abc123"],
      ["git", "add", "-A"],
      ["git", "diff", "--cached", "--text", "--no-color", "--no-ext-diff", "abc123"],
    ],
  );
  assert.ok(calls.every((call) => call.cwd === "/wt" && call.index === path.join("/tmp/qols-diff-x", "index")));
  assert.deepEqual(removed, ["/tmp/qols-diff-x"]);
});

test("captureDiff throws on a git failure and still removes the temporary index", () => {
  const removed = [];
  const deps = {
    env: {},
    mkdtemp: () => "/tmp/qols-diff-y",
    rmdir: (dir) => removed.push(dir),
    exec: (argv) => (argv[1] === "add" ? { status: 128, stdout: "", stderr: "fatal: nope" } : { status: 0, stdout: "", stderr: "" }),
  };
  assert.throws(() => captureDiff("/wt", "abc", deps), /git add failed in \/wt: fatal: nope/);
  assert.deepEqual(removed, ["/tmp/qols-diff-y"]);
});

test("changedPaths lists each file of a patch once", () => {
  const patch = "diff --git a/x/y.mjs b/x/y.mjs\n+1\ndiff --git a/z.mjs b/z.mjs\n+2\ndiff --git a/x/y.mjs b/x/y.mjs\n+3\n";
  assert.deepEqual(changedPaths(patch), ["x/y.mjs", "z.mjs"]);
  assert.deepEqual(changedPaths(""), []);
});

const repoApp = path.join("/r", "app");
const loopHolder = (name) => path.join("/r", "worktrees", name);
const loopTree = (name) => path.join(loopHolder(name), "app");

function recorder(responses = {}) {
  const calls = [];
  return {
    calls,
    exec: (argv, options) => {
      calls.push({ argv, cwd: options?.cwd });
      const key = argv.slice(1, 3).join(" ");
      return responses[key] ?? { status: 0, stdout: "", stderr: "" };
    },
  };
}

test("addWorktree creates the contract path and branch from the base", () => {
  const made = [];
  const rec = recorder({ "rev-parse --verify": { status: 1, stdout: "", stderr: "" } });
  const result = addWorktree({ repoRoot: repoApp, key: "demo", index: null, base: "abc" }, { ...rec, exists: () => false, mkdir: (dir) => made.push(dir) });
  assert.deepEqual(result, { path: loopTree("loop-demo"), branch: "loop-demo" });
  assert.deepEqual(made, [loopHolder("loop-demo")]);
  assert.deepEqual(rec.calls.at(-1).argv, ["git", "worktree", "add", "-b", "loop-demo", loopTree("loop-demo"), "abc"]);
  assert.equal(rec.calls.at(-1).cwd, repoApp);
});

test("addWorktree suffixes the implementer index and reuses an existing branch", () => {
  const rec = recorder();
  const result = addWorktree({ repoRoot: repoApp, key: "demo", index: 2, base: "abc" }, { ...rec, exists: () => false, mkdir: () => {} });
  assert.deepEqual(result, { path: loopTree("loop-demo-2"), branch: "loop-demo-2" });
  assert.deepEqual(rec.calls.at(-1).argv, ["git", "worktree", "add", loopTree("loop-demo-2"), "loop-demo-2"]);
});

test("addWorktree is a no-op when the worktree already exists", () => {
  const rec = recorder();
  const result = addWorktree({ repoRoot: repoApp, key: "demo", index: null, base: "abc" }, { ...rec, exists: (file) => file === path.join(loopTree("loop-demo"), ".git") });
  assert.equal(result.path, loopTree("loop-demo"));
  assert.equal(rec.calls.length, 0);
});

test("addWorktree throws when git worktree add fails", () => {
  const bad = recorder({
    "rev-parse --verify": { status: 1, stdout: "", stderr: "" },
    "worktree add": { status: 128, stdout: "", stderr: "fatal: exists" },
  });
  assert.throws(
    () => addWorktree({ repoRoot: "/r/app", key: "demo", index: null, base: "abc" }, { ...bad, exists: () => false, mkdir: () => {} }),
    /git worktree add failed for .*fatal: exists/,
  );
});

test("addWorktree passes the injected env and exec to every git call", () => {
  const rec = recorder({ "rev-parse --verify": { status: 1, stdout: "", stderr: "" } });
  const seen = [];
  const exec = (argv, options) => {
    seen.push(options.env);
    return rec.exec(argv, options);
  };
  addWorktree({ repoRoot: repoApp, key: "demo", index: null, base: "abc" }, { exec, env: { MARK: "1" }, exists: () => false, mkdir: () => {} });
  assert.equal(seen.length, 2);
  assert.ok(seen.every((env) => env.MARK === "1"));
});

test("removeWorktree never deletes a folder outside the worktrees holder when git refuses it", () => {
  const removed = [];
  const deps = { exec: () => ({ status: 1, stdout: "", stderr: "not a worktree" }), remove: (dir) => removed.push(dir) };
  const repoRoot = path.join(path.sep, "src", "main");
  assert.equal(removeWorktree(repoRoot, path.join(path.sep, "home", "me"), deps), false);
  assert.equal(removeWorktree(repoRoot, path.join(path.sep, "src", "worktrees", "..", "main"), deps), false);
  assert.deepEqual(removed, []);
  assert.equal(removeWorktree(repoRoot, path.join(path.sep, "src", "worktrees", "loop-k", "main"), deps), false);
  assert.deepEqual(removed, [path.join(path.sep, "src", "worktrees", "loop-k", "main")]);
});

test("a real worktree is added, reused and removed", () => {
  const main = repo();
  const head = git(main, "rev-parse", "HEAD");
  const deps = { env: cleanEnv() };
  const request = { repoRoot: main, key: "real", index: null, base: head };
  const first = addWorktree(request, deps);
  try {
    assert.deepEqual(first, { path: path.join(path.dirname(main), "worktrees", "loop-real", path.basename(main)), branch: "loop-real" });
    mkdirSync(path.join(first.path, "sub"), { recursive: true });
    assert.equal(git(first.path, "rev-parse", "--abbrev-ref", "HEAD"), "loop-real");
    assert.deepEqual(addWorktree(request, deps), first);
    assert.equal(removeWorktree(main, first.path, deps), true);
    assert.equal(deleteBranch(main, first.branch, deps), true);
    assert.throws(() => git(main, "rev-parse", "--verify", "refs/heads/loop-real"));
  } finally {
    rmSync(path.dirname(first.path), { recursive: true, force: true });
  }
});
