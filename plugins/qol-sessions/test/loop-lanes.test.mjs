import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { detectLanes, extractQuestion, pickSurface, runLane } from "../src/loop/lanes/index.mjs";
import { EXIT, LoopError, SURFACES } from "../src/loop/paths.mjs";
import { headlessArgv } from "../src/loop/lanes/headless.mjs";
import { spawnArgs } from "../src/loop/lanes/kitty.mjs";

const HELP_WITH_RECEIPT = "qol sessions spawn [--tool TOOL] ... --silent-wake still writes a receipt json at receipt_path";
const LANE = { tool: "claude", model: "claude-sonnet-5-5", effort: "high" };

const BIN = path.join("/bin");

function environment({ present = [], help = HELP_WITH_RECEIPT, env = {} } = {}) {
  const calls = [];
  return {
    calls,
    env: { PATH: BIN, ...env },
    exists: (file) => present.some((name) => file === path.join(BIN, name)),
    exec: (argv) => {
      calls.push(argv);
      return { status: 0, stdout: help, stderr: "" };
    },
  };
}

test("kitty wins when qol is on PATH and spawn help names receipt_path", () => {
  const deps = environment({ present: ["qol", "claude"], env: { QOLS_HEADLESS_LANES: "1" } });
  assert.equal(pickSurface({}, deps), "kitty");
  assert.deepEqual(deps.calls, [[path.join(BIN, "qol"), "sessions", "spawn", "--help"]]);
});

test("an older qol without receipt_path falls through to headless", () => {
  const deps = environment({ present: ["qol", "claude"], help: "qol sessions spawn --background", env: { QOLS_HEADLESS_LANES: "1" } });
  assert.equal(detectLanes(deps).kitty, false);
  assert.equal(pickSurface({}, deps), "headless");
});

test("headless needs both the env flag and claude on PATH", () => {
  assert.equal(detectLanes(environment({ present: ["claude"], env: { QOLS_HEADLESS_LANES: "1" } })).headless, true);
  assert.equal(detectLanes(environment({ present: ["claude"] })).headless, false);
  assert.equal(detectLanes(environment({ env: { QOLS_HEADLESS_LANES: "1" } })).headless, false);
  assert.equal(detectLanes(environment({ present: ["claude"], env: { QOLS_HEADLESS_LANES: "0" } })).headless, false);
});

test("with nothing available the surface is handover, and force wins over detection", () => {
  const deps = environment();
  assert.equal(pickSurface({}, deps), "handover");
  assert.equal(deps.calls.length, 0);
  for (const surface of SURFACES) assert.equal(pickSurface({ force: surface }, deps), surface);
  assert.throws(
    () => pickSurface({ force: "carrier-pigeon" }, deps),
    (error) => error instanceof LoopError && error.exit === EXIT.usage && /unknown surface/.test(error.message),
  );
});

test("detectLanes passes the environment to the spawn help probe and reports every fact", () => {
  const seen = [];
  const deps = {
    ...environment({ present: ["qol", "claude"], env: { QOLS_HEADLESS_LANES: "1" } }),
    exec: (argv, options) => {
      seen.push(options);
      return { status: 0, stdout: HELP_WITH_RECEIPT, stderr: "" };
    },
  };
  assert.deepEqual(detectLanes(deps), { qol: path.join(BIN, "qol"), kitty: true, claude: path.join(BIN, "claude"), headless: true });
  assert.deepEqual(seen, [{ env: deps.env }]);
});

test("extractQuestion reads a QUESTION: line and what follows", () => {
  assert.equal(extractQuestion("done\nQUESTION: which file?"), "which file?");
  assert.equal(extractQuestion("work\nQUESTION: a or b?\nmore context"), "a or b?\nmore context");
  assert.equal(extractQuestion("QUESTION:"), "(the lane asked without text)");
  assert.equal(extractQuestion("I have a QUESTION: inline only"), null);
  assert.equal(extractQuestion(""), null);
});

test("the kitty spawn argv follows the contract", () => {
  const argv = spawnArgs({ key: "demo", index: 2, cwd: "/wt", brief: "BRIEF", lane: LANE });
  assert.deepEqual(argv, [
    "qol", "sessions", "spawn", "--tool", "claude", "--model", "claude-sonnet-5-5", "--effort", "high", "--cwd", "/wt",
    "--key", "loop-demo-2", "--title", "loop-demo", "--task", "BRIEF", "--background", "--silent-wake",
  ]);
  assert.ok(!spawnArgs({ key: "demo", index: null, cwd: "/wt", brief: "B", lane: { tool: "claude", model: "m" } }).includes("--effort"));
  assert.ok(spawnArgs({ key: "demo", index: null, cwd: "/wt", brief: "B", lane: LANE }).includes("loop-demo"));
});

function kittyDeps({ spawnOut, appearsAfter = 2, report = "changed a.mjs lines 1-3", receipt, timeoutMs = 60000 } = {}) {
  const files = new Map();
  const state = { sleeps: 0, now: 0, execs: [] };
  const receiptFile = "/trace/lanes/rounds/abc/receipt.json";
  const reportFile = "/trace/lanes/rounds/abc/report.md";
  return {
    state,
    env: {},
    laneTimeoutMs: timeoutMs,
    pollMs: 1000,
    nowMs: () => state.now,
    sleep: async (ms) => {
      state.sleeps += 1;
      state.now += ms;
      if (state.sleeps >= appearsAfter) {
        files.set(receiptFile, JSON.stringify(receipt ?? { schema_version: 1, session: "sess-1", completion_marker: "M", report: reportFile }));
        if (report !== null) files.set(reportFile, report);
      }
    },
    exists: (file) => files.has(file),
    read: (file) => {
      if (!files.has(file)) throw new Error(`ENOENT ${file}`);
      return files.get(file);
    },
    exec: (argv) => {
      state.execs.push(argv);
      return spawnOut ?? { status: 0, stdout: JSON.stringify({ session: "sess-1", receipt_path: receiptFile, completion_marker: "M" }), stderr: "" };
    },
  };
}

const KITTY = { surface: "kitty", key: "demo", index: null, cwd: "/wt", brief: "BRIEF", lane: LANE, attempt: 1 };

test("kitty spawns, polls for the receipt_path the spawn printed, and reads the report", async () => {
  const deps = kittyDeps();
  const result = await runLane(KITTY, deps);
  assert.deepEqual(result, { exit: 0, text: "changed a.mjs lines 1-3", session: "sess-1", cost_usd: null, question: null, completion_marker: "M" });
  assert.equal(deps.state.sleeps, 2);
  assert.equal(deps.state.execs.length, 1);
  assert.equal(deps.state.execs[0][0], "qol");
  assert.ok(deps.state.execs[0].includes("--silent-wake"));
});

test("the kitty completion marker comes from the receipt, else from the spawn outcome, else is absent", async () => {
  const reportFile = "/trace/lanes/rounds/abc/report.md";
  const fromReceipt = await runLane(KITTY, kittyDeps({ receipt: { session: "sess-1", completion_marker: "RM", report: reportFile } }));
  assert.equal(fromReceipt.completion_marker, "RM");
  const fromSpawn = await runLane(KITTY, kittyDeps({ receipt: { session: "sess-1", report: reportFile } }));
  assert.equal(fromSpawn.completion_marker, "M");
  const neither = kittyDeps({ receipt: { session: "sess-1", report: reportFile } });
  neither.exec = () => ({ status: 0, stdout: JSON.stringify({ session: "sess-1", receipt_path: "/trace/lanes/rounds/abc/receipt.json" }), stderr: "" });
  assert.equal("completion_marker" in (await runLane(KITTY, neither)), false);
});

test("a kitty report with a QUESTION: line becomes a question", async () => {
  const result = await runLane(KITTY, kittyDeps({ report: "stopped\nQUESTION: use sqlite or json?" }));
  assert.equal(result.exit, 0);
  assert.equal(result.question, "use sqlite or json?");
});

test("kitty gives up after the bounded wait and never reports success", async () => {
  const deps = kittyDeps({ appearsAfter: 1000, timeoutMs: 5000 });
  const result = await runLane(KITTY, deps);
  assert.notEqual(result.exit, 0);
  assert.match(result.error, /no receipt at \/trace\/lanes\/rounds\/abc\/receipt\.json within 5s/);
  assert.equal(deps.state.sleeps, 5);
  assert.equal(result.question, null);
});

function listing(deps, answer) {
  const base = deps.exec;
  const state = { lists: 0 };
  deps.exec = (argv, options) => {
    if (argv[0] === "qol" && argv[1] === "sessions" && argv[2] === "list") {
      state.lists += 1;
      deps.state.execs.push(argv);
      return answer();
    }
    return base(argv, options);
  };
  return state;
}

test("kitty fails at once when the lane session is gone, checking every 15 polls", async () => {
  const deps = kittyDeps({ appearsAfter: 100000, timeoutMs: 7200000 });
  const state = listing(deps, () => ({ status: 0, stdout: JSON.stringify([{ session: "someone-else" }]), stderr: "" }));
  const result = await runLane(KITTY, deps);
  assert.notEqual(result.exit, 0);
  assert.match(result.error, /the lane session sess-1 is gone and wrote no receipt at \/trace\/lanes\/rounds\/abc\/receipt\.json/);
  assert.equal(result.session, "sess-1");
  assert.equal(deps.state.sleeps, 14);
  assert.equal(state.lists, 1);
  assert.deepEqual(deps.state.execs.at(-1), ["qol", "sessions", "list", "--json"]);
});

test("kitty keeps waiting while the lane session is listed or the listing cannot be read", async () => {
  const listed = kittyDeps({ appearsAfter: 40, timeoutMs: 7200000 });
  const live = listing(listed, () => ({ status: 0, stdout: JSON.stringify([{ session: "sess-1" }]), stderr: "" }));
  assert.equal((await runLane(KITTY, listed)).exit, 0);
  assert.equal(live.lists, 2);
  for (const answer of [{ status: 1, stdout: "", stderr: "boom" }, { status: 0, stdout: "not json", stderr: "" }, { status: 0, stdout: "{}", stderr: "" }]) {
    const deps = kittyDeps({ appearsAfter: 20, timeoutMs: 7200000 });
    listing(deps, () => answer);
    assert.equal((await runLane(KITTY, deps)).exit, 0, JSON.stringify(answer));
  }
});

test("kitty fails on a spawn error, a missing receipt_path, a missing report and an empty report", async () => {
  const failed = await runLane(KITTY, kittyDeps({ spawnOut: { status: 1, stdout: "", stderr: "no tab" } }));
  assert.notEqual(failed.exit, 0);
  assert.match(failed.error, /spawn failed: no tab/);
  const noPath = await runLane(KITTY, kittyDeps({ spawnOut: { status: 0, stdout: JSON.stringify({ session: "s" }), stderr: "" } }));
  assert.notEqual(noPath.exit, 0);
  assert.match(noPath.error, /no receipt_path/);
  const noReport = await runLane(KITTY, kittyDeps({ report: null }));
  assert.notEqual(noReport.exit, 0);
  assert.match(noReport.error, /cannot be read/);
  const empty = await runLane(KITTY, kittyDeps({ report: "  \n" }));
  assert.notEqual(empty.exit, 0);
  assert.match(empty.error, /is empty/);
});

test("a receipt file that is not valid yet is polled past", async () => {
  const deps = kittyDeps({ appearsAfter: 1 });
  let first = true;
  deps.read = ((read) => (file) => {
    if (first && file.endsWith("receipt.json")) {
      first = false;
      return "{half";
    }
    return read(file);
  })(deps.read);
  const result = await runLane(KITTY, deps);
  assert.equal(result.exit, 0);
  assert.equal(deps.state.sleeps, 2);
});

test("the headless argv is exactly the contract argv", () => {
  assert.deepEqual(headlessArgv({ brief: "BRIEF", lane: LANE, budget: 5, sessionId: "uuid-1", resume: false }), [
    "claude", "-p", "BRIEF", "--output-format", "json", "--permission-mode", "acceptEdits",
    "--allowedTools", "Read,Glob,Grep", "--disallowedTools", "Bash", "--setting-sources", "user",
    "--model", "claude-sonnet-5-5", "--max-budget-usd", "5", "--session-id", "uuid-1",
  ]);
  const argv = headlessArgv({ brief: "BRIEF", lane: LANE, budget: 5, sessionId: "uuid-1", resume: false });
  const allowed = argv[argv.indexOf("--allowedTools") + 1].split(",");
  assert.equal(allowed.includes("Edit"), false);
  assert.equal(allowed.includes("Write"), false);
  assert.equal(argv[argv.indexOf("--setting-sources") + 1], "user");
  const resumed = headlessArgv({ brief: "B", lane: LANE, budget: 2.5, sessionId: "uuid-1", resume: true });
  assert.deepEqual(resumed.slice(-4), ["--max-budget-usd", "2.5", "--resume", "uuid-1"]);
  assert.ok(!resumed.includes("--session-id"));
});

const HEADLESS = { surface: "headless", key: "demo", index: null, cwd: "/wt", brief: "BRIEF", lane: LANE, budget: 5, attempt: 1, sessionId: "uuid-1" };

function headlessDeps(outcome) {
  const calls = [];
  return {
    calls,
    env: { HOME: "/h" },
    spawn: async (argv, options) => {
      calls.push({ argv, options });
      return outcome;
    },
  };
}

test("headless runs claude -p in the worktree and parses the JSON result", async () => {
  const stdout = JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "edited a.mjs", session_id: "uuid-1", total_cost_usd: 0.42 });
  const deps = headlessDeps({ status: 0, stdout, stderr: "" });
  const result = await runLane(HEADLESS, deps);
  assert.deepEqual(result, { exit: 0, text: "edited a.mjs", session: "uuid-1", cost_usd: 0.42, question: null });
  assert.equal(deps.calls[0].options.cwd, "/wt");
  assert.ok(deps.calls[0].argv.includes("--session-id"));
});

test("headless resumes on attempt 2, on an answer, and when resume is forced", async () => {
  const stdout = JSON.stringify({ subtype: "success", is_error: false, result: "ok", session_id: "uuid-1" });
  for (const extra of [{ attempt: 2 }, { answer: "yes" }, { resume: true }]) {
    const deps = headlessDeps({ status: 0, stdout, stderr: "" });
    await runLane({ ...HEADLESS, ...extra }, deps);
    assert.ok(deps.calls[0].argv.includes("--resume"), JSON.stringify(extra));
    assert.ok(!deps.calls[0].argv.includes("--session-id"));
  }
});

test("a headless QUESTION: line is surfaced", async () => {
  const stdout = JSON.stringify({ subtype: "success", is_error: false, result: "QUESTION: which port?", session_id: "u" });
  const result = await runLane(HEADLESS, headlessDeps({ status: 0, stdout, stderr: "" }));
  assert.equal(result.question, "which port?");
});

test("headless failures are never exit 0", async () => {
  const cases = [
    { status: 1, stdout: "", stderr: "boom" },
    { status: null, stdout: "", stderr: "", error: "timeout" },
    { status: 0, stdout: "not json", stderr: "" },
    { status: 0, stdout: JSON.stringify({ subtype: "error_max_budget_usd", is_error: true, result: "" }), stderr: "" },
    { status: 0, stdout: JSON.stringify({ subtype: "success", is_error: true, result: "x" }), stderr: "" },
  ];
  for (const outcome of cases) {
    const result = await runLane(HEADLESS, headlessDeps(outcome));
    assert.notEqual(result.exit, 0, JSON.stringify(outcome));
    assert.equal(result.question, null);
    assert.ok(result.error);
  }
});

test("headless without a budget is a usage failure and never spawns", async () => {
  const deps = headlessDeps({ status: 0, stdout: "{}", stderr: "" });
  const result = await runLane({ ...HEADLESS, budget: null }, deps);
  assert.equal(result.exit, 2);
  assert.equal(deps.calls.length, 0);
});

test("handover starts no process and exits 14", async () => {
  const deps = { exec: () => assert.fail("no exec"), spawn: () => assert.fail("no spawn"), env: {} };
  assert.deepEqual(await runLane({ surface: "handover", key: "demo", index: null, cwd: "/wt", brief: "B", lane: LANE }, deps), {
    exit: 14,
    text: "",
    session: null,
    cost_usd: null,
    question: null,
  });
});

test("an unknown surface rejects", async () => {
  await assert.rejects(runLane({ surface: "pager" }, { env: {} }), /unknown surface/);
});
