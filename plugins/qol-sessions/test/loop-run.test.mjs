import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { isControlLoop } from "../src/loop/control.mjs";
import { runLoop } from "../src/loop/run.mjs";

const PATCH = "diff --git a/src/x.mjs b/src/x.mjs\n--- a/src/x.mjs\n+++ b/src/x.mjs\n@@ -1 +1 @@\n-a\n+b\n";
const OK_LANE = { exit: 0, text: "changed src/x.mjs", session: "s1", cost_usd: 0.1, question: null };
const LANE_JSON = { surface: "kitty", session: "s1", exit: 0, cost_usd: 0.1, question: null };
const QAC_EXIT = { clean: 0, findings: 1, could_not_judge: 5, flaky_only: 6 };

const gate = (verdict, extra = {}) => ({ schema: 1, verdict, reason: null, changed: ["src/x.mjs"], judges: [], findings: [], tamper: [], ...extra });
const CLEAN = () => gate("clean");
const RED = () =>
  gate("findings", {
    findings: [{ id: "qac#1", judge: "qac", rule: "no-comments", file: "src/x.mjs", line: 1, message: "bad thing", fingerprint: "fp1", baseline: false }],
  });

function harness({ key = "demo", implementers = 1, surface = "kitty", control = false, budget = 5, env = {}, headless = false } = {}) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qols-run-"));
  const common = path.join(root, ".git");
  const dir = path.join(common, "qol-sessions", "loops", key);
  mkdirSync(dir, { recursive: true });
  const worktrees = [];
  for (let i = 1; i <= implementers; i += 1) {
    const wt = path.join(root, `wt${i}`);
    mkdirSync(wt);
    worktrees.push({ index: i, path: wt, branch: implementers === 2 ? `loop-${key}-${i}` : `loop-${key}` });
  }
  const loop = {
    schema: 1,
    key,
    repo_root: root,
    base: "base0",
    spec_sha: "sha0",
    lane: { tool: "claude", model: "claude-sonnet-5-5", effort: "high" },
    owned: ["src/**"],
    accept: [{ id: "unit", argv: ["node", "--test"] }],
    implementers,
    budget_usd: budget,
    worktrees,
    surface: null,
    control,
    created_at: "2026-01-01T00:00:00.000Z",
  };
  writeFileSync(path.join(dir, "loop.json"), JSON.stringify(loop));
  writeFileSync(path.join(dir, "spec.md"), '# Spec\n\nDo it.\n\n```json loop\n{"lane":{"tool":"claude","model":"claude-sonnet-5-5"},"owned":["src/**"]}\n```\n');
  const controlPath = path.join(root, "ctl");
  const h = {
    key,
    root,
    dir,
    worktrees,
    controlPath,
    surface,
    headless,
    traps: [],
    diff: PATCH,
    gates: [],
    gateQueues: new Map(),
    laneQueue: [],
    laneCalls: [],
    gateCalls: [],
    worktreeCalls: [],
    att: (n, slot = null) => path.join(dir, `attempt-${n}${slot === null ? "" : `-${slot}`}`),
    json: (...parts) => JSON.parse(readFileSync(path.join(...parts), "utf8")),
    seed: (n, slot, files) => {
      const folder = h.att(n, slot);
      mkdirSync(folder, { recursive: true });
      for (const [name, value] of Object.entries(files)) writeFileSync(path.join(folder, name), typeof value === "string" ? value : JSON.stringify(value));
    },
  };
  let uuids = 0;
  h.deps = {
    env,
    exec: (argv) =>
      argv[0] === "git" && argv.includes("--git-common-dir") ? { status: 0, stdout: `${common}\n`, stderr: "" } : { status: 1, stdout: "", stderr: "unexpected exec" },
    uuid: () => `uuid-${(uuids += 1)}`,
    pickSurface: () => h.surface,
    headlessAvailable: () => h.headless,
    fetchTraps: async () => h.traps,
    captureDiff: async (cwd) => (typeof h.diff === "function" ? h.diff(cwd) : h.diff),
    addWorktree: async (options) => {
      h.worktreeCalls.push(options);
      mkdirSync(controlPath, { recursive: true });
      return { path: controlPath, branch: `loop-${key}-control` };
    },
    runLane: async (opts) => {
      h.laneCalls.push(opts);
      if (opts.surface === "handover") return { exit: 14, text: "", session: null, cost_usd: null, question: null };
      return h.laneQueue.shift() ?? OK_LANE;
    },
    runGate: async (options) => {
      h.gateCalls.push(options);
      const queue = h.gateQueues.get(options.cwd) ?? h.gates;
      const next = queue.shift();
      if (!next) throw new Error(`no scripted gate for ${options.cwd}`);
      return "exit" in next ? next : { exit: QAC_EXIT[next.verdict], gate: next, stderr: "" };
    },
  };
  h.run = (opts = {}) => runLoop(key, { cwd: root, ...opts }, h.deps);
  return h;
}

test("a green first attempt writes every attempt file and calls the lane once", async () => {
  const h = harness();
  h.gates.push(CLEAN());
  const { exit, result } = await h.run();
  assert.equal(exit, 0);
  assert.equal(result.state, "green");
  assert.deepEqual(result.green, [1]);
  for (const name of ["brief.md", "diff.patch", "gate.json", "lane.json"]) assert.ok(existsSync(path.join(h.att(1), name)), name);
  assert.deepEqual(h.json(h.att(1), "lane.json"), { surface: "kitty", session: "s1", exit: 0, cost_usd: 0.1, question: null, completion_marker: null });
  assert.equal(h.json(h.att(1), "gate.json").verdict, "clean");
  assert.equal(readFileSync(path.join(h.att(1), "diff.patch"), "utf8"), PATCH);
  assert.equal(h.laneCalls.length, 1);
  const call = h.laneCalls[0];
  assert.equal(call.surface, "kitty");
  assert.equal(call.key, "demo");
  assert.equal(call.index, null);
  assert.equal(call.cwd, h.worktrees[0].path);
  assert.equal(call.attempt, 1);
  assert.equal(call.resume, false);
  assert.equal(call.sessionId, "uuid-1");
  assert.match(call.brief, /## Owned paths\n- src\/\*\*/);
  const gateCall = h.gateCalls[0];
  assert.equal(gateCall.cwd, h.worktrees[0].path);
  assert.equal(gateCall.base, "base0");
  assert.equal(gateCall.out, h.att(1));
  assert.equal(gateCall.loop, "demo");
  assert.equal(gateCall.attempt, 1);
  assert.equal(gateCall.specSha, "sha0");
  assert.equal(gateCall.accept, path.join(h.dir, "accept.json"));
  assert.equal(gateCall.owned, path.join(h.dir, "owned.json"));
  assert.equal(gateCall.spec, path.join(h.dir, "spec.md"));
});

test("the lane completion marker is written into lane.json so close can call loop-close", async () => {
  const h = harness();
  h.laneQueue.push({ ...OK_LANE, completion_marker: "DONE_X" });
  h.gates.push(CLEAN());
  await h.run();
  assert.equal(h.json(h.att(1), "lane.json").completion_marker, "DONE_X");
});

test("known traps reach the first brief", async () => {
  const h = harness();
  h.traps = [{ fingerprint: "t1", judge: "qac", rule: "no-comments", message: "comment added", loops: ["a", "b"] }];
  h.gates.push(CLEAN());
  await h.run();
  assert.match(h.laneCalls[0].brief, /## Known traps[\s\S]*comment added/);
});

test("a red gate gets exactly one automatic retry whose brief carries the findings and resumes the session", async () => {
  const h = harness();
  h.gates.push(RED(), CLEAN());
  const { exit, result } = await h.run();
  assert.equal(exit, 0);
  assert.equal(result.state, "green");
  assert.equal(h.laneCalls.length, 2);
  assert.equal(h.laneCalls[1].attempt, 2);
  assert.equal(h.laneCalls[1].resume, true);
  assert.equal(h.laneCalls[1].sessionId, "s1");
  assert.match(h.laneCalls[1].brief, /## Gate findings[\s\S]*qac#1 qac \/ no-comments at src\/x\.mjs:1: bad thing/);
  assert.match(h.laneCalls[1].brief, /## Owned paths/);
  assert.equal(h.json(h.att(1), "gate.json").verdict, "findings");
  assert.equal(h.json(h.att(2), "gate.json").verdict, "clean");
  assert.equal(h.gateCalls[1].attempt, 2);
  assert.ok(!existsSync(h.att(3)));
});

test("two red attempts escalate with a packet of the spec, both diffs and both gates", async () => {
  const h = harness();
  h.gates.push(RED(), RED());
  const { exit, result } = await h.run();
  assert.equal(exit, 12);
  assert.equal(result.state, "escalation");
  assert.equal(result.spec, path.join(h.dir, "spec.md"));
  assert.deepEqual(result.diffs, [path.join(h.att(1), "diff.patch"), path.join(h.att(2), "diff.patch")]);
  assert.deepEqual(result.gates, [path.join(h.att(1), "gate.json"), path.join(h.att(2), "gate.json")]);
  assert.equal(h.laneCalls.length, 2);
  assert.ok(!existsSync(h.att(3)));
  const again = await h.run();
  assert.equal(again.exit, 12);
  assert.equal(h.laneCalls.length, 2);
});

test("a crashed lane exits 10, skips the gate, and the next run redoes the same attempt", async () => {
  const h = harness();
  h.laneQueue.push({ exit: 1, text: "", session: null, cost_usd: null, question: null, error: "boom" });
  const first = await h.run();
  assert.equal(first.exit, 10);
  assert.match(first.result.reason, /boom/);
  assert.equal(h.gateCalls.length, 0);
  assert.ok(!existsSync(path.join(h.att(1), "gate.json")));
  assert.equal(h.json(h.att(1), "lane.json").exit, 1);
  h.gates.push(CLEAN());
  const second = await h.run();
  assert.equal(second.exit, 0);
  assert.equal(h.laneCalls.length, 2);
  assert.equal(h.laneCalls[1].attempt, 1);
  assert.ok(!existsSync(h.att(2)));
});

test("a lane that throws exits 10", async () => {
  const h = harness();
  h.deps.runLane = async () => {
    throw new Error("spawn exploded");
  };
  const { exit, result } = await h.run();
  assert.equal(exit, 10);
  assert.match(result.reason, /spawn exploded/);
});

test("a lane with no result text exits 10 and is recorded as failed", async () => {
  const h = harness();
  h.laneQueue.push({ exit: 0, text: "  ", session: "s1", cost_usd: 0, question: null });
  const { exit, result } = await h.run();
  assert.equal(exit, 10);
  assert.match(result.reason, /no result/);
  assert.equal(h.json(h.att(1), "lane.json").exit, 1);
  assert.equal(h.gateCalls.length, 0);
});

test("an empty diff is infra: no gate, and the next run calls the lane again", async () => {
  const h = harness();
  h.diff = "";
  const first = await h.run();
  assert.equal(first.exit, 10);
  assert.match(first.result.reason, /empty diff/);
  assert.equal(h.gateCalls.length, 0);
  assert.equal(h.json(h.att(1), "lane.json").empty_diff, true);
  h.diff = PATCH;
  h.gates.push(CLEAN());
  const second = await h.run();
  assert.equal(second.exit, 0);
  assert.equal(h.laneCalls.length, 2);
});

test("a lane question exits 13, writes question.json, and an answer resumes the same attempt", async () => {
  const h = harness();
  h.laneQueue.push({ exit: 0, text: "stopped\nQUESTION: which port?", session: "s9", cost_usd: 0, question: "which port?" });
  const first = await h.run();
  assert.equal(first.exit, 13);
  assert.equal(first.result.question, "which port?");
  const question = h.json(h.dir, "question.json");
  assert.equal(question.attempt, 1);
  assert.equal(question.question, "which port?");
  assert.equal(question.session, "s9");
  assert.equal(h.gateCalls.length, 0);
  const waiting = await h.run();
  assert.equal(waiting.exit, 13);
  assert.equal(h.laneCalls.length, 1);
  h.gates.push(CLEAN());
  const answered = await h.run({ answer: "port 8080" });
  assert.equal(answered.exit, 0);
  assert.equal(h.laneCalls.length, 2);
  assert.equal(h.laneCalls[1].attempt, 1);
  assert.equal(h.laneCalls[1].answer, "port 8080");
  assert.equal(h.laneCalls[1].resume, true);
  assert.equal(h.laneCalls[1].sessionId, "s9");
  assert.match(h.laneCalls[1].brief, /## Answer[\s\S]*port 8080/);
  assert.ok(!existsSync(path.join(h.dir, "question.json")));
  assert.ok(!existsSync(h.att(2)));
});

test("an answer with no open question is a usage error", async () => {
  const h = harness();
  const { exit } = await h.run({ answer: "x" });
  assert.equal(exit, 2);
  assert.equal(h.laneCalls.length, 0);
});

const GATE_FAILURES = [
  ["untrusted argv", { exit: 5, gate: gate("could_not_judge", { reason: "untrusted argv: node --test x.test.mjs" }), stderr: "" }, 11, /untrusted argv/],
  ["no judges", { exit: 5, gate: gate("could_not_judge", { reason: "no judges: run qac init" }), stderr: "" }, 10, /no judges/],
  ["flaky only", { exit: 6, gate: gate("flaky_only"), stderr: "" }, 10, /^flaky judge$/],
  ["qac usage error", { exit: 2, gate: null, stderr: "bad flag" }, 10, /bad flag/],
  ["spawn failure", { exit: -1, gate: null, stderr: "", error: "ENOENT" }, 10, /ENOENT/],
  ["clean verdict with a findings exit", { exit: 1, gate: gate("clean"), stderr: "" }, 10, /clean but qac exited 1/],
];

for (const [name, scripted, exit, reason] of GATE_FAILURES) {
  test(`gate failure: ${name} exits ${exit} and never 0`, async () => {
    const h = harness();
    h.gates.push(scripted);
    const result = await h.run();
    assert.equal(result.exit, exit);
    assert.match(result.result.reason, reason);
    assert.equal(h.laneCalls.length, 1);
  });
}

test("a gate that throws exits 10", async () => {
  const h = harness();
  const result = await h.run();
  assert.equal(result.exit, 10);
  assert.match(result.result.reason, /no scripted gate/);
});

test("after a gate that could not judge, the next run only re-gates", async () => {
  const h = harness();
  h.gates.push({ exit: 5, gate: gate("could_not_judge", { reason: "untrusted argv: x" }), stderr: "" }, CLEAN());
  assert.equal((await h.run()).exit, 11);
  assert.equal((await h.run()).exit, 0);
  assert.equal(h.laneCalls.length, 1);
  assert.equal(h.gateCalls.length, 2);
});

test("a green loop stays green without calling anything again", async () => {
  const h = harness();
  h.gates.push(CLEAN());
  await h.run();
  const again = await h.run();
  assert.equal(again.exit, 0);
  assert.equal(h.laneCalls.length, 1);
  assert.equal(h.gateCalls.length, 1);
});

test("the handover surface writes the brief, exits 14, and --gate-only then judges the worktree", async () => {
  const h = harness({ surface: "handover" });
  const first = await h.run();
  assert.equal(first.exit, 14);
  assert.equal(first.result.state, "handover");
  assert.deepEqual(first.result.briefs, [path.join(h.att(1), "brief.md")]);
  assert.deepEqual(first.result.worktrees, [h.worktrees[0].path]);
  assert.ok(existsSync(path.join(h.att(1), "brief.md")));
  assert.equal(h.gateCalls.length, 0);
  h.gates.push(CLEAN());
  const gated = await h.run({ gateOnly: true });
  assert.equal(gated.exit, 0);
  assert.equal(h.laneCalls.length, 1);
  assert.equal(h.json(h.att(1), "gate.json").verdict, "clean");
});

test("--gate-only on a first red exits 14 with the retry brief, and only the second red escalates with 12", async () => {
  const red = harness();
  red.gates.push(RED(), RED());
  const first = await red.run({ gateOnly: true });
  assert.equal(first.exit, 14);
  assert.equal(first.result.state, "red");
  assert.equal(first.result.attempt, 2);
  assert.deepEqual(first.result.briefs, [path.join(red.att(2), "brief.md")]);
  assert.equal(first.result.next, path.join(red.att(2), "brief.md"));
  const brief = readFileSync(path.join(red.att(2), "brief.md"), "utf8");
  assert.match(brief, /## Gate findings[\s\S]*qac#1 qac \/ no-comments at src\/x\.mjs:1: bad thing/);
  assert.match(brief, /## Owned paths/);
  assert.equal(red.json(red.att(1), "gate.json").verdict, "findings");
  const second = await red.run({ gateOnly: true });
  assert.equal(second.exit, 12);
  assert.equal(second.result.state, "escalation");
  assert.equal(red.laneCalls.length, 0);
  assert.equal(red.json(red.att(2), "gate.json").verdict, "findings");
  assert.ok(!existsSync(red.att(3)));
  const empty = harness();
  empty.diff = "";
  assert.equal((await empty.run({ gateOnly: true })).exit, 10);
});

const FIXTURE_LANE = { surface: "kitty", session: "s1", exit: 0, cost_usd: 0.1, question: null };

function twoRedAttempts(h, verdict) {
  h.seed(1, null, { "gate.json": RED(), "lane.json": FIXTURE_LANE, "diff.patch": PATCH });
  h.seed(2, null, { "gate.json": RED(), "lane.json": FIXTURE_LANE, "diff.patch": PATCH, ...(verdict ? { "verdict.json": verdict } : {}) });
}

test("an impl verdict allows one more attempt whose brief carries the verdict text", async () => {
  const h = harness();
  twoRedAttempts(h, { blame: "impl", finding: "qac#1", fingerprint: "fp1", hunk: "src/x.mjs:1", why: "handle empty input" });
  h.gates.push(CLEAN());
  const { exit } = await h.run();
  assert.equal(exit, 0);
  assert.equal(h.laneCalls.length, 1);
  assert.equal(h.laneCalls[0].attempt, 3);
  assert.equal(h.laneCalls[0].resume, true);
  assert.match(h.laneCalls[0].brief, /## Architect verdict[\s\S]*why: handle empty input/);
  assert.match(h.laneCalls[0].brief, /bad thing/);
  assert.ok(existsSync(path.join(h.att(3), "gate.json")));
});

test("a red third attempt escalates and never runs a fourth", async () => {
  const h = harness();
  twoRedAttempts(h, { blame: "impl", finding: "qac#1", fingerprint: "fp1", hunk: "src/x.mjs:1", why: "again" });
  h.gates.push(RED());
  const { exit, result } = await h.run();
  assert.equal(exit, 12);
  assert.equal(result.attempts.length, 3);
  assert.ok(!existsSync(h.att(4)));
});

test("two red attempts with no verdict stay escalated and call nothing", async () => {
  const h = harness();
  twoRedAttempts(h, null);
  const { exit, result } = await h.run();
  assert.equal(exit, 12);
  assert.equal(result.diffs.length, 2);
  assert.equal(h.laneCalls.length, 0);
  assert.equal(h.gateCalls.length, 0);
});

test("a judge verdict re-gates with the excluded fingerprint, calls no lane, and records regate.json", async () => {
  const h = harness();
  h.seed(1, null, {
    "gate.json": RED(),
    "lane.json": FIXTURE_LANE,
    "diff.patch": PATCH,
    "verdict.json": { blame: "judge", finding: "qac#1", fingerprint: "fp1", hunk: "src/x.mjs:1", why: "false positive" },
  });
  h.gates.push(CLEAN());
  const { exit, result } = await h.run({ gateOnly: true });
  assert.equal(exit, 0);
  assert.equal(result.state, "green");
  assert.equal(h.laneCalls.length, 0);
  assert.deepEqual(h.gateCalls[0].excludeFingerprints, ["fp1"]);
  assert.equal(h.gateCalls[0].attempt, 1);
  assert.ok(existsSync(path.join(h.att(1), "regate.json")));
  assert.equal(h.json(h.att(1), "gate.json").verdict, "clean");
});

test("a plain run re-gates after a judge verdict too, and a still-red re-gate moves on to the retry without the excluded finding", async () => {
  const h = harness();
  h.seed(1, null, {
    "gate.json": RED(),
    "lane.json": FIXTURE_LANE,
    "diff.patch": PATCH,
    "verdict.json": { blame: "judge", finding: "qac#1", fingerprint: "fp1", hunk: "src/x.mjs:1", why: "false positive" },
  });
  const other = gate("findings", {
    findings: [
      { id: "qac#1", judge: "qac", rule: "no-comments", file: "src/x.mjs", line: 1, message: "bad thing", fingerprint: "fp1", baseline: false },
      { id: "fmt#1", judge: "fmt", rule: "fmt", file: "src/x.mjs", line: 2, message: "unformatted", fingerprint: "fp2", baseline: false },
    ],
  });
  h.gates.push(other, CLEAN());
  const { exit } = await h.run();
  assert.equal(exit, 0);
  assert.deepEqual(h.gateCalls[0].excludeFingerprints, ["fp1"]);
  assert.equal(h.laneCalls.length, 1);
  assert.equal(h.laneCalls[0].attempt, 2);
  assert.match(h.laneCalls[0].brief, /unformatted/);
  assert.ok(!/bad thing/.test(h.laneCalls[0].brief.split("## Spec\n")[0]));
});

test("a spec verdict ends the loop with a pointer to the v2 key", async () => {
  const h = harness();
  h.seed(1, null, {
    "gate.json": RED(),
    "lane.json": FIXTURE_LANE,
    "diff.patch": PATCH,
    "verdict.json": { blame: "spec", finding: "qac#1", fingerprint: "fp1", hunk: "src/x.mjs:1", why: "ambiguous" },
  });
  const { exit, result } = await h.run();
  assert.equal(exit, 2);
  assert.equal(result.state, "spec_blamed");
  assert.equal(result.next, "demo-v2");
  assert.equal(h.laneCalls.length, 0);
  assert.equal(h.gateCalls.length, 0);
});

test("two implementers run in attempt-<n>-<i> folders, retry independently, and the probe flags disagreement", async () => {
  const h = harness({ implementers: 2 });
  h.diff = (cwd) => (cwd === h.worktrees[1].path ? `${PATCH}+extra\n` : PATCH);
  h.gateQueues.set(h.worktrees[0].path, [CLEAN()]);
  h.gateQueues.set(h.worktrees[1].path, [RED(), RED()]);
  const { exit, result } = await h.run();
  assert.equal(exit, 0);
  assert.deepEqual(result.green, [1]);
  assert.equal(result.ambiguous, true);
  assert.ok(result.reasons.some((reason) => /verdicts differ/.test(reason)));
  for (const folder of [h.att(1, 1), h.att(1, 2), h.att(2, 2)]) assert.ok(existsSync(folder), folder);
  assert.ok(!existsSync(h.att(2, 1)));
  const calls = h.laneCalls.map((call) => `${call.index}:${call.attempt}`).sort();
  assert.deepEqual(calls, ["1:1", "2:1", "2:2"]);
  assert.deepEqual(
    h.laneCalls.filter((call) => call.index === 2).map((call) => call.cwd),
    [h.worktrees[1].path, h.worktrees[1].path],
  );
});

test("two implementers that both fail escalate with every attempt listed", async () => {
  const h = harness({ implementers: 2 });
  h.gateQueues.set(h.worktrees[0].path, [RED(), RED()]);
  h.gateQueues.set(h.worktrees[1].path, [RED(), RED()]);
  const { exit, result } = await h.run();
  assert.equal(exit, 12);
  assert.equal(result.diffs.length, 4);
  assert.equal(result.gates.length, 4);
  assert.equal(result.ambiguous, false);
});

test("one crashed implementer makes the run exit 10 even when the other is green", async () => {
  const h = harness({ implementers: 2 });
  h.deps.runLane = async (opts) => {
    h.laneCalls.push(opts);
    return opts.index === 2 ? { exit: 1, text: "", session: null, cost_usd: null, question: null, error: "boom" } : OK_LANE;
  };
  h.gateQueues.set(h.worktrees[0].path, [CLEAN()]);
  const { exit } = await h.run();
  assert.equal(exit, 10);
});

function controlKey() {
  for (let i = 0; i < 500; i += 1) if (isControlLoop(`ctl${i}`, {})) return `ctl${i}`;
  throw new Error("no control key found");
}

test("the opus control runs headless in its own worktree, is gated into control/, and never changes the outcome", async () => {
  const h = harness({ key: controlKey(), control: true, headless: true });
  h.gates.push(CLEAN());
  h.gateQueues.set(h.controlPath, [RED()]);
  const { exit, result } = await h.run();
  assert.equal(exit, 0);
  assert.equal(result.control.state, "gated");
  assert.equal(result.control.verdict, "findings");
  assert.equal(h.laneCalls.length, 2);
  const control = h.laneCalls.find((call) => call.index === "control");
  assert.equal(control.surface, "headless");
  assert.deepEqual(control.lane, { tool: "claude", model: "claude-opus-5-5", effort: "high" });
  assert.equal(control.cwd, h.controlPath);
  assert.equal(control.budget, 5);
  assert.equal(control.resume, false);
  assert.deepEqual(h.worktreeCalls, [{ repoRoot: h.root, key: h.key, index: "control", base: "base0" }]);
  const folder = path.join(h.dir, "control");
  for (const name of ["brief.md", "diff.patch", "gate.json", "lane.json"]) assert.ok(existsSync(path.join(folder, name)), name);
  assert.equal(h.json(folder, "gate.json").verdict, "findings");
  const loop = h.json(h.dir, "loop.json");
  assert.deepEqual(loop.worktrees.at(-1), { index: "control", path: h.controlPath, branch: `loop-${h.key}-control` });
  const again = await h.run();
  assert.equal(again.exit, 0);
  assert.equal(h.laneCalls.length, 2);
});

test("a failed control lane is reported but the main outcome still wins", async () => {
  const h = harness({ key: controlKey(), control: true, headless: true });
  h.gates.push(CLEAN());
  h.deps.runLane = async (opts) => {
    h.laneCalls.push(opts);
    return opts.index === "control" ? { exit: 1, text: "", session: null, cost_usd: null, question: null, error: "x" } : OK_LANE;
  };
  const { exit, result } = await h.run();
  assert.equal(exit, 0);
  assert.equal(result.control.state, "lane_failed");
});

test("no control run when it is switched off, headless is unavailable, or the loop did not select it", async () => {
  const off = harness({ key: controlKey(), control: true, headless: true, env: { QOLS_CONTROL: "0" } });
  off.gates.push(CLEAN());
  const offResult = await off.run();
  assert.equal(offResult.result.control, undefined);
  assert.equal(off.laneCalls.length, 1);
  const noHeadless = harness({ key: controlKey(), control: true, headless: false });
  noHeadless.gates.push(CLEAN());
  await noHeadless.run();
  assert.equal(noHeadless.laneCalls.length, 1);
  const unselected = harness({ key: controlKey(), control: false, headless: true });
  unselected.gates.push(CLEAN());
  await unselected.run();
  assert.equal(unselected.laneCalls.length, 1);
  assert.equal(unselected.worktreeCalls.length, 0);
});

test("a headless run without budget_usd is a usage error before any lane starts", async () => {
  const h = harness({ surface: "headless", budget: null });
  const { exit, result } = await h.run();
  assert.equal(exit, 2);
  assert.match(result.error, /budget_usd/);
  assert.equal(h.laneCalls.length, 0);
});

test("unknown, closed and badly named loops are usage errors", async () => {
  const h = harness();
  assert.equal((await runLoop("other", { cwd: h.root }, h.deps)).exit, 2);
  assert.equal((await runLoop("Bad Key", { cwd: h.root }, h.deps)).exit, 2);
  writeFileSync(path.join(h.dir, "closed.json"), "{}");
  const closed = await h.run();
  assert.equal(closed.exit, 2);
  assert.match(closed.result.error, /closed/);
});

test("the surface comes from --surface, then loop.json, then detection", async () => {
  const seen = [];
  const h = harness();
  h.deps.pickSurface = ({ force }) => {
    seen.push(force);
    return "kitty";
  };
  h.gates.push(CLEAN());
  await h.run({ surface: "headless" });
  assert.deepEqual(seen, ["headless"]);
  const stored = harness();
  const loop = stored.json(stored.dir, "loop.json");
  writeFileSync(path.join(stored.dir, "loop.json"), JSON.stringify({ ...loop, surface: "handover" }));
  const seenStored = [];
  stored.deps.pickSurface = ({ force }) => {
    seenStored.push(force);
    return "handover";
  };
  await stored.run();
  assert.deepEqual(seenStored, ["handover"]);
});
