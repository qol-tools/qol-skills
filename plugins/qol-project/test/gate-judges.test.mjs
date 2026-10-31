import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { defaultSpawn, runJudge } from "../src/gate/judges.mjs";

const ok = (stdout = "") => ({ exit: 0, stdout, stderr: "", ms: 10, error: null });
const bad = (stdout = "", exit = 1) => ({ exit, stdout, stderr: "", ms: 10, error: null });

function spawner(results) {
  const calls = [];
  const spawn = async (argv, options) => {
    calls.push({ argv, options });
    const next = results.shift();
    if (!next) throw new Error("unexpected run");
    return next;
  };
  return { spawn, calls };
}

const CTX = { cwd: "/w", changed: [] };

test("a passing command is a pass with one run and the default timeout", async () => {
  const run = spawner([ok("fine")]);
  const result = await runJudge({ id: "fmt", argv: ["cargo", "fmt"] }, CTX, { spawn: run.spawn });
  assert.equal(result.status, "pass");
  assert.equal(result.exit, 0);
  assert.equal(result.runs, 1);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.argv, ["cargo", "fmt"]);
  assert.equal(result.cwd, "/w");
  assert.deepEqual(run.calls[0].options, { cwd: "/w", timeoutS: 600, env: {} });
});

test("a failing exit-code judge reports the output tail once and is never rerun for lint", async () => {
  const run = spawner([bad("line1\nline2", 3)]);
  const result = await runJudge({ id: "fmt", argv: ["cargo", "fmt"], timeout_s: 120 }, CTX, { spawn: run.spawn });
  assert.equal(result.status, "fail");
  assert.equal(result.exit, 3);
  assert.equal(result.runs, 1);
  assert.deepEqual(result.findings, [{ rule: "exit", file: null, line: null, message: "exited 3\nline1\nline2" }]);
  assert.equal(run.calls.length, 1);
  assert.equal(run.calls[0].options.timeoutS, 120);
});

test("changed scope appends the changed files that still exist", async () => {
  const run = spawner([ok()]);
  const exists = file => file === path.resolve("/w", "a.rs");
  const result = await runJudge({ id: "fmt", argv: ["rustfmt", "--check"], scope: "changed" }, { cwd: "/w", changed: ["a.rs", "gone.rs"] }, { spawn: run.spawn, exists });
  assert.deepEqual(run.calls[0].argv, ["rustfmt", "--check", "a.rs"]);
  assert.deepEqual(result.argv, ["rustfmt", "--check", "a.rs"]);
});

test("changed scope with nothing to judge does not run the command", async () => {
  const run = spawner([]);
  const result = await runJudge({ id: "fmt", argv: ["rustfmt"], scope: "changed" }, { cwd: "/w", changed: ["gone.rs"] }, { spawn: run.spawn, exists: () => false });
  assert.equal(result.status, "pass");
  assert.equal(result.runs, 0);
  assert.equal(run.calls.length, 0);
});

test("a test that fails then passes is flaky and keeps the failure's findings", async () => {
  const run = spawner([bad("boom"), ok()]);
  const result = await runJudge({ id: "unit", argv: ["t"], kind: "test" }, CTX, { spawn: run.spawn });
  assert.equal(result.status, "flaky");
  assert.equal(result.runs, 2);
  assert.equal(result.exit, 0);
  assert.equal(result.duration_ms, 20);
  assert.deepEqual(result.findings.map(finding => finding.message), ["exited 1\nboom"]);
});

test("a test that keeps failing runs test_runs_on_red times in total", async () => {
  const three = spawner([bad("a"), bad("a"), bad("a"), bad("a")]);
  const first = await runJudge({ id: "unit", argv: ["t"], kind: "test" }, CTX, { spawn: three.spawn });
  assert.equal(first.status, "fail");
  assert.equal(first.runs, 3);
  assert.equal(first.duration_ms, 30);
  assert.equal(three.calls.length, 3);

  const two = spawner([bad("a"), bad("a"), bad("a")]);
  const second = await runJudge({ id: "unit", argv: ["t"], kind: "test" }, { ...CTX, defaults: { test_runs_on_red: 2, timeout_s: 600 } }, { spawn: two.spawn });
  assert.equal(second.runs, 2);

  const single = spawner([ok()]);
  assert.equal((await runJudge({ id: "unit", argv: ["t"], kind: "test" }, CTX, { spawn: single.spawn })).runs, 1);
});

test("a timeout is a fail with one timeout finding and no rerun", async () => {
  const run = spawner([{ exit: null, stdout: "", stderr: "", ms: 5000, error: "timeout" }]);
  const result = await runJudge({ id: "unit", argv: ["slow", "x"], kind: "test", timeout_s: 5 }, CTX, { spawn: run.spawn });
  assert.equal(result.status, "timeout");
  assert.equal(result.runs, 1);
  assert.deepEqual(result.findings, [{ rule: "timeout", file: null, line: null, message: "slow x exceeded 5s" }]);
  assert.equal(run.calls.length, 1);
});

test("a command that cannot start is an error, not a finding", async () => {
  const run = spawner([{ exit: null, stdout: "", stderr: "", ms: 0, error: "not-found" }]);
  const result = await runJudge({ id: "x", argv: ["nope"] }, CTX, { spawn: run.spawn });
  assert.equal(result.status, "error");
  assert.equal(result.exit, null);
  assert.deepEqual(result.findings, []);
  assert.equal(result.output, "nope: not-found");
});

test("structured parsers turn output into findings, even when the exit code was 0", async () => {
  const report = JSON.stringify([{ filePath: "/w/a.js", messages: [{ ruleId: "no-undef", severity: 2, line: 2, message: "x" }] }]);
  const failed = await runJudge({ id: "eslint", argv: ["eslint"], parser: "eslint-json" }, CTX, { spawn: spawner([bad(report)]).spawn });
  assert.deepEqual(failed.findings, [{ rule: "no-undef", file: "a.js", line: 2, message: "x" }]);
  const quiet = await runJudge({ id: "eslint", argv: ["eslint"], parser: "eslint-json" }, CTX, { spawn: spawner([ok(report)]).spawn });
  assert.equal(quiet.status, "fail");
  assert.equal(quiet.exit, 0);
  const clean = await runJudge({ id: "eslint", argv: ["eslint"], parser: "eslint-json" }, CTX, { spawn: spawner([ok("[]")]).spawn });
  assert.equal(clean.status, "pass");
});

test("a nonzero exit with nothing parsed still fails with an exit finding", async () => {
  const result = await runJudge({ id: "t", argv: ["t"], parser: "tap" }, CTX, { spawn: spawner([bad("compile error", 2)]).spawn });
  assert.equal(result.status, "fail");
  assert.deepEqual(result.findings, [{ rule: "exit", file: null, line: null, message: "exited 2\ncompile error" }]);
});

test("output the parser cannot read is an error", async () => {
  const result = await runJudge({ id: "eslint", argv: ["eslint"], parser: "eslint-json" }, CTX, { spawn: spawner([bad("Oops, crashed", 2)]).spawn });
  assert.equal(result.status, "error");
  assert.match(result.output, /eslint-json output could not be parsed/);
});

test("a report file is read instead of stdout", async () => {
  const xml = "<testsuite><testcase name=\"bad\"><failure message=\"nope\"/></testcase></testsuite>";
  const reads = [];
  const read = file => {
    reads.push(file);
    return xml;
  };
  const judge = { id: "unit", argv: ["t"], parser: "junit", report: "out/r.xml" };
  const result = await runJudge(judge, CTX, { spawn: spawner([bad("ignored")]).spawn, read });
  assert.deepEqual(reads, [path.resolve("/w", "out", "r.xml")]);
  assert.deepEqual(result.findings, [{ rule: "bad", file: null, line: null, message: "nope" }]);
});

test("a missing report is an error when the command passed and a plain failure when it failed", async () => {
  const read = () => {
    throw new Error("ENOENT");
  };
  const judge = { id: "unit", argv: ["t"], parser: "junit", report: "r.xml" };
  const passed = await runJudge(judge, CTX, { spawn: spawner([ok()]).spawn, read });
  assert.equal(passed.status, "error");
  assert.match(passed.output, /report r\.xml was not written/);
  const failed = await runJudge(judge, CTX, { spawn: spawner([bad("build broke", 101)]).spawn, read });
  assert.equal(failed.status, "fail");
  assert.deepEqual(failed.findings.map(finding => finding.rule), ["exit"]);
});

const LINT_RESULT = {
  findings: [{ hook: "qol-logging", rule: "New println!", summary: "New println! in a.rs: outside a cli module", lines: [4], file: "a.rs", message: "long" }],
};

test("the qac-lint builtin lints the changed files against the base", async () => {
  const calls = [];
  const lint = (cwd, paths, options) => {
    calls.push({ cwd, paths, options });
    return LINT_RESULT;
  };
  const result = await runJudge({ id: "qac", builtin: "qac-lint", scope: "changed" }, { cwd: "/w", changed: ["a.rs", "gone.rs"], base: "main" }, { lint, exists: file => file === path.resolve("/w", "a.rs") });
  assert.deepEqual(calls, [{ cwd: "/w", paths: ["a.rs"], options: { base: "main" } }]);
  assert.equal(result.status, "fail");
  assert.equal(result.exit, 1);
  assert.deepEqual(result.findings, [{ rule: "New println!", file: "a.rs", line: 4, message: "[qol-logging] New println! in a.rs: outside a cli module" }]);
  assert.deepEqual(result.argv, ["qac-lint"]);
  assert.match(result.output, /^a\.rs:4 /);
});

test("the qac-lint builtin with repo scope lints everything, and with no changed files it does not run", async () => {
  const seen = [];
  const lint = (cwd, paths) => {
    seen.push(paths);
    return { findings: [] };
  };
  const whole = await runJudge({ id: "qac", builtin: "qac-lint", scope: "repo" }, CTX, { lint });
  assert.equal(whole.status, "pass");
  assert.deepEqual(seen, [[]]);
  const none = await runJudge({ id: "qac", builtin: "qac-lint", scope: "changed" }, CTX, { lint });
  assert.equal(none.runs, 0);
  assert.equal(seen.length, 1);
});

test("a lint that throws is an error", async () => {
  const lint = () => {
    throw new Error("not a git repository\nmore");
  };
  const result = await runJudge({ id: "qac", builtin: "qac-lint", scope: "repo" }, CTX, { lint });
  assert.equal(result.status, "error");
  assert.equal(result.output, "qac-lint failed: not a git repository");
});

test("defaultSpawn runs a real command, kills a slow one and reports a missing one", async () => {
  const echoed = await defaultSpawn([process.execPath, "-e", "process.stdout.write('hi'); process.exit(3)"], { cwd: process.cwd(), timeoutS: 20 });
  assert.equal(echoed.exit, 3);
  assert.equal(echoed.stdout, "hi");
  assert.equal(echoed.error, null);
  const slow = await defaultSpawn([process.execPath, "-e", "setTimeout(() => {}, 30000)"], { cwd: process.cwd(), timeoutS: 0.2 });
  assert.equal(slow.error, "timeout");
  const missing = await defaultSpawn(["qac-no-such-command-xyz"], { cwd: process.cwd(), timeoutS: 5 });
  assert.equal(missing.error, "not-found");
  assert.equal(missing.exit, null);
});
