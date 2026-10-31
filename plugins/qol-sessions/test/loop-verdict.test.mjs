import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT, LoopError } from "../src/loop/paths.mjs";
import { diffHunks, hunkContains, parseHunkRef, recordVerdict, validateVerdict } from "../src/loop/verdict.mjs";

const DIFF = [
  "diff --git a/src/a.js b/src/a.js",
  "--- a/src/a.js",
  "+++ b/src/a.js",
  "@@ -1,3 +1,4 @@",
  " one",
  "+two",
  " three",
  " four",
  "@@ -10,2 +11,2 @@",
  "-ten",
  "+eleven",
  " twelve",
  "",
].join("\n");

const GATE = {
  schema: 1,
  verdict: "findings",
  findings: [{ id: "eslint#1", judge: "eslint", rule: "no-unused", file: "src/a.js", line: 2, message: "unused 'x'", fingerprint: "fp1" }],
  tamper: [{ id: "tamper#1", kind: "suppression", file: "src/a.js", detail: "eslint-disable" }],
};

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-verdict-"));
  const repo = path.join(root, "main");
  const common = path.join(repo, ".git");
  const dir = path.join(common, "qol-sessions", "loops", "k1");
  const attempt = path.join(dir, "attempt-1");
  fs.mkdirSync(attempt, { recursive: true });
  fs.writeFileSync(path.join(dir, "loop.json"), JSON.stringify({ schema: 1, key: "k1" }));
  fs.writeFileSync(path.join(attempt, "gate.json"), JSON.stringify(GATE));
  fs.writeFileSync(path.join(attempt, "diff.patch"), DIFF);
  const calls = [];
  const optionsSeen = [];
  const state = { slipStatus: 0 };
  const deps = {
    env: { PATH: "/bin" },
    exists: (file) => file === "/bin/qac" || (file.startsWith(os.tmpdir()) && fs.existsSync(file)),
    now: () => new Date("2026-10-31T12:00:00Z"),
    exec: (argv, options) => {
      calls.push(argv);
      optionsSeen.push(options);
      if (argv[0] === "git") return { status: 0, stdout: `${common}\n`, stderr: "" };
      return { status: state.slipStatus, stdout: "", stderr: state.slipStatus === 0 ? "" : "ledger locked" };
    },
  };
  return { repo, dir, attempt, calls, optionsSeen, deps, state };
}

test("diffHunks reads file names and both line ranges per hunk", () => {
  assert.deepEqual(diffHunks(DIFF), [
    { oldFile: "src/a.js", newFile: "src/a.js", oldStart: 1, oldLines: 3, newStart: 1, newLines: 4 },
    { oldFile: "src/a.js", newFile: "src/a.js", oldStart: 10, oldLines: 2, newStart: 11, newLines: 2 },
  ]);
});

test("diffHunks does not mistake body lines that look like file headers", () => {
  const patch = ["--- a/f.txt", "+++ b/f.txt", "@@ -1,2 +1,2 @@", "--- removed dashes", "+++ added pluses", " tail", ""].join("\n");
  const hunks = diffHunks(patch);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0].newFile, "f.txt");
});

test("diffHunks handles new and deleted files", () => {
  const patch = ["--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1,2 @@", "+a", "+b", "--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-x", ""].join("\n");
  const hunks = diffHunks(patch);
  assert.deepEqual(hunks.map((hunk) => [hunk.oldFile, hunk.newFile]), [[null, "new.txt"], ["gone.txt", null]]);
  assert.equal(hunkContains(hunks, "new.txt", 2), true);
  assert.equal(hunkContains(hunks, "gone.txt", 1), true);
});

test("hunkContains accepts new-side and old-side lines of the right file only", () => {
  const hunks = diffHunks(DIFF);
  const cases = [
    ["src/a.js", 1, true],
    ["src/a.js", 4, true],
    ["src/a.js", 5, false],
    ["src/a.js", 8, false],
    ["src/a.js", 10, true],
    ["src/a.js", 12, true],
    ["src/a.js", 13, false],
    ["src/b.js", 2, false],
  ];
  for (const [file, line, expected] of cases) assert.equal(hunkContains(hunks, file, line), expected, `${file}:${line}`);
});

test("parseHunkRef splits on the last colon", () => {
  assert.deepEqual(parseHunkRef("src/a.js:12"), { file: "src/a.js", line: 12 });
  assert.deepEqual(parseHunkRef("c:/x/y.js:3"), { file: "c:/x/y.js", line: 3 });
  for (const bad of ["src/a.js", "src/a.js:", ":3", "src/a.js:x", "", undefined]) assert.equal(parseHunkRef(bad), null, String(bad));
});

test("validateVerdict requires a real finding id, a hunk inside the diff and a reason", () => {
  const context = { gate: GATE, diff: DIFF };
  const good = { blame: "impl", finding: "eslint#1", hunk: "src/a.js:2", why: "dead variable" };
  assert.deepEqual(validateVerdict(good, context), { ok: true, errors: [] });
  assert.equal(validateVerdict({ ...good, finding: "tamper#1" }, context).ok, true);
  const bad = [
    [{ ...good, blame: "implementation" }, /blame must be one of/],
    [{ ...good, finding: "eslint#9" }, /not in the gate\.json/],
    [{ ...good, finding: "" }, /finding is required/],
    [{ ...good, hunk: "src/a.js:5" }, /does not fall inside any hunk/],
    [{ ...good, hunk: "src/other.js:2" }, /does not fall inside any hunk/],
    [{ ...good, hunk: "nonsense" }, /PATH:LINE/],
    [{ ...good, why: "  " }, /why is required/],
  ];
  for (const [input, pattern] of bad) {
    const result = validateVerdict(input, context);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => pattern.test(error)), `${JSON.stringify(input)} -> ${result.errors}`);
  }
  assert.equal(validateVerdict(null, context).ok, false);
  assert.equal(validateVerdict(good, { gate: GATE, diff: "" }).ok, false);
});

test("an impl verdict is written into the attempt folder and points at run", () => {
  const ctx = setup();
  const result = recordVerdict("k1", { blame: "impl", finding: "eslint#1", hunk: "src/a.js:2", why: "dead variable" }, { cwd: ctx.repo }, ctx.deps);
  assert.equal(result.exit, EXIT.ok);
  assert.equal(result.next, "qols loop run k1");
  const saved = JSON.parse(fs.readFileSync(path.join(ctx.attempt, "verdict.json"), "utf8"));
  assert.equal(saved.blame, "impl");
  assert.equal(saved.fingerprint, "fp1");
  assert.equal(saved.attempt, 1);
  assert.equal(saved.recorded_at, "2026-10-31T12:00:00.000Z");
  assert.equal(ctx.calls.some((argv) => argv[1] === "slip"), false);
});

test("a spec verdict ends the loop and points at the v2 key", () => {
  const ctx = setup();
  const result = recordVerdict("k1", { blame: "spec", finding: "tamper#1", hunk: "src/a.js:1", why: "spec forbids the only fix" }, { cwd: ctx.repo }, ctx.deps);
  assert.match(result.next, /open k1-v2/);
  assert.equal(result.verdict.fingerprint, null);
});

test("a judge verdict records a judge-revert slip with the finding fingerprint", () => {
  const ctx = setup();
  const result = recordVerdict("k1", { blame: "judge", finding: "eslint#1", hunk: "src/a.js:2", why: "false positive" }, { cwd: ctx.repo }, ctx.deps);
  assert.equal(result.exit, EXIT.ok);
  assert.equal(result.next, "qols loop run k1 --gate-only");
  const slip = ctx.calls.find((argv) => argv[1] === "slip");
  assert.deepEqual(slip, [
    "/bin/qac", "slip", "--fingerprint", "fp1", "--from", "verdict:k1", "--route", "judge-revert", "--loop", "k1", "--cwd", ctx.repo,
    "--judge", "eslint", "--rule", "no-unused", "--message", "unused 'x'",
  ]);
});

test("the slip runs in the repo root, not the shell cwd, so repo_id matches the loop", () => {
  const ctx = setup();
  const elsewhere = path.join(ctx.repo, "sub", "dir");
  fs.mkdirSync(elsewhere, { recursive: true });
  const loopFile = path.join(ctx.dir, "loop.json");
  fs.writeFileSync(loopFile, JSON.stringify({ schema: 1, key: "k1", repo_root: "/the/main/clone" }));
  recordVerdict("k1", { blame: "judge", finding: "eslint#1", hunk: "src/a.js:2", why: "false positive" }, { cwd: elsewhere }, ctx.deps);
  const at = ctx.calls.findIndex((argv) => argv[1] === "slip");
  assert.deepEqual(ctx.optionsSeen[at], { cwd: "/the/main/clone" });
  assert.equal(ctx.calls[at][ctx.calls[at].indexOf("--cwd") + 1], "/the/main/clone");
});

test("a failing slip still records the verdict but exits 10", () => {
  const ctx = setup();
  ctx.state.slipStatus = 1;
  const result = recordVerdict("k1", { blame: "judge", finding: "eslint#1", hunk: "src/a.js:2", why: "false positive" }, { cwd: ctx.repo }, ctx.deps);
  assert.equal(result.exit, EXIT.infra);
  assert.equal(result.slip.error, "ledger locked");
  assert.equal(fs.existsSync(path.join(ctx.attempt, "verdict.json")), true);
});

test("a judge verdict on a tamper entry is rejected because it has no fingerprint", () => {
  const ctx = setup();
  assert.throws(
    () => recordVerdict("k1", { blame: "judge", finding: "tamper#1", hunk: "src/a.js:1", why: "x" }, { cwd: ctx.repo }, ctx.deps),
    (error) => error instanceof LoopError && error.exit === EXIT.usage && /no fingerprint/.test(error.message),
  );
  assert.equal(fs.existsSync(path.join(ctx.attempt, "verdict.json")), false);
});

test("an unknown finding or a hunk outside the diff is rejected and nothing is written", () => {
  const ctx = setup();
  for (const input of [
    { blame: "impl", finding: "nope#1", hunk: "src/a.js:2", why: "x" },
    { blame: "impl", finding: "eslint#1", hunk: "src/a.js:99", why: "x" },
  ]) {
    assert.throws(() => recordVerdict("k1", input, { cwd: ctx.repo }, ctx.deps), (error) => error instanceof LoopError && /verdict rejected/.test(error.message));
  }
  assert.equal(fs.existsSync(path.join(ctx.attempt, "verdict.json")), false);
});

test("the verdict lands on the newest attempt that holds the finding", () => {
  const ctx = setup();
  const second = path.join(ctx.dir, "attempt-2");
  fs.mkdirSync(second);
  fs.writeFileSync(path.join(second, "gate.json"), JSON.stringify(GATE));
  fs.writeFileSync(path.join(second, "diff.patch"), DIFF);
  const result = recordVerdict("k1", { blame: "impl", finding: "eslint#1", hunk: "src/a.js:2", why: "still dead" }, { cwd: ctx.repo }, ctx.deps);
  assert.equal(result.verdict.attempt, 2);
  assert.equal(fs.existsSync(path.join(second, "verdict.json")), true);
  assert.equal(fs.existsSync(path.join(ctx.attempt, "verdict.json")), false);
});

function twoImplementers(ctx) {
  fs.writeFileSync(path.join(ctx.dir, "loop.json"), JSON.stringify({ schema: 1, key: "k1", implementers: 2 }));
  fs.rmSync(ctx.attempt, { recursive: true });
  for (const name of ["attempt-1-1", "attempt-1-2"]) {
    const folder = path.join(ctx.dir, name);
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "gate.json"), JSON.stringify(GATE));
    fs.writeFileSync(path.join(folder, "diff.patch"), DIFF);
  }
}

test("with two implementers --index picks the attempt folder even when both hold the same finding id", () => {
  const ctx = setup();
  twoImplementers(ctx);
  const input = { blame: "impl", finding: "eslint#1", hunk: "src/a.js:2", why: "dead variable" };
  const first = recordVerdict("k1", input, { cwd: ctx.repo, index: 1 }, ctx.deps);
  assert.equal(first.verdict.index, 1);
  assert.equal(fs.existsSync(path.join(ctx.dir, "attempt-1-1", "verdict.json")), true);
  assert.equal(fs.existsSync(path.join(ctx.dir, "attempt-1-2", "verdict.json")), false);
  const second = recordVerdict("k1", input, { cwd: ctx.repo, index: "2" }, ctx.deps);
  assert.equal(second.verdict.index, 2);
  assert.equal(fs.existsSync(path.join(ctx.dir, "attempt-1-2", "verdict.json")), true);
});

test("with two implementers a missing or invalid --index is a usage error and nothing is written", () => {
  const ctx = setup();
  twoImplementers(ctx);
  const input = { blame: "impl", finding: "eslint#1", hunk: "src/a.js:2", why: "dead variable" };
  for (const index of [undefined, 0, 3, "x"]) {
    assert.throws(
      () => recordVerdict("k1", input, { cwd: ctx.repo, index }, ctx.deps),
      (error) => error instanceof LoopError && error.exit === EXIT.usage && /--index 1 or --index 2/.test(error.message),
      String(index),
    );
  }
  for (const name of ["attempt-1-1", "attempt-1-2"]) assert.equal(fs.existsSync(path.join(ctx.dir, name, "verdict.json")), false);
});

test("with one implementer --index may be omitted or 1 and anything else is a usage error", () => {
  const ctx = setup();
  const input = { blame: "impl", finding: "eslint#1", hunk: "src/a.js:2", why: "dead variable" };
  assert.throws(() => recordVerdict("k1", input, { cwd: ctx.repo, index: 2 }, ctx.deps), (error) => error instanceof LoopError && /one implementer/.test(error.message));
  assert.equal(recordVerdict("k1", input, { cwd: ctx.repo, index: 1 }, ctx.deps).verdict.attempt, 1);
});

test("a missing loop is a usage error", () => {
  const ctx = setup();
  assert.throws(() => recordVerdict("other", { blame: "impl", finding: "x", hunk: "a:1", why: "y" }, { cwd: ctx.repo }, ctx.deps), /no open loop/);
});
