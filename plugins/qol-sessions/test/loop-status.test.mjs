import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { EXIT, LoopError } from "../src/loop/paths.mjs";
import { statusLoop, summarizeLoop } from "../src/loop/status.mjs";

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-status-"));
  const repo = path.join(root, "main");
  const common = path.join(repo, ".git");
  const loops = path.join(common, "qol-sessions", "loops");
  const base = { schema: 1, base: "a".repeat(40), implementers: 1, worktrees: [], control: false, surface: "headless" };
  writeJson(path.join(loops, "alpha", "loop.json"), { ...base, key: "alpha" });
  writeJson(path.join(loops, "alpha", "baseline", "gate.json"), { verdict: "clean", findings: [] });
  writeJson(path.join(loops, "alpha", "attempt-1", "gate.json"), { verdict: "findings", findings: [{ id: "a#1" }, { id: "a#2" }], tamper: [{ id: "tamper#1" }] });
  writeJson(path.join(loops, "alpha", "attempt-1", "lane.json"), { surface: "headless", session: "s1", exit: 0, cost_usd: 0.3, question: null });
  writeJson(path.join(loops, "beta", "loop.json"), { ...base, key: "beta", surface: "kitty" });
  writeJson(path.join(loops, "beta", "question.json"), { text: "which db?" });
  writeJson(path.join(loops, "gamma", "loop.json"), { ...base, key: "gamma" });
  writeJson(path.join(loops, "gamma", "closed.json"), { outcome: "accepted" });
  writeJson(path.join(loops, "delta", "loop.json"), { ...base, key: "delta" });
  writeJson(path.join(loops, "delta", "attempt-1", "gate.json"), { verdict: "findings", findings: [{ id: "a#1" }], tamper: [] });
  writeJson(path.join(loops, "delta", "attempt-1", "verdict.json"), { blame: "judge" });
  writeJson(path.join(loops, "eps", "loop.json"), { ...base, key: "eps" });
  fs.mkdirSync(path.join(loops, "eps", "attempt-1"));
  fs.mkdirSync(path.join(loops, "junk"));
  const deps = { exec: () => ({ status: 0, stdout: `${common}\n`, stderr: "" }) };
  return { repo, loops, deps };
}

test("status lists every loop with a derived phase and skips folders without loop.json", () => {
  const ctx = setup();
  const result = statusLoop(undefined, { cwd: ctx.repo }, ctx.deps);
  assert.equal(result.exit, EXIT.ok);
  assert.deepEqual(result.loops.map((loop) => [loop.key, loop.phase]), [
    ["alpha", "gate:findings"],
    ["beta", "question"],
    ["delta", "verdict:judge"],
    ["eps", "running"],
    ["gamma", "closed"],
  ]);
});

test("status of one loop reports attempts, lane facts, baseline and outcome", () => {
  const ctx = setup();
  const { loop } = statusLoop("alpha", { cwd: ctx.repo }, ctx.deps);
  assert.equal(loop.surface, "headless");
  assert.deepEqual(loop.baseline, { verdict: "clean", findings: 0 });
  assert.deepEqual(loop.attempts, [
    {
      name: "attempt-1",
      n: 1,
      index: null,
      gate: "findings",
      findings: 2,
      tamper: 1,
      blame: null,
      lane: { surface: "headless", session: "s1", exit: 0, cost_usd: 0.3 },
    },
  ]);
  assert.equal(statusLoop("gamma", { cwd: ctx.repo }, ctx.deps).loop.outcome, "accepted");
  assert.deepEqual(statusLoop("beta", { cwd: ctx.repo }, ctx.deps).loop.question, { text: "which db?" });
});

test("a loop with no attempts is armed", () => {
  const ctx = setup();
  const root = path.join(path.dirname(ctx.loops), "loops", "zeta");
  writeJson(path.join(root, "loop.json"), { key: "zeta", surface: "handover", worktrees: [] });
  assert.equal(summarizeLoop(root).phase, "armed");
});

test("status of an unknown loop is a usage error and an empty repo lists nothing", () => {
  const ctx = setup();
  assert.throws(() => statusLoop("nope", { cwd: ctx.repo }, ctx.deps), (error) => error instanceof LoopError && error.exit === EXIT.usage);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "loop-status-empty-"));
  const deps = { exec: () => ({ status: 0, stdout: `${path.join(empty, ".git")}\n`, stderr: "" }) };
  assert.deepEqual(statusLoop(undefined, { cwd: empty }, deps).loops, []);
});
