import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { isControlLoop } from "../src/loop/control.mjs";
import { openLoop } from "../src/loop/open.mjs";
import { EXIT, LoopError } from "../src/loop/paths.mjs";

const BIN = path.join("/bin");
const QAC = path.join(BIN, "qac");
const SPEC = "# spec\n";
const BASE = "b".repeat(40);

function front(extra = {}) {
  return {
    lane: { tool: "claude", model: "claude-sonnet-5-5", effort: "high" },
    owned: ["plugins/x/**"],
    accept: [{ id: "unit", argv: ["make", "test"] }],
    implementers: 1,
    ...extra,
  };
}

function setup({ trustStatus = 0, trustStdout = "", gateVerdict = "clean", gateStatus = 0, frontMatter = front(), errors = [] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-open-"));
  const repo = path.join(root, "main");
  const common = path.join(repo, ".git");
  fs.mkdirSync(common, { recursive: true });
  const specFile = path.join(root, "spec.md");
  fs.writeFileSync(specFile, SPEC);
  const calls = [];
  const worktrees = [];
  const state = { trustStatus, gateVerdict, gateStatus };
  const exec = (argv) => {
    calls.push(argv);
    if (argv[0] === "git" && argv[2] === "--git-common-dir") return { status: 0, stdout: `${common}\n`, stderr: "" };
    if (argv[0] === "git" && argv[2] === "--verify") return { status: 0, stdout: `${BASE}\n`, stderr: "" };
    if (argv[0] === QAC && argv[1] === "trust") return { status: state.trustStatus, stdout: trustStdout, stderr: "" };
    if (argv[0] === QAC && argv[1] === "gate") {
      const out = argv[argv.indexOf("--out") + 1];
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, "gate.json"), JSON.stringify({ schema: 1, verdict: state.gateVerdict, reason: state.gateVerdict === "could_not_judge" ? "no judges: run qac init" : null, findings: [{ id: "qac#1" }] }));
      return { status: state.gateStatus, stdout: "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected" };
  };
  const deps = {
    exec,
    env: { PATH: BIN },
    exists: (file) => file === QAC || (file.startsWith(os.tmpdir()) && !file.includes(`${path.sep}worktrees${path.sep}`) && fs.existsSync(file)),
    now: () => new Date("2026-10-31T12:00:00Z"),
    parseSpec: (text) => ({ ok: true, front: frontMatter, text }),
    validateFront: () => errors,
    addWorktree: (request) => worktrees.push(request),
  };
  return { root, repo, common, specFile, calls, worktrees, deps, state };
}

test("open freezes the spec, arms the loop folder and runs the baseline gate", () => {
  const ctx = setup();
  const result = openLoop("k1", { cwd: ctx.repo, spec: ctx.specFile }, ctx.deps);
  const dir = path.join(ctx.common, "qol-sessions", "loops", "k1");
  const wt = path.join(ctx.root, "worktrees", "loop-k1", "main");
  assert.equal(result.loop_armed, true);
  assert.equal(result.exit, EXIT.ok);
  assert.equal(result.base, BASE);
  assert.equal(result.surface, "handover");
  assert.deepEqual(result.worktrees, [{ index: 1, path: wt, branch: "loop-k1" }]);
  assert.deepEqual(result.baseline, { verdict: "clean", findings: 1 });
  assert.equal(fs.readFileSync(path.join(dir, "spec.md"), "utf8"), SPEC);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "accept.json"), "utf8")), front().accept);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "owned.json"), "utf8")), front().owned);
  const loop = JSON.parse(fs.readFileSync(path.join(dir, "loop.json"), "utf8"));
  assert.equal(loop.schema, 1);
  assert.equal(loop.repo_root, ctx.repo);
  assert.equal(loop.spec_sha, createHash("sha256").update(SPEC).digest("hex"));
  assert.equal(loop.created_at, "2026-10-31T12:00:00.000Z");
  assert.equal(loop.control, false);
  assert.deepEqual(loop.lane, front().lane);
  assert.deepEqual(ctx.worktrees, [{ repoRoot: ctx.repo, key: "k1", index: null, base: BASE }]);
  const gate = ctx.calls.find((argv) => argv[1] === "gate");
  assert.equal(gate[gate.indexOf("--cwd") + 1], wt);
  assert.equal(gate[gate.indexOf("--out") + 1], path.join(dir, "baseline"));
  assert.equal(gate[gate.indexOf("--loop") + 1], "k1");
  assert.equal(gate.includes("--accept"), false);
  assert.equal(fs.existsSync(path.join(dir, "baseline", "gate.json")), true);
});

test("open prints a trust request with exit 11 and creates no worktree", () => {
  const stdout = JSON.stringify({ untrusted: [{ id: "unit", argv: ["make", "test"] }] });
  const ctx = setup({ trustStatus: 1, trustStdout: stdout });
  const result = openLoop("k1", { cwd: ctx.repo, spec: ctx.specFile }, ctx.deps);
  assert.equal(result.exit, EXIT.needsTrust);
  assert.equal(result.loop_armed, false);
  assert.deepEqual(result.untrusted, [{ id: "unit", argv: ["make", "test"] }]);
  assert.match(result.approve, /^qac trust approve --cwd .* --accept .*accept\.json$/);
  assert.match(result.approve_note, /for the user to type/);
  assert.deepEqual(ctx.worktrees, []);
  assert.equal(ctx.calls.some((argv) => argv[1] === "gate"), false);
});

test("open lists every accept argv when qac gives no untrusted list", () => {
  const ctx = setup({ trustStatus: 1, trustStdout: "" });
  const result = openLoop("k1", { cwd: ctx.repo, spec: ctx.specFile }, ctx.deps);
  assert.deepEqual(result.untrusted, [{ id: "unit", argv: ["make", "test"] }]);
});

test("open creates one suffixed worktree per implementer", () => {
  const ctx = setup({ frontMatter: front({ implementers: 2 }) });
  const result = openLoop("k2", { cwd: ctx.repo, spec: ctx.specFile }, ctx.deps);
  assert.deepEqual(
    result.worktrees.map((entry) => [entry.index, path.relative(ctx.root, entry.path), entry.branch]),
    [
      [1, path.join("worktrees", "loop-k2-1", "main"), "loop-k2-1"],
      [2, path.join("worktrees", "loop-k2-2", "main"), "loop-k2-2"],
    ],
  );
  assert.deepEqual(ctx.worktrees.map((request) => request.index), [1, 2]);
  const gate = ctx.calls.find((argv) => argv[1] === "gate");
  assert.equal(gate[gate.indexOf("--cwd") + 1], result.worktrees[0].path);
});

test("open honours an explicit base revision", () => {
  const ctx = setup();
  openLoop("k1", { cwd: ctx.repo, spec: ctx.specFile, base: "release" }, ctx.deps);
  assert.ok(ctx.calls.some((argv) => argv[2] === "--verify" && argv[3] === "release^{commit}"));
});

test("open exits 10 when the baseline gate could not judge", () => {
  const ctx = setup({ gateVerdict: "could_not_judge", gateStatus: 5 });
  assert.throws(
    () => openLoop("k1", { cwd: ctx.repo, spec: ctx.specFile }, ctx.deps),
    (error) => error instanceof LoopError && error.exit === EXIT.infra && /no judges: run qac init/.test(error.message),
  );
});

test("open rejects an invalid spec with a usage error before touching disk", () => {
  const ctx = setup({ errors: ["lane.model is required"] });
  assert.throws(
    () => openLoop("k1", { cwd: ctx.repo, spec: ctx.specFile }, ctx.deps),
    (error) => error instanceof LoopError && error.exit === EXIT.usage && /lane\.model is required/.test(error.message),
  );
  assert.equal(fs.existsSync(path.join(ctx.common, "qol-sessions")), false);
});

test("open rejects bad keys, missing spec flag and unreadable spec files", () => {
  const ctx = setup();
  assert.throws(() => openLoop("Bad Key", { cwd: ctx.repo, spec: ctx.specFile }, ctx.deps), LoopError);
  assert.throws(() => openLoop("k1", { cwd: ctx.repo }, ctx.deps), /needs --spec/);
  assert.throws(() => openLoop("k1", { cwd: ctx.repo, spec: path.join(ctx.root, "none.md") }, ctx.deps), /cannot read spec/);
});

test("open refuses a loop that is already armed", () => {
  const ctx = setup();
  openLoop("k1", { cwd: ctx.repo, spec: ctx.specFile }, ctx.deps);
  assert.throws(() => openLoop("k1", { cwd: ctx.repo, spec: ctx.specFile }, ctx.deps), /already armed/);
});

test("open can be re-run after a trust request once the loop is trusted", () => {
  const ctx = setup({ trustStatus: 1 });
  assert.equal(openLoop("k1", { cwd: ctx.repo, spec: ctx.specFile }, ctx.deps).exit, EXIT.needsTrust);
  ctx.state.trustStatus = 0;
  const again = openLoop("k1", { cwd: ctx.repo, spec: ctx.specFile }, ctx.deps);
  assert.equal(again.loop_armed, true);
  assert.equal(ctx.worktrees.length, 1);
});

function controlKeys() {
  const yes = [];
  const no = [];
  for (let i = 0; yes.length < 3 || no.length < 3; i += 1) (isControlLoop(`key${i}`, {}) ? yes : no).push(`key${i}`);
  return { yes: yes.slice(0, 3), no: no.slice(0, 3) };
}

test("the control flag is recorded from the key hash and the headless check, through the one lane detector", () => {
  const { yes, no } = controlKeys();
  for (const key of yes) {
    const on = setup();
    on.deps.detectLanes = () => ({ headless: true });
    assert.equal(openLoop(key, { cwd: on.repo, spec: on.specFile }, on.deps).control, true, key);
    const noHeadless = setup();
    noHeadless.deps.detectLanes = () => ({ headless: false });
    assert.equal(openLoop(key, { cwd: noHeadless.repo, spec: noHeadless.specFile }, noHeadless.deps).control, false, key);
    const off = setup();
    off.deps.detectLanes = () => ({ headless: true });
    off.deps.env = { ...off.deps.env, QOLS_CONTROL: "0" };
    assert.equal(openLoop(key, { cwd: off.repo, spec: off.specFile }, off.deps).control, false, key);
  }
  for (const key of no) {
    const ctx = setup();
    ctx.deps.detectLanes = () => ({ headless: true });
    assert.equal(openLoop(key, { cwd: ctx.repo, spec: ctx.specFile }, ctx.deps).control, false, key);
  }
});

test("the recorded surface comes from the lane detector's pick", () => {
  const ctx = setup();
  ctx.deps.pickSurface = () => "headless";
  ctx.deps.detectLanes = () => ({ headless: true });
  const result = openLoop("k1", { cwd: ctx.repo, spec: ctx.specFile }, ctx.deps);
  assert.equal(result.surface, "headless");
  const dir = path.join(ctx.common, "qol-sessions", "loops", "k1");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "loop.json"), "utf8")).surface, "headless");
});

test("a baseline that could not judge leaves the loop unarmed, so open can run again once the cause is fixed", () => {
  const ctx = setup({ gateVerdict: "could_not_judge", gateStatus: 5 });
  assert.throws(() => openLoop("k1", { cwd: ctx.repo, spec: ctx.specFile }, ctx.deps), (error) => error.exit === EXIT.infra);
  const dir = path.join(ctx.common, "qol-sessions", "loops", "k1");
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "baseline", "gate.json"), "utf8")).verdict, "could_not_judge");
  ctx.state.gateVerdict = "clean";
  ctx.state.gateStatus = 0;
  const again = openLoop("k1", { cwd: ctx.repo, spec: ctx.specFile }, ctx.deps);
  assert.equal(again.loop_armed, true);
  assert.equal(again.baseline.verdict, "clean");
  assert.throws(() => openLoop("k1", { cwd: ctx.repo, spec: ctx.specFile }, ctx.deps), /already armed/);
});
