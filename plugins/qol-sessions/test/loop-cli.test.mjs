import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { EXIT, helpText, main, parseArgs, renderPretty } from "../scripts/loop.mjs";
import { LoopError } from "../src/loop/paths.mjs";

const QOLS = fileURLToPath(new URL("../bin/qols", import.meta.url));

function emptyRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-cli-"));
  const common = path.join(root, ".git");
  return { root, loop: { exec: () => ({ status: 0, stdout: `${common}\n`, stderr: "" }) } };
}

test("EXIT exposes the contract codes", () => {
  assert.deepEqual({ ...EXIT }, { ok: 0, usage: 2, infra: 10, needsTrust: 11, escalation: 12, question: 13, handover: 14 });
});

test("parseArgs reads positionals, string flags, equals form and booleans", () => {
  const parsed = parseArgs(["open", "k1", "--spec", "s.md", "--base=abc", "--pretty"]);
  assert.equal(parsed.verb, "open");
  assert.deepEqual(parsed.positionals, ["k1"]);
  assert.deepEqual(parsed.flags, { spec: "s.md", base: "abc" });
  assert.equal(parsed.pretty, true);
  assert.deepEqual(parsed.errors, []);
  const run = parseArgs(["run", "k1", "--gate-only", "--surface", "handover", "--answer", "yes"]);
  assert.deepEqual(run.flags, { "gate-only": true, surface: "handover", answer: "yes" });
  assert.equal(parseArgs(["--pretty", "status"]).pretty, true);
  assert.equal(parseArgs(["doctor", "--prune"]).flags.prune, true);
  assert.equal(parseArgs(["retro", "--normalize"]).flags.normalize, true);
});

test("parseArgs reports usage problems", () => {
  const cases = [
    [["frobnicate"], /unknown verb frobnicate/],
    [["open", "k1", "--spec"], /--spec needs a value/],
    [["open", "k1", "--nope", "x"], /unknown flag --nope for open/],
    [["open"], /exactly 1 key/],
    [["status", "a", "b"], /at most 1 key/],
    [["doctor", "extra"], /takes no positional arguments/],
  ];
  for (const [argv, pattern] of cases) {
    const parsed = parseArgs(argv);
    assert.ok(parsed.errors.some((error) => pattern.test(error)), `${argv.join(" ")} -> ${parsed.errors}`);
  }
  assert.deepEqual(parseArgs(["status"]).errors, []);
  assert.deepEqual(parseArgs(["status", "k1"]).errors, []);
});

test("help lists every verb, the shared flags and every exit code", () => {
  const text = helpText();
  for (const verb of ["open", "run", "verdict", "close", "status", "doctor", "retro"]) assert.match(text, new RegExp(`^  ${verb} `, "m"), verb);
  for (const flag of ["--spec", "--base", "--cwd", "--answer", "--gate-only", "--surface", "--blame", "--finding", "--hunk", "--why", "--index", "--outcome", "--keep", "--remaining", "--skill-gap", "--all", "--prune", "--normalize", "--pretty"]) {
    assert.ok(text.includes(flag), flag);
  }
  for (const code of [0, 2, 10, 11, 12, 13, 14]) assert.match(text, new RegExp(`^  ${code} `, "m"), String(code));
});

test("no verb, an unknown verb and bad flags exit 2 with a JSON error", async () => {
  for (const argv of [[], ["frobnicate"], ["open", "k1", "--bogus"]]) {
    const result = await main(argv);
    assert.equal(result.exit, EXIT.usage, argv.join(" "));
    assert.equal(JSON.parse(result.stdout).exit, 2);
    assert.ok(JSON.parse(result.stdout).error.length > 0);
  }
  const pretty = await main(["--pretty"]);
  assert.match(pretty.stdout, /^error: missing verb/);
  assert.match(pretty.stdout, /verbs:/);
});

test("--help exits 0 with the help text", async () => {
  for (const argv of [["--help"], ["help"], ["open", "--help"]]) {
    const result = await main(argv);
    assert.equal(result.exit, 0);
    assert.equal(result.stdout, helpText());
  }
});

test("missing required flags are usage errors", async () => {
  const cases = [
    [["open", "k1"], /open needs --spec/],
    [["verdict", "k1", "--blame", "impl"], /verdict needs --finding, --hunk, --why/],
    [["close", "k1"], /close needs --outcome/],
    [["retro"], /retro needs --normalize/],
  ];
  for (const [argv, pattern] of cases) {
    const result = await main(argv, { loop: {} });
    assert.equal(result.exit, EXIT.usage, argv.join(" "));
    assert.match(JSON.parse(result.stdout).error, pattern);
  }
});

test("verdict parses --index as a string flag", () => {
  assert.deepEqual(parseArgs(["verdict", "k1", "--index", "2"]).flags, { index: "2" });
});

test("verdict --index reaches the loop as a number and a bad one is a usage error", async () => {
  const bad = await main(["verdict", "k1", "--blame", "impl", "--finding", "f#1", "--hunk", "a:1", "--why", "w", "--index", "x"], { loop: {} });
  assert.equal(bad.exit, EXIT.usage);
  assert.match(JSON.parse(bad.stdout).error, /--index must be a positive integer/);
});

test("close rejects a non-numeric --keep", async () => {
  const result = await main(["close", "k1", "--outcome", "accepted", "--keep", "x"], { loop: {} });
  assert.equal(result.exit, EXIT.usage);
  assert.match(JSON.parse(result.stdout).error, /--keep must be a positive integer/);
});

test("status prints one JSON line by default and text with --pretty", async () => {
  const repo = emptyRepo();
  const json = await main(["status", "--cwd", repo.root], { loop: repo.loop });
  assert.equal(json.exit, 0);
  assert.deepEqual(JSON.parse(json.stdout), { loops: [] });
  assert.equal(json.stdout.includes("\n"), false);
  const pretty = await main(["status", "--cwd", repo.root, "--pretty"], { loop: repo.loop });
  assert.equal(pretty.stdout, "no loops in this repository");
});

test("run dispatches to runLoop and passes its exit code and packet through", async () => {
  const seen = [];
  const runLoop = async (key, options, deps) => {
    seen.push({ key, options, deps });
    return { exit: EXIT.escalation, result: { state: "escalation", spec: "/s.md", diffs: ["/a", "/b"] } };
  };
  const loopDeps = { marker: true };
  const result = await main(["run", "k1", "--gate-only", "--surface", "handover", "--cwd", "/r"], { runLoop, loop: loopDeps });
  assert.equal(result.exit, EXIT.escalation);
  assert.deepEqual(JSON.parse(result.stdout), { state: "escalation", spec: "/s.md", diffs: ["/a", "/b"] });
  assert.deepEqual(seen, [{ key: "k1", options: { cwd: "/r", answer: undefined, index: undefined, gateOnly: true, surface: "handover" }, deps: loopDeps }]);
});

test("run exits 0 when runLoop returns no exit code", async () => {
  const result = await main(["run", "k1"], { runLoop: async () => ({ result: { green: true } }) });
  assert.equal(result.exit, 0);
  assert.deepEqual(JSON.parse(result.stdout), { green: true });
});

test("typed errors keep their exit code and other crashes exit 10", async () => {
  const typed = await main(["run", "k1"], {
    runLoop: async () => {
      throw new LoopError("gate could not judge", EXIT.infra);
    },
  });
  assert.equal(typed.exit, EXIT.infra);
  assert.deepEqual(JSON.parse(typed.stdout), { error: "gate could not judge", exit: 10 });
  const crash = await main(["run", "k1"], {
    runLoop: async () => {
      throw new Error("boom");
    },
  });
  assert.equal(crash.exit, EXIT.infra);
  assert.equal(JSON.parse(crash.stdout).error, "boom");
  const pretty = await main(["run", "k1", "--pretty"], {
    runLoop: async () => {
      throw new LoopError("nope", EXIT.usage);
    },
  });
  assert.equal(pretty.exit, EXIT.usage);
  assert.equal(pretty.stdout, "error: nope");
});

test("retro --normalize runs against the configured ledger", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-cli-retro-"));
  const result = await main(["retro", "--normalize"], { loop: { env: { QOL_SESSIONS_RETRO: path.join(root, "r.jsonl") } } });
  assert.equal(result.exit, 0);
  assert.equal(JSON.parse(result.stdout).reason, "no retro file");
});

test("pretty rendering of the typed results", () => {
  const trust = renderPretty("open", { needs_trust: true, untrusted: [{ id: "unit", argv: ["make", "test"] }], approve: "qac trust approve --cwd /r --accept /a.json" });
  assert.equal(
    trust,
    "accept commands need approval before the loop can arm:\n  unit: make test\nthe user approves by typing (an agent never runs it): qac trust approve --cwd /r --accept /a.json",
  );
  const armed = renderPretty("open", {
    key: "k1",
    base: "a".repeat(40),
    surface: "headless",
    control: true,
    worktrees: [{ index: 1, path: "/w/loop-k1/main", branch: "loop-k1" }],
    baseline: { verdict: "clean", findings: 0 },
  });
  assert.equal(
    armed,
    `loop k1 armed on ${"a".repeat(12)} via headless (opus control on)\n  worktree 1: /w/loop-k1/main (loop-k1)\nbaseline gate: clean, 0 findings`,
  );
  const closed = renderPretty("close", {
    loop_closed: true,
    final_report: { outcome: "accepted", key: "k1", attempts: 2, gate: { verdict: "clean" }, remaining: "None.", worktree: "/w" },
    lane_closes: [{ session: "s", exit: 0, error: null }],
    removed: [{ path: "/x", branch: "b" }],
    retro: { file: "/r" },
  });
  assert.equal(
    closed,
    "loop k1 closed accepted: 2 attempts, gate clean\nkept worktree /w\n  lane s loop-close exit 0\n  removed /x\nremaining: None.",
  );
  const verdict = renderPretty("verdict", {
    verdict: { blame: "impl", finding: "f#1", hunk: "a.js:2", attempt: 1 },
    next: "qols loop run k1",
  });
  assert.equal(verdict, "verdict recorded: impl on f#1 at a.js:2 (attempt 1)\nnext: qols loop run k1");
  const doctor = renderPretty("doctor", {
    ok: false,
    checks: [
      { check: "node", status: "pass", detail: "node 22" },
      { check: "qac", status: "fail", detail: "missing", fix: "install it" },
    ],
  });
  assert.equal(doctor, "ok   node: node 22\nFAIL qac: missing\n     fix: install it\ndoctor: some checks fail");
});

test("qols forwards loop verbs to scripts/loop.mjs and refuses typed verbs", () => {
  const typed = spawnSync(process.execPath, [QOLS, "fork", "do it"], { encoding: "utf8" });
  assert.equal(typed.status, 2);
  assert.match(typed.stderr, /"fork" is a typed verb/);
  const bare = spawnSync(process.execPath, [QOLS], { encoding: "utf8" });
  assert.equal(bare.status, 2);
  assert.match(bare.stderr, /usage: qols loop/);
  const help = spawnSync(process.execPath, [QOLS, "loop", "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /^verbs:$/m);
  const unknown = spawnSync(process.execPath, [QOLS, "loop", "frobnicate"], { encoding: "utf8" });
  assert.equal(unknown.status, 2);
  assert.equal(JSON.parse(unknown.stdout).exit, 2);
});

test("run prints the packet flat: a real usage error carries top-level error and exit, never a nested result", async () => {
  const repo = emptyRepo();
  const result = await main(["run", "k1", "--cwd", repo.root], { loop: repo.loop });
  assert.equal(result.exit, EXIT.usage);
  const body = JSON.parse(result.stdout);
  assert.equal(body.exit, 2);
  assert.equal(body.state, "usage");
  assert.match(body.error, /no loop k1/);
  assert.equal("result" in body, false);
});

test("run --index reaches the loop as a number and a bad one is a usage error", async () => {
  const seen = [];
  const runLoop = async (key, options) => {
    seen.push(options);
    return { exit: 0, result: { state: "green" } };
  };
  await main(["run", "k1", "--answer", "yes", "--index", "2"], { runLoop, loop: {} });
  assert.equal(seen[0].index, 2);
  assert.equal(seen[0].answer, "yes");
  const bad = await main(["run", "k1", "--answer", "yes", "--index", "x"], { runLoop, loop: {} });
  assert.equal(bad.exit, EXIT.usage);
  assert.match(JSON.parse(bad.stdout).error, /--index must be a positive integer/);
  assert.equal(seen.length, 1);
});

test("--surface is validated as a usage error before any verb runs", async () => {
  let called = false;
  for (const surface of ["tmux", "", "Kitty"]) {
    const result = await main(["run", "k1", "--surface", surface], { runLoop: async () => { called = true; return { exit: 0, result: {} }; }, loop: {} });
    assert.equal(result.exit, EXIT.usage, surface);
    assert.match(JSON.parse(result.stdout).error, /--surface must be one of kitty, headless, handover/);
  }
  assert.equal(called, false);
  for (const surface of ["kitty", "headless", "handover"]) assert.deepEqual(parseArgs(["run", "k1", "--surface", surface]).errors, []);
});

test("close passes --skill-gap through and status passes --all", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "loop-cli-close-"));
  const refused = await main(["close", "nope", "--outcome", "paused", "--skill-gap", "  "], { loop: { exec: () => ({ status: 0, stdout: `${path.join(root, ".git")}\n`, stderr: "" }) } });
  assert.equal(refused.exit, EXIT.usage);
  assert.match(JSON.parse(refused.stdout).error, /--skill-gap needs text/);
  assert.deepEqual(parseArgs(["close", "k1", "--outcome", "accepted", "--skill-gap", "gap"]).flags, { outcome: "accepted", "skill-gap": "gap" });
  assert.equal(parseArgs(["status", "--all"]).flags.all, true);
});

test("run --pretty renders the state, the slots, the packet paths and the next command", () => {
  const text = renderPretty("run", {
    key: "k1",
    state: "escalation",
    slots: [{ index: 1, state: "red", attempt: 2, verdict: "findings", worktree: "/w" }],
    spec: "/s.md",
    diffs: ["/d1", "/d2"],
    gates: ["/g1"],
    ambiguous: true,
    reasons: ["implementer 1 vs 2: gate verdicts differ (clean vs findings)"],
    next: "qols loop verdict k1",
  });
  assert.equal(
    text,
    [
      "loop k1: escalation",
      "  implementer 1: red (attempt 2, gate findings) /w",
      "  ambiguous: implementer 1 vs 2: gate verdicts differ (clean vs findings)",
      "spec: /s.md",
      "  diff: /d1",
      "  diff: /d2",
      "  gate: /g1",
      "next: qols loop verdict k1",
    ].join("\n"),
  );
  assert.equal(renderPretty("run", { key: "k1", state: "question", attempt: 1, question: "which port?" }), "loop k1: question (attempt 1)\nquestion: which port?");
});

test("status --pretty shows the cost and open questions", () => {
  const text = renderPretty("status", {
    loop: { key: "k1", phase: "question", surface: "kitty", attempts: [], cost_usd: 0.75, outcome: null, questions: [{ slot: 2, question: "which port?" }] },
  });
  assert.equal(text, "k1  question  kitty  0 attempts  $0.75\n  open question (implementer 2): which port?");
});
