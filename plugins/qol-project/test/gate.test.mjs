import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { judgesSha, normalizeConfig, repoId as repoIdOf, sha256 } from "../src/gate/config.mjs";
import { normalizeMessage } from "../src/gate/fingerprint.mjs";
import { readGates } from "../src/gate/index.mjs";
import { GATE_EXIT, acceptJudges, readAccept, renderGate, runGate } from "../src/gate/gate.mjs";
import { approveTrust } from "../src/gate/trust.mjs";

const CONFIG = {
  version: 1,
  accept_prefixes: [["node", "--test"]],
  judges: [
    { id: "fmt", argv: ["cargo", "fmt", "--check"] },
    { id: "unit", argv: ["node", "--test"], kind: "test" },
  ],
  retention: { loops: 5 },
};
const ONE = { ...CONFIG, judges: [CONFIG.judges[0]] };
const COMMON = "/repo/.git";
const GATE_FILE = `${COMMON}/qac/last-gate/gate.json`;

const ok = (stdout = "") => ({ exit: 0, stdout, stderr: "", ms: 10, error: null });
const bad = (stdout = "", exit = 1) => ({ exit, stdout, stderr: "", ms: 10, error: null });

function harness({ config = CONFIG, changed = ["src/a.mjs"], results = [], tamper = [], setup = { ran: false, ok: true, marker: null, error: null }, files = {}, trusted = true, approveAccept = [], lint = () => ({ findings: [] }) } = {}) {
  const store = new Map(Object.entries(files));
  const appended = [];
  const spawned = [];
  const removed = [];
  const tamperCalls = [];
  const queue = [...results];
  const deps = {
    exec: (command, args) => {
      const key = args.join(" ");
      if (key.startsWith("remote get-url")) return "git@github.com:o/r.git\n";
      if (key.startsWith("show ")) {
        if (config === null) throw new Error("missing");
        return typeof config === "string" ? config : JSON.stringify(config);
      }
      throw new Error(`unexpected git ${key}`);
    },
    read: file => {
      if (!store.has(file)) throw new Error(`ENOENT ${file}`);
      return store.get(file);
    },
    write: (file, text) => store.set(file, text),
    rm: target => removed.push(target),
    env: { XDG_STATE_HOME: "/state", XDG_CONFIG_HOME: "/cfg" },
    now: () => "2026-10-31T00:00:00.000Z",
    exists: () => true,
    lint,
    spawn: async argv => {
      spawned.push(argv);
      return queue.shift() ?? ok();
    },
    tree: {
      gitCommonDir: () => COMMON,
      changedFiles: () => changed,
      treeId: () => "tree1",
    },
    fingerprint: { fingerprint: (judge, rule, message) => `${judge}:${rule}:${message}` },
    tamper: {
      tamperChecks: async input => {
        tamperCalls.push(input);
        return tamper;
      },
    },
    setup: { ensureSetup: async () => setup },
    index: { appendGate: (dir, line, options) => appended.push({ dir, line, options }) },
  };
  if (trusted && config !== null && typeof config !== "string") {
    approveTrust({ config: normalizeConfig(config), accept: approveAccept, repoId: repoIdOf("/w", deps) }, deps);
  }
  return { deps, store, appended, spawned, removed, tamperCalls, run: (options = {}) => runGate({ cwd: "/w", ...options }, deps) };
}

test("GATE_EXIT carries the documented codes", () => {
  assert.deepEqual(GATE_EXIT, { clean: 0, findings: 1, usage: 2, notRepo: 3, couldNotJudge: 5, flakyOnly: 6 });
});

test("a clean gate writes gate.json, the judge logs and one index line", async () => {
  const h = harness({ results: [ok("fmt ok"), ok("tests ok")] });
  const result = await h.run();
  assert.equal(result.exit, 0);
  const gate = result.gate;
  assert.equal(gate.schema, 1);
  assert.equal(gate.verdict, "clean");
  assert.equal(gate.reason, null);
  assert.equal(gate.repo_id, repoIdOf("/w", h.deps));
  assert.equal(gate.base, "HEAD");
  assert.equal(gate.tree, "tree1");
  assert.equal(gate.judges_sha, judgesSha(CONFIG));
  assert.deepEqual([gate.spec_sha, gate.loop, gate.attempt], [null, null, null]);
  assert.deepEqual(gate.changed, ["src/a.mjs"]);
  assert.deepEqual(gate.judges[0], {
    id: "fmt", argv: ["cargo", "fmt", "--check"], cwd: "/w", exit: 0, duration_ms: 10, scope: "repo", kind: "lint", where: "local", status: "pass", runs: 1, findings: 0,
  });
  assert.equal(gate.judges[1].kind, "test");
  assert.deepEqual([gate.findings, gate.tamper, gate.omitted], [[], [], []]);
  assert.equal(result.path, GATE_FILE);
  assert.equal(h.store.get(GATE_FILE), `${JSON.stringify(gate, null, 2)}\n`);
  assert.equal(h.store.get(`${COMMON}/qac/last-gate/logs/fmt.log`), "fmt ok");
  assert.equal(h.appended.length, 1);
  assert.equal(h.appended[0].dir, COMMON);
  assert.equal(h.appended[0].options.retentionLoops, 5);
  assert.deepEqual(h.appended[0].line, {
    at: "2026-10-31T00:00:00.000Z",
    repo_id: gate.repo_id,
    loop: null,
    attempt: null,
    tree: "tree1",
    judges_sha: gate.judges_sha,
    verdict: "clean",
    findings: [],
  });
});

test("a failing judge makes findings with ids, fingerprints and the index status caught", async () => {
  const h = harness({ config: ONE, results: [bad("diff in a.rs")] });
  const result = await h.run({ loop: "k1", attempt: 1 });
  assert.equal(result.exit, 1);
  assert.equal(result.gate.verdict, "findings");
  assert.deepEqual(result.gate.findings, [{
    id: "fmt#1",
    judge: "fmt",
    rule: "exit",
    file: null,
    line: null,
    message: "exited 1\ndiff in a.rs",
    fingerprint: "fmt:exit:exited 1\ndiff in a.rs",
    baseline: false,
    promotable: false,
    output_sha: sha256(normalizeMessage("diff in a.rs")),
  }]);
  assert.equal(result.gate.judges[0].status, "fail");
  assert.equal(result.gate.judges[0].findings, 1);
  assert.deepEqual(h.appended[0].line.findings, [{ fingerprint: "fmt:exit:exited 1\ndiff in a.rs", judge: "fmt", rule: "exit", message: "exited 1\ndiff in a.rs", status: "caught" }]);
  assert.deepEqual([h.appended[0].line.loop, h.appended[0].line.attempt], ["k1", 1]);
});

test("findings from structured parsers and the qac builtin are promotable", async () => {
  const diagnostic = JSON.stringify({ reason: "compiler-message", message: { level: "error", code: { code: "E1" }, message: "bad", spans: [{ file_name: "src/a.rs", line_start: 2, is_primary: true }] } });
  const config = {
    version: 1,
    judges: [
      { id: "qac", builtin: "qac-lint", scope: "repo" },
      { id: "clippy", argv: ["cargo", "clippy"], parser: "cargo-json" },
    ],
  };
  const lint = () => ({ findings: [{ hook: "h", rule: "R", summary: "R: detail", lines: [1], file: "a.rs" }] });
  const h = harness({ config, lint, results: [bad(diagnostic, 101)] });
  const { gate } = await h.run();
  assert.deepEqual(gate.findings.map(finding => [finding.id, finding.promotable]), [["qac#1", true], ["clippy#1", true]]);
  assert.equal(gate.findings[1].file, "src/a.rs");
  assert.equal(gate.findings[1].line, 2);
});

test("a baseline gate turns its findings into baseline findings that do not block", async () => {
  const baseline = JSON.stringify({ findings: [{ fingerprint: "fmt:exit:exited 1\ndiff in a.rs", output_sha: sha256(normalizeMessage("diff in a.rs")) }] });
  const h = harness({ config: ONE, results: [bad("diff in a.rs")], files: { "/w/base.json": baseline } });
  const result = await h.run({ baseline: "base.json" });
  assert.equal(result.exit, 0);
  assert.equal(result.gate.verdict, "clean");
  assert.equal(result.gate.findings[0].baseline, true);
  assert.equal(h.appended[0].line.findings[0].status, "baseline");
});

test("a new failure behind the same fingerprint is not masked by a baseline with another output", async () => {
  const tailed = text => [text, ...Array.from({ length: 20 }, () => "zzz old fails")].join("\n");
  const baseOutput = tailed("zzz old fails");
  const newOutput = tailed("aaa NEW break");
  const first = harness({ config: ONE, results: [bad(baseOutput)] });
  delete first.deps.fingerprint;
  const base = (await first.run()).gate;
  const second = harness({ config: ONE, results: [bad(newOutput)], files: { "/w/base.json": JSON.stringify(base) } });
  delete second.deps.fingerprint;
  const masked = await second.run({ baseline: "base.json" });
  assert.equal(masked.gate.findings[0].fingerprint, base.findings[0].fingerprint);
  assert.notEqual(masked.gate.findings[0].output_sha, base.findings[0].output_sha);
  assert.equal(masked.gate.findings[0].baseline, false);
  assert.equal(masked.gate.verdict, "findings");
  assert.equal(masked.exit, 1);

  const same = harness({ config: ONE, results: [bad(baseOutput)], files: { "/w/base.json": JSON.stringify(base) } });
  delete same.deps.fingerprint;
  const unchanged = await same.run({ baseline: "base.json" });
  assert.equal(unchanged.gate.findings[0].baseline, true);
  assert.equal(unchanged.gate.verdict, "clean");
});

test("a baseline written before output_sha existed never masks an exit-code finding", async () => {
  const baseline = JSON.stringify({ findings: [{ fingerprint: "fmt:exit:exited 1\ndiff in a.rs" }] });
  const h = harness({ config: ONE, results: [bad("diff in a.rs")], files: { "/w/base.json": baseline } });
  const result = await h.run({ baseline: "base.json" });
  assert.equal(result.gate.findings[0].baseline, false);
  assert.equal(result.gate.verdict, "findings");
});

test("config retention reaches the index so only that many loops are kept", async () => {
  const common = mkdtempSync(path.join(tmpdir(), "qac-retention-"));
  const config = { ...ONE, retention: { loops: 2 } };
  for (const loop of ["k1", "k2", "k3"]) {
    const h = harness({ config, results: [ok()] });
    delete h.deps.index;
    h.deps.tree = { ...h.deps.tree, gitCommonDir: () => common };
    h.deps.read = file => (h.store.has(file) ? h.store.get(file) : readFileSync(file, "utf8"));
    const result = await h.run({ loop, attempt: 1 });
    assert.equal(result.indexError, null);
  }
  const kept = new Set(readGates(common).map(line => line.loop));
  assert.deepEqual([...kept].sort(), ["k2", "k3"]);
});

test("an excluded fingerprint is dropped from the findings and the index", async () => {
  const h = harness({ config: ONE, results: [bad("diff in a.rs")] });
  const result = await h.run({ excludeFingerprints: ["fmt:exit:exited 1\ndiff in a.rs"] });
  assert.equal(result.exit, 0);
  assert.deepEqual(result.gate.findings, []);
  assert.equal(result.gate.judges[0].status, "fail");
  assert.equal(result.gate.judges[0].findings, 0);
  assert.deepEqual(h.appended[0].line.findings, []);
});

test("a test judge that passes on a rerun is flaky: no findings, flaky_only, exit 6", async () => {
  const h = harness({ results: [ok(), bad("race"), ok()] });
  const result = await h.run();
  assert.equal(result.exit, 6);
  assert.equal(result.gate.verdict, "flaky_only");
  assert.match(result.gate.reason, /flaky: unit/);
  assert.deepEqual(result.gate.findings, []);
  assert.deepEqual([result.gate.judges[1].status, result.gate.judges[1].runs], ["flaky", 2]);
  assert.deepEqual(h.appended[0].line.findings.map(finding => finding.status), ["flaky"]);
  assert.equal(h.appended[0].line.verdict, "flaky_only");
});

test("a flaky judge next to a real failure is still findings", async () => {
  const h = harness({ results: [bad("diff"), bad("race"), ok()] });
  const result = await h.run();
  assert.equal(result.exit, 1);
  assert.deepEqual(result.gate.findings.map(finding => finding.judge), ["fmt"]);
  assert.deepEqual(h.appended[0].line.findings.map(finding => finding.status), ["caught", "flaky"]);
});

test("any tamper entry makes findings even when every judge passes", async () => {
  const h = harness({ tamper: [{ kind: "suppression", file: "a.mjs", detail: "+ eslint-disable" }, { kind: "protected", file: ".qac/judges.json", detail: "changed" }] });
  const result = await h.run({ owned: undefined });
  assert.equal(result.exit, 1);
  assert.deepEqual(result.gate.tamper, [
    { id: "tamper#1", kind: "suppression", file: "a.mjs", detail: "+ eslint-disable" },
    { id: "tamper#2", kind: "protected", file: ".qac/judges.json", detail: "changed" },
  ]);
  assert.deepEqual(result.gate.findings, []);
  assert.equal(h.tamperCalls.length, 1);
  assert.deepEqual(Object.keys(h.tamperCalls[0]).sort(), ["base", "config", "cwd", "owned", "specPath", "specSha"]);
  assert.deepEqual([h.tamperCalls[0].cwd, h.tamperCalls[0].base, h.tamperCalls[0].owned, h.tamperCalls[0].specPath], ["/w", "HEAD", null, null]);
  assert.deepEqual(h.tamperCalls[0].config.protected, [".qac/**"]);
});

test("--owned and --spec reach the tamper checks and the gate records the loop tags", async () => {
  const files = { "/w/owned.json": JSON.stringify(["src/**"]) };
  const h = harness({ files });
  const result = await h.run({ owned: "owned.json", spec: "spec.md", specSha: "abc123", loop: "k", attempt: 2, base: "main" });
  assert.deepEqual(h.tamperCalls[0].owned, ["src/**"]);
  assert.equal(h.tamperCalls[0].specPath, "/w/spec.md");
  assert.equal(h.tamperCalls[0].specSha, "abc123");
  assert.equal(h.tamperCalls[0].base, "main");
  assert.deepEqual([result.gate.spec_sha, result.gate.loop, result.gate.attempt, result.gate.base], ["abc123", "k", 2, "main"]);
});

test("no config is could_not_judge with the init hint, writes gate.json and does not append to the index", async () => {
  const h = harness({ config: null });
  const result = await h.run();
  assert.equal(result.exit, 5);
  assert.equal(result.gate.verdict, "could_not_judge");
  assert.equal(result.gate.reason, "no judges: run qac init");
  assert.deepEqual(result.gate.judges, []);
  assert.equal(h.spawned.length, 0);
  assert.equal(h.appended.length, 0);
  assert.ok(h.store.has(GATE_FILE));
});

test("an invalid config is could_not_judge with the errors", async () => {
  const h = harness({ config: { version: 1, judges: [{ id: "a" }] }, trusted: false });
  const result = await h.run();
  assert.equal(result.exit, 5);
  assert.match(result.gate.reason, /^invalid judges config: .*needs exactly one of argv or builtin/);
});

test("untrusted judges stop the gate before anything runs", async () => {
  const h = harness({ trusted: false });
  const result = await h.run();
  assert.equal(result.exit, 5);
  assert.match(result.gate.reason, /^untrusted argv: judges: cargo fmt --check; judges: node --test; run qac trust approve$/);
  assert.equal(h.spawned.length, 0);
  assert.equal(h.appended.length, 0);
});

test("a failed setup is could_not_judge", async () => {
  const h = harness({ setup: { ran: true, ok: false, marker: null, error: "npm ci exited 1" } });
  const result = await h.run();
  assert.equal(result.exit, 5);
  assert.equal(result.gate.reason, "setup failed: npm ci exited 1");
  assert.equal(h.spawned.length, 0);
});

test("a judge that cannot start is could_not_judge, unless a real finding exists", async () => {
  const missing = { exit: null, stdout: "", stderr: "", ms: 0, error: "not-found" };
  const alone = harness({ config: ONE, results: [missing] });
  const first = await alone.run();
  assert.equal(first.exit, 5);
  assert.equal(first.gate.reason, "judge error: fmt");
  assert.equal(first.gate.judges[0].status, "error");
  assert.equal(alone.appended.length, 0);

  const both = harness({ results: [missing, bad("boom"), bad("boom"), bad("boom")] });
  const second = await both.run();
  assert.equal(second.exit, 1);
  assert.equal(second.gate.verdict, "findings");
});

test("a timeout is a fail with one timeout finding that cannot be promoted", async () => {
  const h = harness({ config: ONE, results: [{ exit: null, stdout: "", stderr: "", ms: 600000, error: "timeout" }] });
  const result = await h.run();
  assert.equal(result.exit, 1);
  assert.equal(result.gate.judges[0].status, "timeout");
  assert.deepEqual(result.gate.findings.map(finding => [finding.rule, finding.promotable]), [["timeout", false]]);
});

test("ci judges are omitted and listed, never run", async () => {
  const config = { version: 1, judges: [{ id: "fmt", argv: ["cargo", "fmt"] }, { id: "clippy", argv: ["cargo", "clippy"], where: "ci" }] };
  const h = harness({ config });
  const result = await h.run();
  assert.equal(result.exit, 0);
  assert.deepEqual(result.gate.omitted, ["clippy"]);
  assert.deepEqual([result.gate.judges[1].status, result.gate.judges[1].runs, result.gate.judges[1].where], ["omitted", 0, "ci"]);
  assert.equal(h.spawned.length, 1);
});

test("accept commands run as test judges named accept:<id> with unpromotable findings", async () => {
  const accept = [{ id: "unit", argv: ["node", "--test", "x.test.mjs"] }];
  const h = harness({ config: ONE, files: { "/w/acc.json": JSON.stringify(accept) }, results: [ok(), bad("not ok 1"), bad("not ok 1"), bad("not ok 1")] });
  const result = await h.run({ accept: "acc.json" });
  assert.equal(result.exit, 1);
  const entry = result.gate.judges[1];
  assert.deepEqual([entry.id, entry.kind, entry.scope, entry.runs, entry.status], ["accept:unit", "test", "repo", 3, "fail"]);
  assert.deepEqual(result.gate.findings.map(finding => [finding.id, finding.promotable]), [["accept:unit#1", false]]);
});

test("an accept command outside the prefixes needs approval first", async () => {
  const accept = [{ id: "build", argv: ["make", "check"] }];
  const files = { "/w/acc.json": JSON.stringify(accept) };
  const denied = harness({ config: ONE, files });
  const first = await denied.run({ accept: "acc.json" });
  assert.equal(first.exit, 5);
  assert.match(first.gate.reason, /accept: make check/);

  const approved = harness({ config: ONE, files, approveAccept: accept });
  const second = await approved.run({ accept: "acc.json" });
  assert.equal(second.exit, 0);
});

test("bad inputs are usage errors and a missing repository is notRepo", async () => {
  const h = harness();
  const cases = [
    [{ spec: "s.md" }, /--spec and --spec-sha go together/],
    [{ specSha: "abc" }, /--spec and --spec-sha go together/],
    [{ accept: "nope.json" }, /--accept nope\.json cannot be read/],
    [{ accept: "bad.json" }, /--accept bad\.json is not valid JSON/],
    [{ accept: "obj.json" }, /must be a JSON array of \{ id, argv \}/],
    [{ accept: "dup.json" }, /id "a" is not unique/],
    [{ accept: "noargv.json" }, /must be \{ "id"/],
    [{ owned: "owned-bad.json" }, /--owned owned-bad\.json must be a JSON array of globs/],
    [{ baseline: "base-bad.json" }, /--baseline base-bad\.json is not a gate\.json/],
  ];
  for (const [name, text] of [
    ["bad.json", "{nope"], ["obj.json", "{}"],
    ["dup.json", JSON.stringify([{ id: "a", argv: ["x"] }, { id: "a", argv: ["y"] }])],
    ["noargv.json", JSON.stringify([{ id: "a" }])],
    ["owned-bad.json", "[1]"], ["base-bad.json", "[]"],
  ]) h.store.set(`/w/${name}`, text);
  for (const [options, expected] of cases) {
    const result = await h.run(options);
    assert.equal(result.exit, 2, JSON.stringify(options));
    assert.equal(result.gate, null);
    assert.match(result.error, expected);
  }
  assert.equal(h.spawned.length, 0);

  const outside = harness();
  outside.deps.tree.gitCommonDir = () => {
    throw new Error("fatal: not a git repository");
  };
  const result = await outside.run();
  assert.equal(result.exit, 3);
  assert.match(result.error, /is not inside a git repository/);
});

test("--out redirects the files and --keep skips clearing the logs", async () => {
  const cleared = harness({ config: ONE });
  const first = await cleared.run({ out: "/tmp/out" });
  assert.equal(first.path, "/tmp/out/gate.json");
  assert.deepEqual(cleared.removed, ["/tmp/out/logs"]);

  const kept = harness({ config: ONE });
  await kept.run({ out: "/tmp/out", keep: true });
  assert.deepEqual(kept.removed, []);
});

test("an index failure never changes the verdict", async () => {
  const h = harness({ config: ONE });
  h.deps.index.appendGate = () => {
    throw new Error("lock busy");
  };
  const result = await h.run();
  assert.equal(result.exit, 0);
  assert.equal(result.indexError, "lock busy");
});

test("log files are named safely and capped", async () => {
  const accept = [{ id: "unit", argv: ["node", "--test", "x.test.mjs"] }];
  const huge = "x".repeat(300 * 1024);
  const h = harness({ config: ONE, files: { "/w/acc.json": JSON.stringify(accept) }, results: [ok(), ok(huge)] });
  await h.run({ accept: "acc.json" });
  assert.equal(h.store.get(`${COMMON}/qac/last-gate/logs/accept_unit.log`).length, 200 * 1024);
});

test("readAccept and acceptJudges shape accept commands into judges", () => {
  const read = () => JSON.stringify([{ id: "unit", argv: ["node", "--test", "a.mjs"], extra: 1 }]);
  const accept = readAccept("a.json", "/w", { read });
  assert.deepEqual(accept, [{ id: "unit", argv: ["node", "--test", "a.mjs"] }]);
  assert.deepEqual(acceptJudges(accept), [{ id: "accept:unit", argv: ["node", "--test", "a.mjs"], parser: "exit-code", kind: "test", scope: "repo", where: "local" }]);
  assert.deepEqual(readAccept(null, "/w"), []);
});

test("renderGate shows the exit code first for an exit-code finding", () => {
  const gate = {
    verdict: "findings",
    reason: null,
    judges: [],
    findings: [{ id: "unit#1", baseline: false, file: null, line: null, rule: "exit", message: "exited 1\nname: 'AssertionError'" }],
    tamper: [],
    omitted: [],
  };
  assert.equal(renderGate(gate), "qac gate: findings\n  [unit#1] exit: exited 1");
});

test("renderGate prints the verdict, judges, findings, tamper and omitted judges", () => {
  const gate = {
    verdict: "findings",
    reason: null,
    judges: [{ id: "fmt", status: "fail", runs: 3, findings: 1 }, { id: "ci", status: "omitted", runs: 0, findings: 0 }],
    findings: [{ id: "fmt#1", baseline: false, file: "a.rs", line: 4, rule: "exit", message: "diff\nmore" }],
    tamper: [{ id: "tamper#1", kind: "protected", file: ".qac/judges.json", detail: "changed" }],
    omitted: ["ci"],
  };
  assert.equal(renderGate(gate), [
    "qac gate: findings",
    "  fmt: fail, 3 runs, 1 findings",
    "  ci: omitted",
    "  [fmt#1] a.rs:4 exit: diff",
    "  [tamper#1] protected .qac/judges.json: changed",
    "  omitted (ci only): ci",
  ].join("\n"));
  assert.equal(renderGate({ ...gate, verdict: "could_not_judge", reason: "no judges: run qac init", judges: [], findings: [], tamper: [], omitted: [] }, "x"), "x gate: could_not_judge (no judges: run qac init)");
});
