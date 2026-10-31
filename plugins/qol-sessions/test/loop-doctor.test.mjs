import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { chooseSurface, detectLanes, doctorLoop, pruneOrphans } from "../src/loop/doctor.mjs";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-31T12:00:00Z");

function pluginRoot({ band = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-doctor-plugin-"));
  fs.mkdirSync(path.join(root, "hooks"));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.mkdirSync(path.join(root, "bin"));
  if (band) fs.writeFileSync(path.join(root, "hooks", "answer-band.ts"), "");
  fs.writeFileSync(path.join(root, "hooks", "prompt-modules.json"), JSON.stringify({ modules: band ? ["./answer-band.ts"] : [] }));
  fs.writeFileSync(path.join(root, "mcp.json"), JSON.stringify({ mcpServers: { "qol-sessions": { command: "qol" } } }));
  fs.writeFileSync(path.join(root, "scripts", "loop.mjs"), "");
  fs.writeFileSync(path.join(root, "bin", "qols"), "");
  return root;
}

function deps({ qol = true, receipt = true, headless = true, qac = true, root = pluginRoot() } = {}) {
  const present = new Set([qol && "/bin/qol", headless && "/bin/claude", qac && "/bin/qac"].filter(Boolean));
  return {
    pluginRoot: root,
    nodeVersion: "22.1.0",
    env: { PATH: "/bin", HOME: "/home/u", ...(headless ? { QOLS_HEADLESS_LANES: "1" } : {}) },
    exists: (file) => present.has(file) || (file.startsWith(os.tmpdir()) && fs.existsSync(file)),
    readdir: (dir) => fs.readdirSync(dir),
    exec: (argv) => {
      if (argv[1] === "sessions") return { status: 0, stdout: receipt ? "usage ... receipt_path ..." : "usage", stderr: "" };
      if (argv[0] === "git") return { status: 0, stdout: ".git\n", stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  };
}

function byName(result) {
  return Object.fromEntries(result.checks.map((entry) => [entry.check, entry]));
}

test("detectLanes and chooseSurface follow the contract order", () => {
  assert.deepEqual(detectLanes(deps()), { qol: "/bin/qol", kitty: true, claude: "/bin/claude", headless: true });
  assert.equal(chooseSurface(detectLanes(deps())), "kitty");
  assert.equal(chooseSurface(detectLanes(deps({ receipt: false }))), "headless");
  assert.equal(chooseSurface(detectLanes(deps({ qol: false, headless: false }))), "handover");
  assert.equal(chooseSurface({ kitty: true, headless: true }, "handover"), "handover");
});

test("headless lanes need both the env flag and claude on PATH", () => {
  const flagOnly = { ...deps({ headless: false }), env: { PATH: "/bin", QOLS_HEADLESS_LANES: "1" } };
  assert.equal(detectLanes(flagOnly).headless, false);
  const claudeOnly = { ...deps({ headless: true }), env: { PATH: "/bin" } };
  assert.equal(detectLanes(claudeOnly).headless, false);
});

test("doctor passes when everything is installed", () => {
  const result = doctorLoop({ cwd: "/repo" }, deps());
  const checks = byName(result);
  assert.equal(result.ok, true);
  for (const name of ["node", "qol", "kitty lanes", "headless lanes", "qac", "hooks module", "trust", "mcp", "script root"]) {
    assert.equal(checks[name].status, "pass", `${name}: ${checks[name].detail}`);
  }
});

test("missing lanes only warn because handover always works", () => {
  const result = doctorLoop({ cwd: "/repo" }, deps({ qol: false, headless: false }));
  const checks = byName(result);
  assert.equal(result.ok, true);
  assert.equal(checks.qol.status, "warn");
  assert.equal(checks["kitty lanes"].status, "warn");
  assert.equal(checks["headless lanes"].status, "warn");
  assert.ok(checks["kitty lanes"].fix);
});

test("a missing qac, a missing hooks module or an old node fails the doctor", () => {
  const noQac = doctorLoop({ cwd: "/repo" }, deps({ qac: false }));
  assert.equal(noQac.ok, false);
  assert.equal(byName(noQac).qac.status, "fail");
  assert.equal(byName(noQac).trust.status, "warn");
  const noBand = doctorLoop({ cwd: "/repo" }, deps({ root: pluginRoot({ band: false }) }));
  assert.equal(noBand.ok, false);
  assert.equal(byName(noBand)["hooks module"].status, "fail");
  const oldNode = doctorLoop({ cwd: "/repo" }, { ...deps(), nodeVersion: "16.20.0" });
  assert.equal(byName(oldNode).node.status, "fail");
});

test("an untrusted repository warns instead of failing", () => {
  const base = deps();
  const result = doctorLoop(
    { cwd: "/repo" },
    { ...base, exec: (argv, options) => (argv[1] === "trust" ? { status: 1, stdout: "", stderr: "" } : base.exec(argv, options)) },
  );
  assert.equal(byName(result).trust.status, "warn");
  assert.equal(result.ok, true);
});

function pruneSetup({ dirty = ["loop-dirty"] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-prune-"));
  const repo = path.join(root, "main");
  const common = path.join(repo, ".git");
  const loops = path.join(common, "qol-sessions", "loops");
  const wt = (name) => path.join(root, "worktrees", name, "main");
  fs.mkdirSync(path.join(loops, "live"), { recursive: true });
  fs.writeFileSync(path.join(loops, "live", "loop.json"), JSON.stringify({ key: "live", worktrees: [{ index: 1, path: wt("loop-live"), branch: "loop-live" }] }));
  fs.mkdirSync(path.join(loops, "done"), { recursive: true });
  fs.writeFileSync(path.join(loops, "done", "loop.json"), JSON.stringify({ key: "done", worktrees: [] }));
  fs.writeFileSync(path.join(loops, "done", "closed.json"), JSON.stringify({ kept: { path: wt("loop-done") } }));
  fs.mkdirSync(path.join(loops, "gone"), { recursive: true });
  fs.writeFileSync(
    path.join(loops, "gone", "loop.json"),
    JSON.stringify({
      key: "gone",
      worktrees: [
        { index: 1, path: wt("loop-old"), branch: "loop-old" },
        { index: 2, path: wt("loop-new"), branch: "loop-new" },
        { index: 3, path: wt("loop-dirty"), branch: "loop-dirty" },
      ],
    }),
  );
  fs.writeFileSync(path.join(loops, "gone", "closed.json"), JSON.stringify({ kept: { path: wt("loop-done") } }));
  const porcelain = [
    ["main", repo],
    ["loop-old", wt("loop-old")],
    ["loop-new", wt("loop-new")],
    ["loop-live", wt("loop-live")],
    ["loop-done", wt("loop-done")],
    ["loop-live-control", wt("loop-live-control")],
    ["loop-dirty", wt("loop-dirty")],
    ["loop-gate", wt("loop-gate")],
    ["feature", path.join(root, "elsewhere", "feature")],
  ]
    .map(([branch, dir]) => `worktree ${dir}\nHEAD abc\nbranch refs/heads/${branch}\n`)
    .join("\n");
  const ages = {
    [wt("loop-old")]: 4 * DAY,
    [wt("loop-new")]: 1 * DAY,
    [wt("loop-live-control")]: 9 * DAY,
    [wt("loop-dirty")]: 9 * DAY,
    [wt("loop-gate")]: 9 * DAY,
  };
  const calls = [];
  const prune = {
    now: () => NOW,
    stat: (file) => {
      if (!(file in ages)) throw new Error("ENOENT");
      return { mtimeMs: NOW.getTime() - ages[file] };
    },
    exec: (argv, options) => {
      calls.push(argv);
      if (argv[1] === "status") return { status: 0, stdout: dirty.some((name) => wt(name) === options.cwd) ? " M a.js\n" : "", stderr: "" };
      if (argv[2] === "--git-common-dir") return { status: 0, stdout: `${common}\n`, stderr: "" };
      if (argv[1] === "worktree" && argv[2] === "list") return { status: 0, stdout: porcelain, stderr: "" };
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  return { repo, wt, calls, prune };
}

test("prune removes only orphaned loop worktrees older than three days", () => {
  const ctx = pruneSetup();
  const result = pruneOrphans({ cwd: ctx.repo }, ctx.prune);
  assert.deepEqual(result.pruned, [{ path: ctx.wt("loop-old"), branch: "loop-old" }]);
  assert.deepEqual(result.kept.map((entry) => entry.path), [ctx.wt("loop-new"), ctx.wt("loop-dirty")]);
  assert.deepEqual(result.kept[0], { path: ctx.wt("loop-new"), branch: "loop-new", reason: "younger than 3 days" });
  assert.ok(ctx.calls.some((argv) => argv.join(" ") === `git worktree remove --force --force ${ctx.wt("loop-old")}`));
  assert.ok(ctx.calls.some((argv) => argv.join(" ") === "git branch -D loop-old"));
  for (const name of ["loop-new", "loop-live", "loop-done", "loop-gate"]) {
    assert.equal(ctx.calls.some((argv) => argv.includes(ctx.wt(name)) && argv[1] === "worktree" && argv[2] === "remove"), false, name);
  }
});

test("prune never touches a worktree no loop recorded, even under worktrees/loop-*/ and long idle", () => {
  const ctx = pruneSetup();
  pruneOrphans({ cwd: ctx.repo }, ctx.prune);
  assert.equal(ctx.calls.some((argv) => argv.includes(ctx.wt("loop-gate"))), false);
  assert.equal(ctx.calls.some((argv) => argv.join(" ") === "git branch -D loop-gate"), false);
});

test("prune skips a recorded orphan with uncommitted changes and reports it", () => {
  const ctx = pruneSetup();
  const result = pruneOrphans({ cwd: ctx.repo }, ctx.prune);
  assert.ok(!result.pruned.some((entry) => entry.path === ctx.wt("loop-dirty")));
  assert.ok(result.kept.some((entry) => entry.path === ctx.wt("loop-dirty") && entry.reason === "uncommitted changes"));
  assert.equal(ctx.calls.some((argv) => argv.includes(ctx.wt("loop-dirty")) && argv[2] === "remove"), false);
  assert.equal(ctx.calls.some((argv) => argv.join(" ") === "git branch -D loop-dirty"), false);
});

test("doctor --prune includes the prune report and plain doctor does not", () => {
  const ctx = pruneSetup();
  const base = deps();
  const merged = {
    ...base,
    ...ctx.prune,
    exec: (argv, options) => (argv[1] === "sessions" ? base.exec(argv, options) : ctx.prune.exec(argv, options)),
  };
  const withPrune = doctorLoop({ cwd: ctx.repo, prune: true }, merged);
  assert.equal(withPrune.prune.pruned.length, 1);
  assert.equal(doctorLoop({ cwd: ctx.repo }, merged).prune, undefined);
});
