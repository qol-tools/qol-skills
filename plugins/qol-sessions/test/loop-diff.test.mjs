import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { captureDiff, changedPaths } from "../src/loop/diff.mjs";
import { addWorktree, removeWorktree } from "../src/loop/worktree.mjs";

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
      ["git", "diff", "--cached", "--binary", "--no-color", "--no-ext-diff", "abc123"],
    ],
  );
  assert.ok(calls.every((call) => call.cwd === "/wt" && call.index === "/tmp/qols-diff-x/index"));
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
  const result = addWorktree({ repoRoot: "/r/app", key: "demo", index: null, base: "abc" }, { ...rec, exists: () => false, mkdir: (dir) => made.push(dir) });
  assert.deepEqual(result, { path: "/r/worktrees/loop-demo/app", branch: "loop-demo" });
  assert.deepEqual(made, ["/r/worktrees/loop-demo"]);
  assert.deepEqual(rec.calls.at(-1).argv, ["git", "worktree", "add", "-b", "loop-demo", "/r/worktrees/loop-demo/app", "abc"]);
  assert.equal(rec.calls.at(-1).cwd, "/r/app");
});

test("addWorktree suffixes the implementer index and reuses an existing branch", () => {
  const rec = recorder();
  const result = addWorktree({ repoRoot: "/r/app", key: "demo", index: 2, base: "abc" }, { ...rec, exists: () => false, mkdir: () => {} });
  assert.deepEqual(result, { path: "/r/worktrees/loop-demo-2/app", branch: "loop-demo-2" });
  assert.deepEqual(rec.calls.at(-1).argv, ["git", "worktree", "add", "/r/worktrees/loop-demo-2/app", "loop-demo-2"]);
});

test("addWorktree is a no-op when the worktree already exists", () => {
  const rec = recorder();
  const result = addWorktree({ repoRoot: "/r/app", key: "demo", index: null, base: "abc" }, { ...rec, exists: (file) => file === "/r/worktrees/loop-demo/app/.git" });
  assert.equal(result.path, "/r/worktrees/loop-demo/app");
  assert.equal(rec.calls.length, 0);
});

test("addWorktree accepts the positional form the open verb uses and throws on failure", () => {
  const ok = recorder({ "rev-parse --verify": { status: 1, stdout: "", stderr: "" } });
  const result = addWorktree("/r/app", "/r/wt/x", "abc", "loop-x", { ...ok, exists: () => false, mkdir: () => {} });
  assert.deepEqual(result, { path: "/r/wt/x", branch: "loop-x" });
  assert.deepEqual(ok.calls.at(-1).argv, ["git", "worktree", "add", "-b", "loop-x", "/r/wt/x", "abc"]);
  const bad = recorder({
    "rev-parse --verify": { status: 1, stdout: "", stderr: "" },
    "worktree add": { status: 128, stdout: "", stderr: "fatal: exists" },
  });
  assert.throws(
    () => addWorktree({ repoRoot: "/r/app", key: "demo", index: null, base: "abc" }, { ...bad, exists: () => false, mkdir: () => {} }),
    /git worktree add failed for .*fatal: exists/,
  );
});

test("removeWorktree removes through the main clone and deletes the loop branch", () => {
  const rec = recorder({
    "rev-parse --path-format=absolute": { status: 0, stdout: "/r/app/.git\n", stderr: "" },
    "rev-parse --abbrev-ref": { status: 0, stdout: "loop-demo-2\n", stderr: "" },
  });
  const result = removeWorktree("/r/worktrees/loop-demo-2/app", { ...rec, exists: () => true });
  assert.deepEqual(result, { removed: true, branch: "loop-demo-2" });
  const argvs = rec.calls.map((call) => call.argv);
  assert.deepEqual(argvs.at(-2), ["git", "worktree", "remove", "--force", "--force", "/r/worktrees/loop-demo-2/app"]);
  assert.deepEqual(argvs.at(-1), ["git", "branch", "-D", "loop-demo-2"]);
  assert.equal(rec.calls.at(-1).cwd, "/r/app");
});

test("removeWorktree keeps a branch the loop does not own and tolerates a missing directory", () => {
  const rec = recorder({
    "rev-parse --path-format=absolute": { status: 0, stdout: "/r/app/.git\n", stderr: "" },
    "rev-parse --abbrev-ref": { status: 0, stdout: "feature\n", stderr: "" },
  });
  assert.deepEqual(removeWorktree("/wt", { ...rec, exists: () => true }), { removed: true, branch: null });
  assert.ok(!rec.calls.some((call) => call.argv[1] === "branch"));
  const none = recorder();
  assert.deepEqual(removeWorktree("/gone", { ...none, exists: () => false }), { removed: false, branch: null });
  assert.equal(none.calls.length, 0);
});

test("a real worktree is added, reused and removed", () => {
  const main = repo();
  const holder = mkdtempSync(path.join(os.tmpdir(), "qols-wt-"));
  const dir = path.join(holder, "wt");
  const head = git(main, "rev-parse", "HEAD");
  const env = cleanEnv();
  const deps = { env };
  const first = addWorktree(main, dir, head, "loop-real", deps);
  assert.deepEqual(first, { path: dir, branch: "loop-real" });
  mkdirSync(path.join(dir, "sub"), { recursive: true });
  assert.equal(git(dir, "rev-parse", "--abbrev-ref", "HEAD"), "loop-real");
  assert.deepEqual(addWorktree(main, dir, head, "loop-real", deps), first);
  const removed = removeWorktree(dir, deps);
  assert.deepEqual(removed, { removed: true, branch: "loop-real" });
  assert.throws(() => git(main, "rev-parse", "--verify", "refs/heads/loop-real"));
});
