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
  const ctx = { tree: "tree0" };
  for (const attempt of attempts) {
    const folder = path.join(dir, attempt.name);
    const n = Number(/^attempt-(\d+)/.exec(attempt.name)[1]);
    if (attempt.gate) writeJson(path.join(folder, "gate.json"), attempt.gate.verdict === "clean" && !("tree" in attempt.gate) ? { ...attempt.gate, loop: "k1", attempt: n, base: "a".repeat(40), tree: "tree0" } : attempt.gate);
    if (attempt.lane) writeJson(path.join(folder, "lane.json"), attempt.lane);
    if (attempt.verdict) writeJson(path.join(folder, "verdict.json"), attempt.verdict);
  }
  const retro = path.join(root, "retro.jsonl");
  const calls = [];
  const deps = {
    env: { PATH: "", QOL_SESSIONS_RETRO: retro },
    now: () => new Date("2026-10-31T12:00:00Z"),
    worktreeTree: () => ctx.tree,
    exec: (argv) => {
      calls.push(argv);
      if (argv[0] === "git" && argv[2] === "--git-common-dir") return { status: 0, stdout: `${common}\n`, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  return Object.assign(ctx, { root, repo, dir, worktrees, retro, calls, deps });
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

test("pausing keeps every worktree and branch, including the second implementer's and the control's", () => {
  const ctx = setup({
    implementers: 2,
    attempts: [
      { name: "attempt-1-1", gate: GREEN },
      { name: "attempt-1-2", gate: RED },
    ],
  });
  const control = recordControl(ctx);
  const receipt = closeLoop("k1", { cwd: ctx.repo, outcome: "paused" }, ctx.deps);
  assert.deepEqual(receipt.removed, []);
  assert.equal(ctx.calls.some((argv) => argv[1] === "worktree" || argv[1] === "branch"), false);
  const closed = JSON.parse(fs.readFileSync(path.join(ctx.dir, "closed.json"), "utf8"));
  assert.deepEqual(closed.kept_all.map((entry) => entry.path), [ctx.worktrees[0].path, ctx.worktrees[1].path, control]);
});

test("a closed loop closes again only with the same outcome", () => {
  const ctx = setup({ attempts: [{ name: "attempt-1", gate: GREEN, lane: KITTY }] });
  closeLoop("k1", { cwd: ctx.repo, outcome: "paused" }, ctx.deps);
  assert.throws(
    () => closeLoop("k1", { cwd: ctx.repo, outcome: "accepted" }, ctx.deps),
    (error) => error instanceof LoopError && error.exit === EXIT.usage && /already closed as paused/.test(error.message),
  );
  assert.equal(closeLoop("k1", { cwd: ctx.repo, outcome: "paused" }, ctx.deps).final_report.outcome, "paused");
  assert.equal(fs.readFileSync(ctx.retro, "utf8").trim().split("\n").length, 1);
});

const STALE = [
  ["a worktree edited after the gate", (ctx) => { ctx.tree = "edited"; }, /changed since the gate judged it/],
  ["a gate for another attempt", (ctx, dir) => writeJson(path.join(dir, "attempt-1", "gate.json"), { ...GREEN, loop: "k1", attempt: 4, base: "a".repeat(40), tree: "tree0" }), /gate\.json attempt is 4, not 1/],
  ["a gate for another base", (ctx, dir) => writeJson(path.join(dir, "attempt-1", "gate.json"), { ...GREEN, loop: "k1", attempt: 1, base: "b".repeat(40), tree: "tree0" }), /gate\.json base is/],
  ["a gate for another loop", (ctx, dir) => writeJson(path.join(dir, "attempt-1", "gate.json"), { ...GREEN, loop: "other", attempt: 1, base: "a".repeat(40), tree: "tree0" }), /gate\.json loop is "other"/],
  ["a gate with no tree", (ctx, dir) => writeJson(path.join(dir, "attempt-1", "gate.json"), { ...GREEN, loop: "k1", attempt: 1, base: "a".repeat(40) }), /records no tree/],
];

for (const [name, mutate, message] of STALE) {
  test(`accepting refuses ${name}, and pausing still works`, () => {
    const ctx = setup({ attempts: [{ name: "attempt-1", gate: GREEN, lane: KITTY }] });
    mutate(ctx, ctx.dir);
    assert.throws(
      () => closeLoop("k1", { cwd: ctx.repo, outcome: "accepted" }, ctx.deps),
      (error) => error instanceof LoopError && error.exit === EXIT.usage && message.test(error.message) && /qols loop run k1/.test(error.message),
    );
    assert.equal(fs.existsSync(path.join(ctx.dir, "closed.json")), false);
    assert.equal(ctx.calls.some((argv) => argv[1] === "sessions"), false);
    assert.equal(closeLoop("k1", { cwd: ctx.repo, outcome: "paused" }, ctx.deps).final_report.outcome, "paused");
  });
}

test("a second driver holding the loop makes close exit 2 naming the pid, and nothing is written", () => {
  const ctx = setup({ attempts: [{ name: "attempt-1", gate: GREEN, lane: KITTY }] });
  fs.writeFileSync(path.join(ctx.dir, "run.lock"), JSON.stringify({ pid: process.pid }));
  assert.throws(
    () => closeLoop("k1", { cwd: ctx.repo, outcome: "accepted" }, ctx.deps),
    (error) => error instanceof LoopError && error.exit === EXIT.usage && error.message.includes(`pid ${process.pid}`),
  );
  assert.equal(fs.existsSync(path.join(ctx.dir, "closed.json")), false);
});

test("the lock is released after a close, so a later close is not refused", () => {
  const ctx = setup({ attempts: [{ name: "attempt-1", gate: GREEN, lane: KITTY }] });
  closeLoop("k1", { cwd: ctx.repo, outcome: "accepted" }, ctx.deps);
  assert.equal(fs.existsSync(path.join(ctx.dir, "run.lock")), false);
});

test("--skill-gap lands in the retro line and a blank one is refused", () => {
  const ctx = setup({ attempts: [{ name: "attempt-1", gate: GREEN, lane: KITTY }] });
  assert.throws(() => closeLoop("k1", { cwd: ctx.repo, outcome: "accepted", skillGap: "  " }, ctx.deps), /--skill-gap needs text/);
  closeLoop("k1", { cwd: ctx.repo, outcome: "accepted", skillGap: "the spec never named the owned test folder" }, ctx.deps);
  assert.equal(JSON.parse(fs.readFileSync(ctx.retro, "utf8")).skill_gap, "the spec never named the owned test folder");
});

test("a spec verdict becomes the skill gap candidate and judge verdicts list their fingerprints in slips", () => {
  const ctx = setup({
    attempts: [
      { name: "attempt-1", gate: RED, lane: KITTY, verdict: { blame: "judge", finding: "x#1", fingerprint: "fp9", file: "a.js" } },
      { name: "attempt-2", gate: GREEN, lane: KITTY, verdict: { blame: "spec", finding: "x#2", why: "two readings of the owned paths" } },
    ],
  });
  closeLoop("k1", { cwd: ctx.repo, outcome: "accepted" }, ctx.deps);
  const line = JSON.parse(fs.readFileSync(ctx.retro, "utf8"));
  assert.equal(line.skill_gap, "the spec was blamed for x#2: two readings of the owned paths");
  assert.deepEqual(line.slips, ["fp9"]);
  assert.equal(line.nudge, null);
});

test("the control lane's verdict and cost go into the retro line", () => {
  const ctx = setup({ attempts: [{ name: "attempt-1", gate: GREEN, lane: KITTY }] });
  writeJson(path.join(ctx.dir, "control", "lane.json"), { surface: "headless", exit: 0, cost_usd: 1.25, worktree: { path: path.join(ctx.root, "ctl"), branch: "loop-k1-control" } });
  writeJson(path.join(ctx.dir, "control", "gate.json"), { verdict: "findings" });
  closeLoop("k1", { cwd: ctx.repo, outcome: "accepted" }, ctx.deps);
  assert.deepEqual(JSON.parse(fs.readFileSync(ctx.retro, "utf8")).control, { verdict: "findings", cost_usd: 1.25 });
});

test("a loop with no control lane writes control null", () => {
  const ctx = setup({ attempts: [{ name: "attempt-1", gate: GREEN, lane: KITTY }] });
  closeLoop("k1", { cwd: ctx.repo, outcome: "accepted" }, ctx.deps);
  assert.equal(JSON.parse(fs.readFileSync(ctx.retro, "utf8")).control, null);
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
  writeJson(path.join(ctx.dir, "control", "lane.json"), { surface: "headless", exit: 0, cost_usd: 0.5, worktree: { path: control, branch: "loop-k1-control" } });
  return control;
}

test("the control worktree recorded in control/lane.json is removed on an accepted close", () => {
  const ctx = setup({ attempts: [{ name: "attempt-1", gate: GREEN }] });
  const control = recordControl(ctx);
  const receipt = closeLoop("k1", { cwd: ctx.repo, outcome: "accepted" }, ctx.deps);
  assert.deepEqual(receipt.removed, [{ path: control, branch: "loop-k1-control" }]);
  assert.equal(receipt.final_report.worktree, ctx.worktrees[0].path);
});

test("close removes the control worktree at its derived path, never the path control/lane.json names", () => {
  const ctx = setup({ attempts: [{ name: "attempt-1", gate: GREEN }] });
  const control = path.join(ctx.root, "worktrees", "loop-k1-control", "main");
  const elsewhere = path.join(ctx.root, "home");
  writeJson(path.join(ctx.dir, "control", "lane.json"), { surface: "headless", exit: 0, worktree: { path: elsewhere, branch: "main" } });
  const receipt = closeLoop("k1", { cwd: ctx.repo, outcome: "accepted" }, ctx.deps);
  assert.deepEqual(receipt.removed, [{ path: control, branch: "loop-k1-control" }]);
  assert.equal(ctx.calls.some((argv) => argv.includes(elsewhere)), false);
  assert.equal(ctx.calls.some((argv) => argv.join(" ") === "git branch -D main"), false);
});

test("a loop-<key>-control folder that control/lane.json does not record is never removed", () => {
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
  writeJson(path.join(ctx.dir, "baseline", "gate.json"), { verdict: "clean" });
  const gate = { schema: 1, verdict: "clean", changed: ["src/x.mjs"], findings: [], tamper: [] };
  const exec = ctx.deps.exec;
  const deps = {
    ...ctx.deps,
    pickSurface: () => "kitty",
    detectLanes: () => ({ headless: false }),
    fetchTraps: async () => [],
    captureDiff: async () => "diff --git a/src/x.mjs b/src/x.mjs\n--- a/src/x.mjs\n+++ b/src/x.mjs\n@@ -1 +1 @@\n-a\n+b\n",
    runGate: async (options) => ({ exit: 0, gate: { ...gate, loop: options.loop, attempt: options.attempt, base: options.base, tree: "tree0" }, stderr: "" }),
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
