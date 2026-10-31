import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { closeLoop } from "../src/loop/close.mjs";
import { EXIT, LoopError } from "../src/loop/paths.mjs";
import { runLoop } from "../src/loop/run.mjs";

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function setup({ implementers = 1, attempts = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-close-"));
  const repo = path.join(root, "main");
  const common = path.join(repo, ".git");
  const dir = path.join(common, "qol-sessions", "loops", "k1");
  const worktrees = Array.from({ length: implementers }, (_, i) => {
    const index = i + 1;
    const suffix = implementers === 1 ? "" : `-${index}`;
    return { index, path: path.join(root, "worktrees", `loop-k1${suffix}`, "main"), branch: `loop-k1${suffix}` };
  });
  writeJson(path.join(dir, "loop.json"), {
    schema: 1,
    key: "k1",
    repo_root: repo,
    base: "a".repeat(40),
    spec_sha: "c".repeat(64),
    lane: { tool: "claude", model: "claude-sonnet-5-5" },
    implementers,
    worktrees,
    control: false,
  });
  for (const attempt of attempts) {
    const folder = path.join(dir, attempt.name);
    if (attempt.gate) writeJson(path.join(folder, "gate.json"), attempt.gate);
    if (attempt.lane) writeJson(path.join(folder, "lane.json"), attempt.lane);
  }
  const retro = path.join(root, "retro.jsonl");
  const calls = [];
  const deps = {
    env: { PATH: "", QOL_SESSIONS_RETRO: retro },
    now: () => new Date("2026-10-31T12:00:00Z"),
    exec: (argv) => {
      calls.push(argv);
      if (argv[0] === "git" && argv[2] === "--git-common-dir") return { status: 0, stdout: `${common}\n`, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  return { root, repo, dir, worktrees, retro, calls, deps };
}

const RED = { verdict: "findings", changed: ["a.js"], findings: [{ id: "x#1" }], tamper: [] };
const GREEN = { verdict: "clean", changed: ["a.js", "b.js"], findings: [], tamper: [] };
const KITTY = { surface: "kitty", session: "kitty:1", completion_marker: "DONE_1", exit: 0, cost_usd: null, question: null };

test("an accepted close loop-closes the kitty lane, writes the retro line and prints the receipt", () => {
  const ctx = setup({
    attempts: [
      { name: "attempt-1", gate: RED, lane: KITTY },
      { name: "attempt-2", gate: GREEN, lane: { ...KITTY, completion_marker: "DONE_2" } },
    ],
  });
  const receipt = closeLoop("k1", { cwd: ctx.repo, outcome: "accepted" }, ctx.deps);
  assert.equal(receipt.exit, EXIT.ok);
  assert.equal(receipt.loop_closed, true);
  assert.deepEqual(receipt.final_report, {
    outcome: "accepted",
    key: "k1",
    attempts: 2,
    gate: { verdict: "clean", attempt: 2, findings: 0, tamper: 0 },
    remaining: "None.",
    worktree: ctx.worktrees[0].path,
  });
  const close = ctx.calls.find((argv) => argv[1] === "sessions");
  assert.deepEqual(close.slice(0, 8), ["qol", "sessions", "loop-close", "kitty:1", "--completion-marker", "DONE_2", "--outcome", "accepted"]);
  assert.equal(close[close.indexOf("--remaining") + 1], "None.");
  assert.match(close[close.indexOf("--landed") + 1], /^2 changed files in .* after 2 attempts$/);
  assert.deepEqual(receipt.lane_closes, [{ session: "kitty:1", exit: 0, error: null }]);
  const line = JSON.parse(fs.readFileSync(ctx.retro, "utf8").trim());
  assert.equal(line.loop_key, "k1");
  assert.equal(line.schema, 2);
  assert.equal(line.rounds, 2);
  assert.equal(line.review_caught_defects, 1);
  const closed = JSON.parse(fs.readFileSync(path.join(ctx.dir, "closed.json"), "utf8"));
  assert.equal(closed.outcome, "accepted");
  assert.equal(closed.kept.index, 1);
  assert.equal(closed.closed_at, "2026-10-31T12:00:00.000Z");
});

test("a second close returns the stored receipt without touching anything", () => {
  const ctx = setup({ attempts: [{ name: "attempt-1", gate: GREEN, lane: KITTY }] });
  const first = closeLoop("k1", { cwd: ctx.repo, outcome: "accepted" }, ctx.deps);
  const before = ctx.calls.length;
  const second = closeLoop("k1", { cwd: ctx.repo, outcome: "accepted" }, ctx.deps);
  assert.deepEqual(second.final_report, first.final_report);
  assert.equal(second.loop_closed, true);
  assert.equal(ctx.calls.length, before + 1);
  assert.equal(fs.readFileSync(ctx.retro, "utf8").trim().split("\n").length, 1);
});

test("accepting a loop whose gate is not clean is a usage error", () => {
  const ctx = setup({ attempts: [{ name: "attempt-1", gate: RED, lane: KITTY }] });
  assert.throws(
    () => closeLoop("k1", { cwd: ctx.repo, outcome: "accepted" }, ctx.deps),
    (error) => error instanceof LoopError && error.exit === EXIT.usage && /is findings, not clean/.test(error.message),
  );
  assert.equal(fs.existsSync(path.join(ctx.dir, "closed.json")), false);
  assert.equal(ctx.calls.some((argv) => argv[1] === "sessions"), false);
});

test("accepting a loop with no attempts is a usage error", () => {
  const ctx = setup();
  assert.throws(() => closeLoop("k1", { cwd: ctx.repo, outcome: "accepted" }, ctx.deps), /is none, not clean/);
});

test("pausing a red loop is allowed and keeps the worktree", () => {
  const ctx = setup({ attempts: [{ name: "attempt-1", gate: RED, lane: KITTY }] });
  const receipt = closeLoop("k1", { cwd: ctx.repo, outcome: "paused", remaining: "fix the lint" }, ctx.deps);
  assert.equal(receipt.final_report.outcome, "paused");
  assert.equal(receipt.final_report.remaining, "fix the lint");
  assert.equal(receipt.final_report.gate.verdict, "findings");
  assert.equal(receipt.removed.length, 0);
});

test("two implementers: the green one is kept and the other worktree and branch are removed", () => {
  const ctx = setup({
    implementers: 2,
    attempts: [
      { name: "attempt-1-1", gate: GREEN, lane: { ...KITTY, session: "kitty:1" } },
      { name: "attempt-1-2", gate: RED, lane: { ...KITTY, session: "kitty:2", completion_marker: "DONE_B" } },
    ],
  });
  const receipt = closeLoop("k1", { cwd: ctx.repo, outcome: "accepted" }, ctx.deps);
  assert.equal(receipt.final_report.worktree, ctx.worktrees[0].path);
  assert.deepEqual(receipt.removed, [{ path: ctx.worktrees[1].path, branch: "loop-k1-2" }]);
  assert.ok(ctx.calls.some((argv) => argv.join(" ") === `git worktree remove --force --force ${ctx.worktrees[1].path}`));
  assert.ok(ctx.calls.some((argv) => argv.join(" ") === "git branch -D loop-k1-2"));
  assert.equal(ctx.calls.some((argv) => argv.includes(ctx.worktrees[0].path) && argv[1] === "worktree"), false);
  const sessions = ctx.calls.filter((argv) => argv[2] === "loop-close").map((argv) => argv[3]);
  assert.deepEqual(sessions, ["kitty:1", "kitty:2"]);
});

test("--keep chooses the implementer whose worktree survives", () => {
  const ctx = setup({
    implementers: 2,
    attempts: [
      { name: "attempt-1-1", gate: GREEN },
      { name: "attempt-1-2", gate: GREEN },
    ],
  });
  assert.throws(() => closeLoop("k1", { cwd: ctx.repo, outcome: "paused", keep: 9 }, ctx.deps), LoopError);
  const receipt = closeLoop("k1", { cwd: ctx.repo, outcome: "accepted", keep: 2 }, ctx.deps);
  assert.equal(receipt.final_report.worktree, ctx.worktrees[1].path);
  assert.deepEqual(receipt.removed.map((entry) => entry.branch), ["loop-k1-1"]);
});

function recordControl(ctx) {
  const control = path.join(ctx.root, "worktrees", "loop-k1-control", "main");
  fs.mkdirSync(control, { recursive: true });
  const file = path.join(ctx.dir, "loop.json");
  const loop = JSON.parse(fs.readFileSync(file, "utf8"));
  writeJson(file, { ...loop, worktrees: [...loop.worktrees, { index: "control", path: control, branch: "loop-k1-control" }] });
  return control;
}

test("the control worktree is removed when loop.json lists it", () => {
  const ctx = setup({ attempts: [{ name: "attempt-1", gate: GREEN }] });
  const control = recordControl(ctx);
  const receipt = closeLoop("k1", { cwd: ctx.repo, outcome: "accepted" }, ctx.deps);
  assert.deepEqual(receipt.removed, [{ path: control, branch: "loop-k1-control" }]);
  assert.equal(receipt.final_report.worktree, ctx.worktrees[0].path);
});

test("a loop-<key>-control folder that loop.json does not list is never removed", () => {
  const ctx = setup({ attempts: [{ name: "attempt-1", gate: GREEN }] });
  const stray = path.join(ctx.root, "worktrees", "loop-k1-control", "main");
  fs.mkdirSync(stray, { recursive: true });
  const receipt = closeLoop("k1", { cwd: ctx.repo, outcome: "accepted" }, ctx.deps);
  assert.deepEqual(receipt.removed, []);
  assert.equal(ctx.calls.some((argv) => argv.includes(stray)), false);
  assert.equal(ctx.calls.some((argv) => argv.join(" ") === "git branch -D loop-k1-control"), false);
});

test("after a real kitty lane run, close calls qol sessions loop-close with the session and completion marker", async () => {
  const ctx = setup();
  fs.mkdirSync(ctx.worktrees[0].path, { recursive: true });
  fs.writeFileSync(path.join(ctx.dir, "spec.md"), '# Spec\n\nDo it.\n\n```json loop\n{"lane":{"tool":"claude","model":"claude-sonnet-5-5"}}\n```\n');
  const report = path.join(ctx.root, "report.md");
  const receiptFile = path.join(ctx.root, "receipt.json");
  fs.writeFileSync(report, "changed src/x.mjs");
  fs.writeFileSync(receiptFile, JSON.stringify({ session: "kitty:7", completion_marker: "DONE_7", report }));
  const gate = { schema: 1, verdict: "clean", changed: ["src/x.mjs"], findings: [], tamper: [] };
  const exec = ctx.deps.exec;
  const deps = {
    ...ctx.deps,
    pickSurface: () => "kitty",
    headlessAvailable: () => false,
    fetchTraps: async () => [],
    captureDiff: async () => "diff --git a/src/x.mjs b/src/x.mjs\n--- a/src/x.mjs\n+++ b/src/x.mjs\n@@ -1 +1 @@\n-a\n+b\n",
    runGate: async () => ({ exit: 0, gate, stderr: "" }),
    exec: (argv, options) => {
      if (argv[1] === "sessions" && argv[2] === "spawn") {
        ctx.calls.push(argv);
        return { status: 0, stdout: JSON.stringify({ session: "kitty:7", receipt_path: receiptFile }), stderr: "" };
      }
      return exec(argv, options);
    },
  };
  const ran = await runLoop("k1", { cwd: ctx.repo }, deps);
  assert.equal(ran.exit, EXIT.ok);
  const receipt = closeLoop("k1", { cwd: ctx.repo, outcome: "accepted" }, deps);
  const close = ctx.calls.find((argv) => argv[2] === "loop-close");
  assert.ok(close, "loop-close was never called");
  assert.deepEqual(close.slice(0, 6), ["qol", "sessions", "loop-close", "kitty:7", "--completion-marker", "DONE_7"]);
  assert.deepEqual(receipt.lane_closes, [{ session: "kitty:7", exit: 0, error: null }]);
});

test("a lane without a completion marker is reported as skipped, not closed", () => {
  const ctx = setup({ attempts: [{ name: "attempt-1", gate: GREEN, lane: { surface: "kitty", session: "kitty:1" } }] });
  const receipt = closeLoop("k1", { cwd: ctx.repo, outcome: "accepted" }, ctx.deps);
  assert.deepEqual(receipt.lane_closes, [{ session: "kitty:1", skipped: "lane.json has no completion_marker" }]);
  assert.equal(ctx.calls.some((argv) => argv[2] === "loop-close"), false);
});

test("headless lanes never call qol sessions loop-close", () => {
  const ctx = setup({ attempts: [{ name: "attempt-1", gate: GREEN, lane: { surface: "headless", session: "uuid", exit: 0, cost_usd: 0.4 } }] });
  const receipt = closeLoop("k1", { cwd: ctx.repo, outcome: "accepted" }, ctx.deps);
  assert.deepEqual(receipt.lane_closes, []);
  assert.equal(JSON.parse(fs.readFileSync(ctx.retro, "utf8")).cost_usd, 0.4);
});

test("a failing loop-close is reported but does not stop the close", () => {
  const ctx = setup({ attempts: [{ name: "attempt-1", gate: GREEN, lane: KITTY }] });
  const exec = ctx.deps.exec;
  const deps = {
    ...ctx.deps,
    exec: (argv, options) => (argv[2] === "loop-close" ? { status: 1, stdout: "", stderr: "no pending round\n" } : exec(argv, options)),
  };
  const receipt = closeLoop("k1", { cwd: ctx.repo, outcome: "accepted" }, deps);
  assert.equal(receipt.loop_closed, true);
  assert.deepEqual(receipt.lane_closes, [{ session: "kitty:1", exit: 1, error: "no pending round" }]);
});

test("close rejects a bad outcome and an unknown loop", () => {
  const ctx = setup();
  assert.throws(() => closeLoop("k1", { cwd: ctx.repo, outcome: "done" }, ctx.deps), /--outcome must be/);
  assert.throws(() => closeLoop("nope", { cwd: ctx.repo, outcome: "paused" }, ctx.deps), /no open loop/);
});
