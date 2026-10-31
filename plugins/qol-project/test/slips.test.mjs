import test from "node:test";
import assert from "node:assert";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parsePrompt } from "../hooks/qac-intercept.mjs";
import { renderHelp } from "../src/qac.mjs";
import {
  LANE, ROUTES, forkLane, laneBrief, laneKey, ledgerFile, listSlips, qolOnPath, readSlips, recordFingerprint,
  recordSlip, renderSlip, renderSlips, rulesRepo, slugOf, statusText, suggestionBrief, withLock,
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
  assert.deepEqual(JSON.parse(out[5]).verbs, ["lint", "fix", "slip", "slips", "gate", "trust", "traps", "init"]);
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

const FP = { fingerprint: "abcd1234abcd1234", judge: "clippy", rule: "clippy::unwrap_used", message: "used unwrap", from: "https://x/pull/1", loop: "k1", cwd: "/w" };

function elsewhere(extra = {}) {
  const calls = [];
  const deps = ledger({
    calls,
    exec: (command, args, options) => {
      calls.push({ command, args, options });
      return command === "git" ? "/work/other/.git\n" : '{"key":"lane-1"}';
    },
    ...extra,
  });
  return deps;
}

function busy(extra = {}) {
  let time = 0;
  const slept = [];
  const removed = [];
  return {
    slept,
    removed,
    clock: () => time,
    nowMs: () => time,
    sleep: ms => {
      slept.push(ms);
      time += ms;
    },
    createLock: () => {
      throw Object.assign(new Error("exists"), { code: "EEXIST" });
    },
    lockAge: () => 100,
    removeLock: target => removed.push(target),
    ...extra,
  };
}

test("withLock holds file.lock while fn runs, releases it after, and returns the value", () => {
  const file = path.join(scratch(), "ledger", "slips.jsonl");
  const value = withLock(file, () => {
    assert.equal(existsSync(`${file}.lock`), true);
    return 42;
  });
  assert.equal(value, 42);
  assert.equal(existsSync(`${file}.lock`), false);
});

test("withLock releases the lock when fn throws", () => {
  const file = path.join(scratch(), "slips.jsonl");
  assert.throws(() => withLock(file, () => { throw new Error("boom"); }), /boom/);
  assert.equal(existsSync(`${file}.lock`), false);
  assert.equal(withLock(file, () => "again"), "again");
});

test("withLock refuses a second holder and gives up after two seconds with ELOCK", () => {
  const file = path.join(scratch(), "slips.jsonl");
  withLock(file, () => {
    const waiting = busy({ createLock: undefined, lockAge: undefined, removeLock: () => assert.fail("took a live lock") });
    assert.throws(() => withLock(file, () => assert.fail("ran without the lock"), waiting), { code: "ELOCK" });
    assert.ok(waiting.clock() >= 2000);
  });
});

test("withLock polls a held lock and takes it when it frees up", () => {
  const file = path.join(scratch(), "slips.jsonl");
  let attempts = 0;
  const deps = busy({
    createLock: () => {
      attempts += 1;
      if (attempts < 4) throw Object.assign(new Error("exists"), { code: "EEXIST" });
    },
  });
  assert.equal(withLock(file, () => "got it", deps), "got it");
  assert.equal(attempts, 4);
  assert.equal(deps.slept.length, 3);
  assert.deepEqual(deps.removed, [`${file}.lock`]);
});

test("withLock breaks a lock older than ten seconds and takes it", () => {
  const file = path.join(scratch(), "slips.jsonl");
  let attempts = 0;
  const deps = busy({
    lockAge: () => 10001,
    createLock: () => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error("exists"), { code: "EEXIST" });
    },
  });
  assert.equal(withLock(file, () => "taken", deps), "taken");
  assert.deepEqual(deps.removed, [`${file}.lock`, `${file}.lock`]);
  assert.equal(deps.slept.length, 0);
});

test("withLock keeps a lock of exactly ten seconds and rethrows errors other than EEXIST", () => {
  const file = path.join(scratch(), "slips.jsonl");
  const young = busy({ lockAge: () => 10000, removeLock: () => assert.fail("broke a live lock") });
  assert.throws(() => withLock(file, () => 1, young), { code: "ELOCK" });
  const denied = busy({ createLock: () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); } });
  assert.throws(() => withLock(file, () => 1, denied), { code: "EACCES" });
});

test("withLock stops waiting when the stale lock cannot be removed", () => {
  const file = path.join(scratch(), "slips.jsonl");
  const stuck = busy({ lockAge: () => 20000, removeLock: () => { throw new Error("EPERM"); } });
  assert.throws(() => withLock(file, () => 1, stuck), { code: "ELOCK" });
});

test("recordSlip decides and appends under the lock, forks outside it, then appends the lane under the lock again", () => {
  const seen = [];
  const deps = ledger();
  const lock = () => existsSync(`${deps.file}.lock`);
  const result = recordSlip("p", { cwd: "/w" }, {
    ...deps,
    fork: entry => {
      seen.push(["fork", lock()]);
      return laneKey(entry.id);
    },
    read: () => {
      seen.push(["read", lock()]);
      throw new Error("none");
    },
    append: (file, text) => {
      seen.push(["append", lock(), JSON.parse(text).lane]);
      appendFileSync(file, text);
    },
  });
  assert.deepEqual(seen, [["read", true], ["append", true, "forking"], ["fork", false], ["read", true], ["append", true, "qac-rule-p"]]);
  assert.equal(lock(), false);
  assert.deepEqual([result.forked, result.entry.lane, result.error], [true, "qac-rule-p", null]);
});

test("a second recorder during a slow fork is neither blocked nor forks again, and no sighting is lost", () => {
  const deps = ledger();
  recordFingerprint(FP, deps);
  let during = null;
  const slow = {
    ...deps,
    fork: entry => {
      during = recordFingerprint({ ...FP, loop: "k3", from: "https://x/pull/3" }, { ...deps, fork: () => assert.fail("forked twice") });
      return laneKey(entry.id);
    },
  };
  const second = recordFingerprint({ ...FP, loop: "k2", from: "https://x/pull/2" }, slow);
  assert.equal(second.forked, true);
  assert.deepEqual([during.due, during.forked, during.error], [false, false, null]);
  const [entry] = listSlips(deps);
  assert.equal(entry.lane, "qac-rule-fp-abcd1234abcd1234");
  assert.deepEqual(entry.loops, ["k1", "k2", "k3"]);
  assert.equal(entry.seen, 3);
});

test("a failed fork clears the pending lane so a later sighting can fork again", () => {
  const deps = ledger({ fork: () => { throw Object.assign(new Error("no"), { stderr: "boom\nmore" }); } });
  recordFingerprint(FP, deps);
  const failed = recordFingerprint({ ...FP, loop: "k2" }, deps);
  assert.deepEqual([failed.due, failed.forked, failed.entry.lane], [true, false, null]);
  assert.equal(failed.error, "qol sessions fork failed: boom");
  assert.equal(listSlips(deps)[0].lane, null);
  const retry = recordFingerprint({ ...FP, loop: "k3" }, { ...deps, fork: entry => laneKey(entry.id) });
  assert.deepEqual([retry.due, retry.forked], [true, true]);
});

test("recordSlip entries carry kind, route, repo_id and loops, defaulting old entries", () => {
  const deps = ledger();
  const slug = recordSlip("p", { from: "https://x/pull/1", route: "tamper", repoId: "r1" }, deps);
  assert.equal(slug.entry.kind, "slug");
  assert.equal(slug.entry.route, "tamper");
  assert.equal(slug.entry.repo_id, "r1");
  assert.deepEqual(slug.entry.loops, ["https://x/pull/1"]);
  const old = ledger();
  mkdirSync(path.dirname(old.file), { recursive: true });
  writeFileSync(old.file, `${JSON.stringify({ id: "q", pattern: "q", first_seen: "t", seen: 4, sources: [], status: "open", lane: "kept", reason: null, updated: "t" })}\n`);
  const upgraded = recordSlip("q", {}, old);
  assert.deepEqual([upgraded.entry.kind, upgraded.entry.route, upgraded.entry.repo_id, upgraded.entry.loops], ["slug", "qac-check", null, []]);
  assert.equal(upgraded.entry.seen, 5);
  assert.equal(upgraded.forked, false);
});

test("recordSlip still forks a slug at its first sighting on every lane route", () => {
  for (const route of ["qac-check", "tamper"]) {
    const deps = ledger();
    const result = recordSlip("p", { cwd: "/w", route }, deps);
    assert.equal(result.due, true);
    assert.equal(result.forked, true);
    assert.equal(result.handover, false);
    assert.deepEqual(deps.forks, [{ id: "p", repo: path.resolve("/git/qol-skills") }]);
  }
});

test("recordFingerprint forks at two distinct loops, not at one and not at a repeated loop", () => {
  const deps = ledger();
  const first = recordFingerprint(FP, deps);
  assert.deepEqual([first.due, first.forked, first.handover, first.brief, first.error], [false, false, false, null, null]);
  assert.equal(first.entry.id, "fp-abcd1234abcd1234");
  assert.deepEqual([first.entry.kind, first.entry.route, first.entry.repo_id], ["fingerprint", "qac-check", null]);
  assert.deepEqual([first.entry.judge, first.entry.rule, first.entry.message, first.entry.fingerprint], ["clippy", "clippy::unwrap_used", "used unwrap", "abcd1234abcd1234"]);
  const repeat = recordFingerprint({ ...FP, from: "https://x/pull/9" }, deps);
  assert.equal(repeat.due, false);
  assert.deepEqual(repeat.entry.loops, ["k1"]);
  assert.equal(repeat.entry.seen, 2);
  assert.deepEqual(deps.forks, []);
  const second = recordFingerprint({ ...FP, loop: "k2", from: "https://x/pull/2" }, deps);
  assert.equal(second.due, true);
  assert.equal(second.forked, true);
  assert.equal(second.entry.lane, "qac-rule-fp-abcd1234abcd1234");
  assert.deepEqual(second.entry.loops, ["k1", "k2"]);
  assert.deepEqual(deps.forks, [{ id: "fp-abcd1234abcd1234", repo: path.resolve("/git/qol-skills") }]);
  const third = recordFingerprint({ ...FP, loop: "k3" }, deps);
  assert.deepEqual([third.due, third.forked], [false, false]);
  assert.equal(deps.forks.length, 1);
  assert.deepEqual(listSlips(deps).map(entry => entry.id), ["fp-abcd1234abcd1234"]);
});

test("a fingerprint sighting with no loop key counts by its from", () => {
  const deps = ledger();
  const bare = { ...FP, loop: undefined };
  assert.equal(recordFingerprint(bare, deps).due, false);
  assert.equal(recordFingerprint(bare, deps).due, false);
  assert.equal(recordFingerprint({ ...bare, from: "https://x/run/2" }, deps).forked, true);
  const none = ledger();
  const anonymous = { ...FP, loop: undefined, from: undefined };
  assert.equal(recordFingerprint(anonymous, none).due, false);
  assert.equal(recordFingerprint(anonymous, none).due, false);
  assert.deepEqual(none.forks, []);
});

test("recordFingerprint keeps a repository's fingerprints apart through repo_id", () => {
  const deps = ledger();
  recordFingerprint({ ...FP, repoId: "aaaa" }, deps);
  recordFingerprint({ ...FP, repoId: "bbbb", loop: "k2" }, deps);
  const entries = listSlips(deps);
  assert.deepEqual(entries.map(entry => entry.id).sort(), ["fp-aaaa-abcd1234abcd1234", "fp-bbbb-abcd1234abcd1234"]);
  assert.deepEqual(entries.map(entry => entry.repo_id).sort(), ["aaaa", "bbbb"]);
  assert.deepEqual(deps.forks, []);
});

test("recordFingerprint needs a fingerprint and a known route", () => {
  assert.throws(() => recordFingerprint({ judge: "j" }, ledger()), /needs a fingerprint/);
  assert.throws(() => recordFingerprint({ ...FP, route: "nope" }, ledger()), /unknown route nope; routes: qac-check, repo-linter/);
  assert.throws(() => recordSlip("p", { route: "nope" }, ledger()), /unknown route nope/);
  assert.deepEqual(ROUTES, ["qac-check", "repo-linter", "tamper", "agent-behaviour", "judge-revert"]);
});

function twice(route, deps, extra = {}) {
  recordFingerprint({ ...FP, route, ...extra }, deps);
  return recordFingerprint({ ...FP, route, loop: "k2", ...extra }, deps);
}

test("a repo-linter miss forks in the repository it came from, not the qol-skills clone", () => {
  const deps = elsewhere({ exists: () => false });
  const result = twice("repo-linter", deps);
  assert.equal(result.forked, true);
  assert.deepEqual(deps.forks, [{ id: "fp-abcd1234abcd1234", repo: path.resolve("/work/other") }]);
  const clone = elsewhere({ exists: () => false });
  const refused = twice("qac-check", clone);
  assert.equal(refused.forked, false);
  assert.match(refused.error, /no qol-skills clone found from \/w/);
  assert.deepEqual(clone.forks, []);
});

test("a repo-linter miss without a git repository names --rules-repo", () => {
  const deps = ledger({ exec: () => { throw new Error("not a repository"); } });
  const result = twice("repo-linter", deps);
  assert.match(result.error, /^no git repository found from \/w; pass --rules-repo <path>$/);
  assert.equal(result.entry.lane, null);
  const named = twice("repo-linter", ledger({ exists: () => false }), { rulesRepo: "/nope" });
  assert.equal(named.error, "--rules-repo /nope is not a git repository");
});

test("a tamper miss forks in the qol-skills clone, not the repository it came from", () => {
  const sibling = path.join(path.resolve("/work/qol-skills"), QAC_SOURCE);
  const deps = elsewhere({ exists: file => file === sibling });
  const result = twice("tamper", deps);
  assert.equal(result.forked, true);
  assert.equal(result.entry.route, "tamper");
  assert.deepEqual(deps.forks, [{ id: "fp-abcd1234abcd1234", repo: path.resolve("/work/qol-skills") }]);
});

test("an agent-behaviour miss forks no lane and carries a mistake-ledger suggestion", () => {
  const deps = ledger({ fork: () => assert.fail("forked an agent-behaviour miss") });
  const first = recordFingerprint({ ...FP, route: "agent-behaviour" }, deps);
  assert.deepEqual([first.due, first.brief], [false, null]);
  const second = twice("agent-behaviour", deps);
  assert.deepEqual([second.due, second.forked, second.handover, second.error], [true, false, false, null]);
  assert.match(second.brief, /mistake-ledger rule at warn/);
  assert.match(second.brief, /Only the user raises a mistake-ledger rule to block/);
  assert.equal(second.entry.lane, null);
  const slug = recordSlip("force push to main", { route: "agent-behaviour" }, deps);
  assert.equal(slug.due, true);
  assert.match(slug.brief, /"force push to main" is agent behaviour/);
  assert.match(renderSlip(slug), /no lane for agent-behaviour:\nqac slip: "force push to main" is agent behaviour/);
  assert.doesNotMatch(suggestionBrief(second.entry), /\u2014/);
});

test("a judge-revert miss is recorded and never forks or briefs", () => {
  const deps = ledger({ fork: () => assert.fail("forked a judge-revert miss") });
  for (const loop of ["k1", "k2", "k3"]) {
    const result = recordFingerprint({ ...FP, route: "judge-revert", loop }, deps);
    assert.deepEqual([result.due, result.forked, result.handover, result.brief, result.error], [false, false, false, null, null]);
  }
  const [entry] = listSlips(deps);
  assert.deepEqual([entry.route, entry.loops, entry.seen, entry.lane], ["judge-revert", ["k1", "k2", "k3"], 3, null]);
  assert.equal(recordSlip("p", { route: "judge-revert", cwd: "/w" }, deps).due, false);
});

test("without qol on PATH a due entry hands over its brief instead of forking", () => {
  const deps = ledger({ fork: undefined, hasQol: () => false });
  const first = recordFingerprint(FP, deps);
  assert.deepEqual([first.due, first.handover, first.brief], [false, false, null]);
  const second = recordFingerprint({ ...FP, loop: "k2" }, deps);
  assert.deepEqual([second.due, second.forked, second.handover, second.error], [true, false, true, null]);
  assert.equal(second.entry.lane, null);
  assert.ok(second.brief.startsWith(`Open a session in ${path.resolve("/git/qol-skills")} and give it this brief:\n`));
  assert.match(second.brief, /fingerprint abcd1234abcd1234/);
  assert.match(second.brief, /slip --fingerprint abcd1234abcd1234 --entry fp-abcd1234abcd1234 --added/);
  assert.match(renderSlip(second), /qol is not on PATH, so no lane was forked/);
  const slug = recordSlip("p", { cwd: "/w" }, deps);
  assert.deepEqual([slug.handover, slug.forked, slug.entry.lane], [true, false, null]);
  assert.match(slug.brief, /slip "p" --added/);
});

test("with qol on PATH and no injected fork the lane runs qol in the chosen repository", () => {
  const deps = elsewhere({ fork: undefined, hasQol: () => true, exists: () => false });
  const result = twice("repo-linter", deps);
  assert.equal(result.forked, true);
  assert.equal(result.entry.lane, "lane-1");
  const fork = deps.calls.find(call => call.command === "qol");
  assert.equal(fork.options.cwd, path.resolve("/work/other"));
  assert.equal(fork.args[fork.args.indexOf("--cwd") + 1], path.resolve("/work/other"));
  assert.equal(fork.args[fork.args.indexOf("--key") + 1], "qac-rule-fp-abcd1234abcd1234");
  assert.match(fork.args.at(-1), /gh pr create --draft/);
});

test("qolOnPath looks for an executable named qol on each PATH entry", () => {
  const exists = file => file === path.join("/b", "qol");
  assert.equal(qolOnPath({ PATH: ["/a", "/b"].join(path.delimiter) }, exists), true);
  assert.equal(qolOnPath({ PATH: "/a" }, exists), false);
  assert.equal(qolOnPath({}, exists), false);
});

test("rulesRepo chooses its home per route", () => {
  const exec = () => "/work/other/.git\n";
  const isGit = file => file === path.join("/r", ".git");
  assert.equal(rulesRepo("/w", { exec, route: "repo-linter" }), path.resolve("/work/other"));
  assert.equal(rulesRepo("/w", { exec, explicit: "/r", exists: isGit, route: "repo-linter" }), path.resolve("/r"));
  assert.equal(rulesRepo("/w", { exec, explicit: "/q", exists: isGit, route: "repo-linter" }), null);
  assert.equal(rulesRepo("/w", { exec: () => { throw new Error("x"); }, route: "repo-linter" }), null);
  assert.equal(rulesRepo("/w", { exec, exists: () => false, route: "tamper" }), null);
  assert.equal(rulesRepo("/w", { exec, explicit: "/r", exists: () => true, route: "tamper" }), path.resolve("/r"));
  assert.equal(rulesRepo("/w", { exec, route: "agent-behaviour" }), null);
  assert.equal(rulesRepo("/w", { exec, route: "judge-revert", explicit: "/r", exists: () => true }), null);
});

test("laneBrief fits its route and its key kind", () => {
  const slug = { pattern: "dbg! in tests", first_seen: "2026-10-20", sources: [] };
  const fingerprint = { ...slug, id: "fp-r1-ff00ff00ff00ff00", kind: "fingerprint", fingerprint: "ff00ff00ff00ff00", judge: "clippy", rule: "r", message: "m", loops: ["k1", "k2"], sources: ["u"] };
  const clone = laneBrief({ ...fingerprint, route: "qac-check" }, "/c/qac.mjs");
  assert.match(clone, /the finding "m" \(judge clippy, rule r, fingerprint ff00ff00ff00ff00\) slipped past the local gate \(first seen 2026-10-20, seen in loops k1, k2, from u\)/);
  assert.match(clone, /direct to main/);
  assert.match(clone, /node "\/c\/qac.mjs" slip --fingerprint ff00ff00ff00ff00 --entry fp-r1-ff00ff00ff00ff00 --added/);
  assert.match(clone, /--entry fp-r1-ff00ff00ff00ff00 --infeasible "<reason>"/);
  assert.match(clone, /--infeasible "<reason>"/);
  const linter = laneBrief({ ...slug, route: "repo-linter" }, "c");
  assert.match(linter, /clippy.toml, the eslint config, ruff settings/);
  assert.match(linter, /new git worktree of this repository/);
  assert.match(linter, /gh pr create --draft/);
  assert.match(linter, /Never mark it ready/);
  assert.doesNotMatch(linter, /direct to main|plugins\/qol-project/);
  const tamper = laneBrief({ ...slug, route: "tamper" }, "c");
  assert.match(tamper, /tamper check that catches it to `qac gate`/);
  for (const text of [clone, linter, tamper]) assert.doesNotMatch(text, /\u2014/);
});

test("forkLane runs qol with the chosen repository as the process cwd as well as --cwd", () => {
  const calls = [];
  const entry = { id: "x", pattern: "x", first_seen: "t", sources: [], route: "repo-linter" };
  forkLane(entry, "/work/other", { cli: "c", exec: (cmd, args, options) => { calls.push({ cmd, args, options }); return ""; } });
  assert.equal(calls[0].options.cwd, "/work/other");
  assert.equal(calls[0].args[calls[0].args.indexOf("--cwd") + 1], "/work/other");
  assert.match(calls[0].args.at(-1), /draft pull request/);
});

test("renderSlip prints a hand-over brief and a route without a lane under the status line", () => {
  const entry = { pattern: "p", seen: 1, first_seen: "t", sources: [], lane: null, status: "open", route: "tamper" };
  assert.equal(
    renderSlip({ entry, forked: false, error: null, handover: true, brief: "B" }),
    'qac slip: "p" open, no lane, seen 1; qol is not on PATH, so no lane was forked. Hand this to a session:\nB',
  );
  assert.equal(renderSlip({ entry, forked: false, error: null, brief: "S" }), 'qac slip: "p" open, no lane, seen 1; no lane for tamper:\nS');
  assert.match(renderSlips([{ ...entry, status: "open" }]), /seen 1, first t \| tamper$/);
});
