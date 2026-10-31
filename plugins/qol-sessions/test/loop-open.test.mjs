import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { controlApplies, openLoop } from "../src/loop/open.mjs";
import { EXIT, LoopError } from "../src/loop/paths.mjs";

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
  const state = { trustStatus };
  const exec = (argv) => {
    calls.push(argv);
    if (argv[0] === "git" && argv[2] === "--git-common-dir") return { status: 0, stdout: `${common}\n`, stderr: "" };
    if (argv[0] === "git" && argv[2] === "--verify") return { status: 0, stdout: `${BASE}\n`, stderr: "" };
    if (argv[0] === "/bin/qac" && argv[1] === "trust") return { status: state.trustStatus, stdout: trustStdout, stderr: "" };
    if (argv[0] === "/bin/qac" && argv[1] === "gate") {
      const out = argv[argv.indexOf("--out") + 1];
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, "gate.json"), JSON.stringify({ schema: 1, verdict: gateVerdict, reason: gateVerdict === "could_not_judge" ? "no judges: run qac init" : null, findings: [{ id: "qac#1" }] }));
      return { status: gateStatus, stdout: "", stderr: "" };
    }
    return { status: 1, stdout: "", stderr: "unexpected" };
  };
  const deps = {
    exec,
    env: { PATH: "/bin" },
    exists: (file) => file === "/bin/qac" || (file.startsWith(os.tmpdir()) && !file.includes("/worktrees/") && fs.existsSync(file)),
    now: () => new Date("2026-10-31T12:00:00Z"),
    parseSpec: (text) => ({ ok: true, front: frontMatter, text }),
    validateFront: () => errors,
    addWorktree: (...args) => worktrees.push(args),
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
  assert.deepEqual(ctx.worktrees, [[ctx.repo, wt, BASE, "loop-k1"]]);
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
  assert.equal(ctx.worktrees.length, 2);
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

test("the control lane applies to one key in five and only with headless lanes", () => {
  const keys = ["alpha", "beta", "gamma", "delta", "epsilon", "k1", "k2", "k3", "k4", "k5", "feature-x", "feature-y"];
  const expected = (key) => parseInt(createHash("sha256").update(key).digest("hex").slice(0, 8), 16) % 5 === 0;
  for (const key of keys) {
    assert.equal(controlApplies(key, {}, true), expected(key), key);
    assert.equal(controlApplies(key, {}, false), false, key);
    assert.equal(controlApplies(key, { QOLS_CONTROL: "0" }, true), false, key);
  }
});
