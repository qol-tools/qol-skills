import test from "node:test";
import assert from "node:assert";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parsePrompt } from "../hooks/qac-intercept.mjs";
import { renderHelp } from "../src/qac.mjs";
import {
  LANE, forkLane, laneBrief, laneKey, ledgerFile, listSlips, readSlips, recordSlip,
  renderSlip, renderSlips, rulesRepo, slugOf, statusText,
} from "../src/slips.mjs";
import { EXIT, parseArgs, run } from "../scripts/qac.mjs";

const QAC_SOURCE = path.join("plugins", "qol-project", "src", "qac.mjs");

function scratch() {
  return realpathSync.native(mkdtempSync(path.join(tmpdir(), "qac-slips-")));
}

function ledger(extra = {}) {
  const file = path.join(scratch(), "ledger", "slips.jsonl");
  let tick = 0;
  const forks = [];
  return {
    file,
    forks,
    now: () => `2026-10-20T00:00:0${tick++}.000Z`,
    exists: file => file === path.join(path.resolve("/git/qol-skills"), QAC_SOURCE),
    exec: () => "/git/qol-skills/.git\n",
    fork: (entry, repo) => {
      forks.push({ id: entry.id, repo });
      return laneKey(entry.id);
    },
    ...extra,
  };
}

function cloneAt(dir) {
  mkdirSync(path.join(dir, path.dirname(QAC_SOURCE)), { recursive: true });
  writeFileSync(path.join(dir, QAC_SOURCE), "");
  execFileSync("git", ["init", "-q"], { cwd: dir });
  return dir;
}

test("slugOf and laneKey derive one stable identity from the pattern wording", () => {
  assert.equal(slugOf("  println! in plugin SRC, outside cli/ "), "println-in-plugin-src-outside-cli");
  assert.equal(laneKey("short"), "qac-rule-short");
  assert.equal(laneKey(`${"a".repeat(39)}-tail-that-is-cut`), `qac-rule-${"a".repeat(39)}`);
});

test("ledgerFile sits beside the mistake ledger's data and moves with QAC_LEDGER_DATA", () => {
  assert.equal(ledgerFile({ QAC_LEDGER_DATA: "/d" }), path.join("/d", "slips.jsonl"));
  assert.equal(ledgerFile({ XDG_DATA_HOME: "/x" }), path.join("/x", "qac-ledger", "slips.jsonl"));
  assert.ok(ledgerFile({}).endsWith(path.join(".local", "share", "qac-ledger", "slips.jsonl")));
});

test("readSlips folds the append-only file, a later line replacing an earlier one", () => {
  const dir = scratch();
  const file = path.join(dir, "slips.jsonl");
  assert.equal(readSlips(file).size, 0);
  writeFileSync(file, `${JSON.stringify({ id: "a", seen: 1 })}\nnot json\n\n${JSON.stringify({ seen: 9 })}\n`);
  appendFileSync(file, `${JSON.stringify({ id: "a", seen: 2 })}\n`);
  assert.deepEqual([...readSlips(file).values()], [{ id: "a", seen: 2 }]);
});

test("rulesRepo finds the qol-skills clone from an explicit path, the main checkout, or its sibling", () => {
  const parent = scratch();
  const skills = cloneAt(path.join(parent, "qol-skills"));
  const monorepo = path.join(parent, "qol-monorepo");
  mkdirSync(monorepo);
  execFileSync("git", ["init", "-q"], { cwd: monorepo });
  assert.equal(rulesRepo(monorepo), skills);
  assert.equal(rulesRepo(skills), skills);
  assert.equal(rulesRepo(monorepo, { explicit: skills }), skills);
  assert.equal(rulesRepo(skills, { explicit: monorepo }), null);
  const lonely = path.join(scratch(), "repo");
  mkdirSync(lonely);
  execFileSync("git", ["init", "-q"], { cwd: lonely });
  assert.equal(rulesRepo(lonely), null);
  assert.equal(rulesRepo(scratch()), null);
});

test("laneBrief names the pattern, its sources, and the two commands that settle the entry", () => {
  const entry = { pattern: "dbg! in tests", first_seen: "2026-10-20", sources: ["https://x/pull/1"] };
  const brief = laneBrief(entry, "/c/qac.mjs");
  assert.match(brief, /"dbg! in tests" slipped past qac/);
  assert.match(brief, /from https:\/\/x\/pull\/1/);
  assert.match(brief, /node "\/c\/qac.mjs" slip "dbg! in tests" --added/);
  assert.match(brief, /--infeasible "<reason>"/);
  assert.match(laneBrief({ ...entry, sources: [] }, "c"), /no source given/);
  assert.doesNotMatch(brief, /\u2014/);
});

test("forkLane runs qol sessions fork with claude, opus and high effort, keyed by the pattern", () => {
  const calls = [];
  const exec = (cmd, args) => {
    calls.push([cmd, args]);
    return calls.length === 1 ? '{"key":"qac-rule-x-1"}' : "launched";
  };
  const entry = { id: "x", pattern: "x", first_seen: "t", sources: [] };
  assert.equal(forkLane(entry, "/repo", { cli: "c", exec }), "qac-rule-x-1");
  assert.equal(forkLane(entry, "/repo", { cli: "c", exec }), "qac-rule-x");
  const [cmd, args] = calls[0];
  assert.equal(cmd, "qol");
  assert.deepEqual(args.slice(0, 12), [
    "sessions", "fork", "--tool", LANE.tool, "--model", LANE.model, "--effort", LANE.effort,
    "--cwd", "/repo", "--key", "qac-rule-x",
  ]);
  assert.deepEqual([LANE.tool, LANE.model, LANE.effort], ["claude", "opus", "high"]);
  assert.deepEqual(args.slice(12, 14), ["--no-chat", "--brief"]);
});

test("recordSlip forks a lane on first sight and only counts later sightings", () => {
  const deps = ledger();
  const first = recordSlip("Unwrap in daemon loop", { from: "https://x/pull/1", cwd: "/w" }, deps);
  assert.equal(first.forked, true);
  assert.equal(first.error, null);
  assert.equal(first.entry.lane, "qac-rule-unwrap-in-daemon-loop");
  assert.deepEqual(deps.forks, [{ id: "unwrap-in-daemon-loop", repo: path.resolve("/git/qol-skills") }]);

  const again = recordSlip("unwrap in daemon loop", { from: "https://x/pull/1" }, deps);
  const third = recordSlip("unwrap in daemon loop", { from: "https://x/pull/2" }, deps);
  assert.equal(again.forked, false);
  assert.equal(deps.forks.length, 1);
  assert.equal(third.entry.seen, 3);
  assert.equal(third.entry.pattern, "Unwrap in daemon loop");
  assert.equal(third.entry.first_seen, first.entry.first_seen);
  assert.deepEqual(third.entry.sources, ["https://x/pull/1", "https://x/pull/2"]);
  assert.equal(listSlips(deps).length, 1);
});

test("a failed fork leaves the entry open with no lane, so the next sighting forks again", () => {
  const failing = ledger({ fork: () => { throw Object.assign(new Error("x"), { stderr: "key held\nmore" }); } });
  const failed = recordSlip("p", {}, failing);
  assert.equal(failed.forked, false);
  assert.equal(failed.entry.lane, null);
  assert.equal(failed.error, "qol sessions fork failed: key held");
  const retried = recordSlip("p", {}, { ...failing, fork: (entry) => laneKey(entry.id) });
  assert.equal(retried.forked, true);
  assert.equal(retried.entry.lane, "qac-rule-p");
});

test("no qol-skills clone records the slip and names --rules-repo", () => {
  const result = recordSlip("p", { cwd: "/w" }, ledger({ exists: () => false }));
  assert.equal(result.entry.seen, 1);
  assert.match(result.error, /no qol-skills clone found from \/w; pass --rules-repo/);
  const named = recordSlip("p", { cwd: "/w", rulesRepo: "/nope" }, ledger({ exists: () => false }));
  assert.equal(named.error, "--rules-repo /nope is not a qol-skills clone");
});

test("an infeasible pattern is never forked for again, even when marked before its first sight", () => {
  const deps = ledger();
  recordSlip("p", {}, deps);
  const marked = recordSlip("p", { infeasible: "needs type information" }, deps);
  assert.equal(marked.entry.status, "infeasible");
  assert.equal(marked.entry.seen, 1);
  const later = recordSlip("p", {}, { ...deps, fork: () => assert.fail("forked an infeasible pattern") });
  assert.equal(later.forked, false);
  assert.equal(later.entry.seen, 2);

  const early = ledger({ fork: () => assert.fail("forked an infeasible pattern") });
  assert.equal(recordSlip("q", { infeasible: "no AST" }, early).entry.seen, 0);
  assert.equal(recordSlip("q", {}, early).forked, false);
});

test("--added marks the rule added by the recorded lane and stops further forks", () => {
  const deps = ledger();
  recordSlip("p", {}, deps);
  const added = recordSlip("p", { added: true }, deps);
  assert.equal(statusText(added.entry), "rule added by qac-rule-p");
  assert.equal(recordSlip("p", {}, deps).forked, false);
  assert.equal(statusText(recordSlip("q", { added: true }, ledger()).entry), "rule added");
});

test("statusText, renderSlip and renderSlips read as one line per pattern", () => {
  const base = { pattern: "p", seen: 2, first_seen: "2026-10-20T01:02:03Z", sources: [], lane: null, reason: null };
  assert.equal(statusText({ ...base, status: "open" }), "open, no lane");
  assert.equal(statusText({ ...base, status: "open", lane: "k" }), "open, lane k");
  assert.equal(statusText({ ...base, status: "infeasible", reason: "r" }), "infeasible: r");
  const open = { ...base, status: "open", lane: "k" };
  assert.equal(renderSlip({ entry: open, forked: true, error: null }), 'qac slip: "p" open, lane k, seen 2; forked lane k to add the rule');
  assert.equal(renderSlip({ entry: open, forked: false, error: null }), 'qac slip: "p" open, lane k, seen 2');
  assert.match(renderSlip({ entry: base, forked: false, error: "boom" }, "x"), /^x slip: .*; boom$/);
  assert.equal(renderSlips([]), "qac slips: none recorded");
  assert.equal(
    renderSlips([open, { ...open, pattern: "q", sources: ["u1", "u2"] }]),
    "qac slips: 2 patterns\np | open, lane k | seen 2, first 2026-10-20\nq | open, lane k | seen 2, first 2026-10-20 | u2",
  );
});

test("listSlips orders patterns by first sight", () => {
  const deps = ledger();
  recordSlip("b", {}, deps);
  recordSlip("a", {}, deps);
  assert.deepEqual(listSlips(deps).map(entry => entry.id), ["b", "a"]);
});

test("parseArgs takes value flags in either form and keeps the rest as positionals", () => {
  const args = parseArgs(["slip", "dbg!", "in", "tests", "--from", "u", "--infeasible=a=b", "--rules-repo", "/r", "--added", "--pretty"]);
  assert.deepEqual(args.paths, ["dbg!", "in", "tests"]);
  assert.equal(args.from, "u");
  assert.equal(args.infeasible, "a=b");
  assert.equal(args.rulesRepo, "/r");
  assert.equal(args.added, true);
  assert.equal(args.pretty, true);
  assert.equal(parseArgs(["lint", "--base=HEAD", "--cwd", "/w"]).base, "HEAD");
  assert.equal(parseArgs(["lint", "--cwd", "/w"]).cwd, "/w");
});

test("run slip records, forks and exits by outcome; run slips lists", () => {
  const deps = ledger();
  const out = [];
  const io = { out: line => out.push(line), ledger: deps };
  assert.equal(run(["slip", "--pretty"], io), EXIT.usage);
  assert.match(out[0], /name the pattern qac missed/);
  assert.equal(run(["slip", "dbg!", "in", "tests", "--from", "u", "--pretty"], io), EXIT.clean);
  assert.equal(out[1], 'qac slip: "dbg! in tests" open, lane qac-rule-dbg-in-tests, seen 1; forked lane qac-rule-dbg-in-tests to add the rule');
  assert.equal(run(["slip", "x"], { ...io, ledger: { ...deps, exists: () => false } }), EXIT.forkFailed);
  assert.match(JSON.parse(out[2]).error, /no qol-skills clone/);
  assert.equal(run(["slips"], io), EXIT.clean);
  assert.deepEqual(JSON.parse(out[3]).slips.map(entry => entry.id), ["dbg-in-tests", "x"]);
  assert.equal(run(["slips", "--pretty"], io), EXIT.clean);
  assert.match(out[4], /^qac slips: 2 patterns\n/);
  assert.equal(run(["help"], io), EXIT.clean);
  assert.deepEqual(JSON.parse(out[5]).verbs, ["lint", "fix", "slip", "slips"]);
});

test("the typed verb routes slip and slips and keeps quoted arguments whole", () => {
  assert.deepEqual(
    parsePrompt('qac slip "dbg! in tests" --infeasible "needs types"', "/w"),
    ["slip", "dbg! in tests", "--infeasible", "needs types", "--prefix=qac", "--pretty", "--cwd=/w"],
  );
  assert.deepEqual(parsePrompt("qac slips", ""), ["slips", "--prefix=qac", "--pretty"]);
  assert.deepEqual(parsePrompt("qac  lint   a", ""), ["lint", "a", "--prefix=qac", "--pretty", "--open"]);
});

test("help lists the slip verbs", () => {
  const help = renderHelp();
  assert.match(help, /qac slip <pattern>/);
  assert.match(help, /qac slips /);
  assert.match(help, /--infeasible=<reason>/);
});
