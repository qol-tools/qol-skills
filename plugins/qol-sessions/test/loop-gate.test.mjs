import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { QAC_EXIT, fetchTraps, gateArgs, gateFailure, gateStale, qacTrust, resolveQac, runGate, worktreeTree } from "../src/loop/gate.mjs";
import { EXIT, LoopError } from "../src/loop/paths.mjs";

const BIN = path.join("/bin");
const QAC = path.join(BIN, "qac");

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loop-gate-"));
}

test("resolveQac prefers qac on PATH", () => {
  const second = path.join("/b");
  const found = resolveQac({ env: { PATH: [path.join("/a"), second].join(path.delimiter) }, platform: "linux", exists: (file) => file === path.join(second, "qac") });
  assert.deepEqual(found, { argv: [path.join(second, "qac")], source: "path" });
});

test("resolveQac falls back to the newest cached qol-project script", () => {
  const cache = path.join("/home/u", ".claude", "plugins", "cache");
  const plugin = path.join(cache, "m", "qol-project");
  const older = path.join(plugin, "0.9.0", "scripts", "qac.mjs");
  const newer = path.join(plugin, "1.0.0", "scripts", "qac.mjs");
  const tree = { [cache]: ["m"], [plugin]: ["0.9.0", "1.0.0"] };
  const deps = {
    env: { PATH: "", HOME: "/home/u" },
    execPath: "/usr/bin/node",
    readdir: (dir) => {
      if (!(dir in tree)) throw new Error("ENOENT");
      return tree[dir];
    },
    exists: (file) => file === older || file === newer,
    stat: (file) => ({ mtimeMs: file === newer ? 200 : 100 }),
  };
  assert.deepEqual(resolveQac(deps), { argv: ["/usr/bin/node", newer], source: "cache" });
});

test("resolveQac returns null when nothing is installed", () => {
  const deps = {
    env: { PATH: "", HOME: "/home/u" },
    readdir: () => {
      throw new Error("ENOENT");
    },
    exists: () => false,
  };
  assert.equal(resolveQac(deps), null);
});

test("gateArgs maps every option to its qac flag", () => {
  const args = gateArgs(
    { argv: ["qac"] },
    {
      cwd: "/wt",
      out: "/out",
      base: "abc",
      accept: "/a.json",
      owned: "/o.json",
      spec: "/s.md",
      specSha: "sha",
      baseline: "/b/gate.json",
      loop: "k",
      attempt: 2,
      keep: true,
      excludeFindings: [{ fingerprint: "f1", file: "src/a.mjs" }, { fingerprint: "f1", file: "src/b.mjs" }],
    },
  );
  assert.deepEqual(args, [
    "qac", "gate", "--cwd", "/wt", "--out", "/out",
    "--base", "abc", "--accept", "/a.json", "--owned", "/o.json", "--spec", "/s.md", "--spec-sha", "sha",
    "--baseline", "/b/gate.json", "--loop", "k",
    "--exclude-finding", "f1=src/a.mjs", "--exclude-finding", "f1=src/b.mjs", "--attempt", "2", "--keep",
  ]);
});

test("runGate runs qac gate and reads gate.json from out", () => {
  const out = tmp();
  fs.writeFileSync(path.join(out, "gate.json"), JSON.stringify({ schema: 1, verdict: "findings", findings: [{ id: "qac#1" }] }));
  const calls = [];
  const deps = {
    env: { PATH: BIN },
    exists: (file) => file === QAC,
    exec: (argv, options) => {
      calls.push({ argv, cwd: options.cwd });
      return { status: QAC_EXIT.findings, stdout: "", stderr: "" };
    },
  };
  const run = runGate({ cwd: "/wt", out, base: "HEAD", loop: "k", attempt: 1 }, deps);
  assert.equal(run.exit, 1);
  assert.equal(run.gate.verdict, "findings");
  assert.deepEqual(calls[0].argv.slice(0, 4), [QAC, "gate", "--cwd", "/wt"]);
  assert.equal(calls[0].cwd, "/wt");
});

test("runGate sets no timeout of its own so qac judges are never killed mid-run, and passes an explicit one through", () => {
  const out = tmp();
  fs.writeFileSync(path.join(out, "gate.json"), JSON.stringify({ schema: 1, verdict: "clean" }));
  const seen = [];
  const deps = {
    env: { PATH: BIN },
    exists: (file) => file === QAC,
    exec: (argv, options) => {
      seen.push(options);
      return { status: 0, stdout: "", stderr: "" };
    },
  };
  runGate({ cwd: "/wt", out }, deps);
  runGate({ cwd: "/wt", out, timeoutMs: 5000 }, deps);
  assert.equal("timeoutMs" in seen[0], false);
  assert.equal(seen[1].timeoutMs, 5000);
});

test("runGate reports a missing gate.json as null and a spawn failure as exit -1", () => {
  const out = tmp();
  const deps = {
    env: { PATH: BIN },
    exists: (file) => file === QAC,
    exec: () => ({ status: null, stdout: "", stderr: "", error: "ENOENT" }),
  };
  const run = runGate({ cwd: "/wt", out }, deps);
  assert.equal(run.exit, -1);
  assert.equal(run.gate, null);
  assert.equal(run.error, "ENOENT");
});

test("runGate throws an infra error without qac and a usage error without out", () => {
  const none = { env: { PATH: "", HOME: "/h" }, exists: () => false, readdir: () => [] };
  assert.throws(() => runGate({ cwd: "/wt", out: "/o" }, none), (error) => error instanceof LoopError && error.exit === EXIT.infra);
  assert.throws(() => runGate({ cwd: "/wt" }, none), (error) => error instanceof LoopError && error.exit === EXIT.usage);
});

test("gateFailure names the reason a gate could not judge", () => {
  assert.equal(gateFailure({ exit: 5, gate: { verdict: "could_not_judge", reason: "no judges: run qac init" }, stderr: "" }), "no judges: run qac init");
  assert.equal(gateFailure({ exit: 2, gate: null, stderr: "bad flag\n" }), "bad flag");
  assert.equal(gateFailure({ exit: -1, gate: null, stderr: "" }), "qac gate exited -1");
  assert.match(gateFailure({ exit: 1, gate: null, stderr: "" }), /without writing gate.json/);
  assert.equal(gateFailure({ exit: 1, gate: { verdict: "findings" }, stderr: "" }), null);
  assert.equal(gateFailure({ exit: 6, gate: { verdict: "flaky_only" }, stderr: "" }), null);
});

test("qacTrust maps exit 0 to trusted and lists untrusted argv from stdout", () => {
  const base = { env: { PATH: BIN }, exists: (file) => file === QAC };
  const trusted = qacTrust({ cwd: "/r", accept: "/a.json" }, { ...base, exec: () => ({ status: 0, stdout: "", stderr: "" }) });
  assert.equal(trusted.trusted, true);
  const untrusted = qacTrust(
    { cwd: "/r", accept: "/a.json" },
    { ...base, exec: () => ({ status: 1, stdout: JSON.stringify({ untrusted: [{ id: "unit", argv: ["make", "test"] }] }), stderr: "" }) },
  );
  assert.equal(untrusted.trusted, false);
  assert.deepEqual(untrusted.untrusted, [{ id: "unit", argv: ["make", "test"] }]);
  const plain = qacTrust({ cwd: "/r" }, { ...base, exec: () => ({ status: 1, stdout: "not json", stderr: "x" }) });
  assert.equal(plain.untrusted, null);
});

test("fetchTraps returns the traps array and an empty list on any failure", () => {
  const base = { env: { PATH: BIN }, exists: (file) => file === QAC };
  const traps = [{ fingerprint: "f", judge: "j", rule: "r", message: "m", loops: ["a", "b"] }];
  assert.deepEqual(fetchTraps("/r", { ...base, exec: () => ({ status: 0, stdout: JSON.stringify({ traps }), stderr: "" }) }), traps);
  assert.deepEqual(fetchTraps("/r", { ...base, exec: () => ({ status: 3, stdout: "", stderr: "" }) }), []);
  assert.deepEqual(fetchTraps("/r", { ...base, exec: () => ({ status: 0, stdout: "nope", stderr: "" }) }), []);
  assert.deepEqual(fetchTraps("/r", { env: { PATH: "" }, exists: () => false, readdir: () => [] }), []);
});

test("gateArgs no longer knows the fingerprint-only exclusion", () => {
  const args = gateArgs({ argv: ["qac"] }, { cwd: "/wt", out: "/out", excludeFingerprints: ["f1"] });
  assert.equal(args.includes("--exclude-fingerprint"), false);
  assert.equal(args.includes("f1"), false);
});

function treeRecorder(trees) {
  const calls = [];
  return {
    calls,
    deps: {
      env: { PATH: "" },
      mkdtemp: (prefix) => `${prefix}fixed`,
      rmdir: (dir) => calls.push({ removed: dir }),
      exec: (argv, options) => {
        calls.push({ argv, cwd: options.cwd, index: options.env.GIT_INDEX_FILE });
        if (argv[1] === "write-tree") return { status: 0, stdout: `${trees.shift()}\n`, stderr: "" };
        return { status: 0, stdout: "", stderr: "" };
      },
    },
  };
}

test("worktreeTree builds the tree the way qac does: read-tree HEAD, add -A and write-tree on a throwaway index", () => {
  const rec = treeRecorder(["tree1"]);
  assert.equal(worktreeTree("/wt", rec.deps), "tree1");
  const git = rec.calls.filter((call) => call.argv);
  assert.deepEqual(git.map((call) => call.argv), [["git", "read-tree", "HEAD"], ["git", "add", "-A"], ["git", "write-tree"]]);
  assert.ok(git.every((call) => call.cwd === "/wt" && call.index === git[0].index));
  assert.equal(path.basename(git[0].index), "index");
  assert.equal(rec.calls.at(-1).removed, path.dirname(git[0].index));
});

test("worktreeTree removes its index and throws when git fails", () => {
  const calls = [];
  const deps = {
    env: {},
    mkdtemp: (prefix) => `${prefix}x`,
    rmdir: (dir) => calls.push(dir),
    exec: (argv) => (argv[1] === "add" ? { status: 128, stdout: "", stderr: "fatal: nope" } : { status: 0, stdout: "", stderr: "" }),
  };
  assert.throws(() => worktreeTree("/wt", deps), /git add failed in \/wt: fatal: nope/);
  assert.equal(calls.length, 1);
});

test("gateStale accepts only a gate for this loop, attempt and base whose tree equals the worktree", () => {
  const gate = { loop: "k1", attempt: 2, base: "b0", tree: "t1" };
  const expected = { loop: "k1", attempt: 2, base: "b0", cwd: "/wt" };
  const fresh = (tree) => ({ worktreeTree: () => tree });
  assert.equal(gateStale(gate, expected, fresh("t1")), null);
  assert.equal(gateStale({ ...gate, attempt: "2" }, expected, fresh("t1")), null);
  assert.match(gateStale(gate, expected, fresh("t2")), /changed since the gate judged it \(tree t1 then, t2 now\)/);
  assert.match(gateStale({ ...gate, loop: "k2" }, expected, fresh("t1")), /loop is "k2", not "k1"/);
  assert.match(gateStale({ ...gate, attempt: 3 }, expected, fresh("t1")), /attempt is 3, not 2/);
  assert.match(gateStale({ ...gate, base: "b9" }, expected, fresh("t1")), /base is "b9", not "b0"/);
  assert.match(gateStale({ loop: "k1", attempt: 2, base: "b0" }, expected, fresh("t1")), /records no tree/);
  assert.match(gateStale(null, expected, fresh("t1")), /loop is null/);
  let asked = 0;
  gateStale({ ...gate, loop: "k2" }, expected, { worktreeTree: () => { asked += 1; return "t1"; } });
  assert.equal(asked, 0);
});
