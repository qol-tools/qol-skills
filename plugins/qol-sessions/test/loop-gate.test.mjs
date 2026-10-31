import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { QAC_EXIT, fetchTraps, gateArgs, gateFailure, qacTrust, resolveQac, runGate } from "../src/loop/gate.mjs";
import { EXIT, LoopError } from "../src/loop/paths.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loop-gate-"));
}

test("resolveQac prefers qac on PATH", () => {
  const found = resolveQac({ env: { PATH: "/a:/b" }, exists: (file) => file === "/b/qac" });
  assert.deepEqual(found, { argv: ["/b/qac"], source: "path" });
});

test("resolveQac falls back to the newest cached qol-project script", () => {
  const cache = "/home/u/.claude/plugins/cache";
  const older = `${cache}/m/qol-project/0.9.0/scripts/qac.mjs`;
  const newer = `${cache}/m/qol-project/1.0.0/scripts/qac.mjs`;
  const tree = { [cache]: ["m"], [`${cache}/m/qol-project`]: ["0.9.0", "1.0.0"] };
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
      excludeFingerprints: ["f1", "f2"],
    },
  );
  assert.deepEqual(args, [
    "qac", "gate", "--cwd", "/wt", "--out", "/out",
    "--base", "abc", "--accept", "/a.json", "--owned", "/o.json", "--spec", "/s.md", "--spec-sha", "sha",
    "--baseline", "/b/gate.json", "--loop", "k",
    "--exclude-fingerprint", "f1", "--exclude-fingerprint", "f2", "--attempt", "2", "--keep",
  ]);
});

test("runGate runs qac gate and reads gate.json from out", () => {
  const out = tmp();
  fs.writeFileSync(path.join(out, "gate.json"), JSON.stringify({ schema: 1, verdict: "findings", findings: [{ id: "qac#1" }] }));
  const calls = [];
  const deps = {
    env: { PATH: "/bin" },
    exists: (file) => file === "/bin/qac",
    exec: (argv, options) => {
      calls.push({ argv, cwd: options.cwd });
      return { status: QAC_EXIT.findings, stdout: "", stderr: "" };
    },
  };
  const run = runGate({ cwd: "/wt", out, base: "HEAD", loop: "k", attempt: 1 }, deps);
  assert.equal(run.exit, 1);
  assert.equal(run.gate.verdict, "findings");
  assert.deepEqual(calls[0].argv.slice(0, 4), ["/bin/qac", "gate", "--cwd", "/wt"]);
  assert.equal(calls[0].cwd, "/wt");
});

test("runGate sets no timeout of its own so qac judges are never killed mid-run, and passes an explicit one through", () => {
  const out = tmp();
  fs.writeFileSync(path.join(out, "gate.json"), JSON.stringify({ schema: 1, verdict: "clean" }));
  const seen = [];
  const deps = {
    env: { PATH: "/bin" },
    exists: (file) => file === "/bin/qac",
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
    env: { PATH: "/bin" },
    exists: (file) => file === "/bin/qac",
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
  const base = { env: { PATH: "/bin" }, exists: (file) => file === "/bin/qac" };
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
  const base = { env: { PATH: "/bin" }, exists: (file) => file === "/bin/qac" };
  const traps = [{ fingerprint: "f", judge: "j", rule: "r", message: "m", loops: ["a", "b"] }];
  assert.deepEqual(fetchTraps("/r", { ...base, exec: () => ({ status: 0, stdout: JSON.stringify({ traps }), stderr: "" }) }), traps);
  assert.deepEqual(fetchTraps("/r", { ...base, exec: () => ({ status: 3, stdout: "", stderr: "" }) }), []);
  assert.deepEqual(fetchTraps("/r", { ...base, exec: () => ({ status: 0, stdout: "nope", stderr: "" }) }), []);
  assert.deepEqual(fetchTraps("/r", { env: { PATH: "" }, exists: () => false, readdir: () => [] }), []);
});
