import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";
import { LENS_NAMES } from "../src/lenses.mjs";
import { digestOf, mergeCandidates, similarTitles, verifierDescriptor } from "../src/merge.mjs";
import { candidate } from "./engine-helpers.mjs";

const job = (lens, pass = 1) => ({ id: `c01-${lens}-p${pass}`, kind: "finder", lenses: [lens], pass, chunk: "c01" });
const JOBS = [job("correctness"), job("security"), job("contracts"), job("tests"), job("correctness", 2)];

function check(location) {
  if (location.file === "src/missing.js") return "src/missing.js does not exist at the head of this review";
  if ((location.end_line ?? location.line) > 100) return `${location.file}:${location.end_line ?? location.line} is past the end of the file, which has 100 lines at the head`;
  return null;
}

function merge(byJob, { jobs = JOBS, verifierCap = 30, final = true, extra = {} } = {}) {
  const outputs = new Map(Object.entries(byJob).map(([id, candidates]) => [id, { job: id, candidates, files_read: [], declined: [] }]));
  for (const [id, output] of Object.entries(extra)) outputs.set(id, output);
  return mergeCandidates({ jobs, outputs, check, verifierCap, final });
}

test("schema defects and location problems exclude candidates with counted reasons", () => {
  const merged = merge({
    "c01-correctness-p1": [
      candidate(),
      candidate({ title: "" }),
      candidate({ lens: "security", title: "Wrong lens" }),
      candidate({ title: "Past the end", locations: [{ file: "src/app.js", line: 120 }] }),
      candidate({ title: "Ghost file", locations: [{ file: "src/missing.js", line: 3 }] }),
      candidate({ title: "Bad severity and past the end", severity: "urgent", locations: [{ file: "src/app.js", line: 150 }] }),
      candidate({ title: "No trigger", trigger: undefined, locations: [{ file: "src/b.js", line: 1 }] }),
    ],
  });
  assert.deepEqual(merged.stats, {
    received: 7,
    excluded: 6,
    kept: 1,
    groups: 1,
    excluded_by_reason: {
      "no title": 1,
      "lens outside the job": 1,
      "line past the end of the file": 1,
      "file does not exist": 1,
      'severity "urgent" is not one of blocker, high, medium, low, note': 1,
      "no trigger": 1,
    },
  });
  assert.deepEqual(merged.excluded.map((item) => [item.id, item.title]), [
    ["c01-correctness-p1#2", ""],
    ["c01-correctness-p1#3", "Wrong lens"],
    ["c01-correctness-p1#4", "Past the end"],
    ["c01-correctness-p1#5", "Ghost file"],
    ["c01-correctness-p1#6", "Bad severity and past the end"],
    ["c01-correctness-p1#7", "No trigger"],
  ]);
  assert.deepEqual(merged.excluded[2].reasons, ["src/app.js:120 is past the end of the file, which has 100 lines at the head"]);
  assert.deepEqual(merged.excluded[1].reasons, ['lens "security" is not one of correctness']);
});

test("missing and failed outputs are skipped and the hunt may use every lens", () => {
  const hunt = { id: "hunt", kind: "hunt" };
  const merged = merge(
    { "c01-security-p1": [candidate({ lens: "security", title: "Token leaks into logs", locations: [{ file: "src/log.js", line: 4 }] })], hunt: [candidate({ lens: "performance", title: "Quadratic scan of users", locations: [{ file: "src/scan.js", line: 9 }] })] },
    { jobs: [...JOBS, hunt], extra: { "c01-tests-p1": { job: "c01-tests-p1", failed: "timed out" } } },
  );
  assert.equal(merged.stats.received, 2);
  assert.deepEqual(merged.groups.map((group) => [group.found_by, group.lenses]), [[["c01-security-p1"], ["security"]], [["hunt"], ["performance"]]]);
  assert.equal(merged.groups[1].passes, 0);
  assert.ok(LENS_NAMES.includes("performance"));
});

test("candidates group only when their titles are similar and their spans are near", () => {
  const merged = merge({
    "c01-correctness-p1": [
      candidate({ title: "Loop bound skips final element", locations: [{ file: "src/app.js", line: 10 }] }),
      candidate({ title: "Index error near the end", locations: [{ file: "src/app.js", line: 13 }] }),
      candidate({ title: "Loop bound skips final element", locations: [{ file: "src/app.js", line: 40 }] }),
    ],
    "c01-security-p1": [
      candidate({ lens: "security", title: "Final element skipped by loop bound", locations: [{ file: "src/app.js", line: 12 }] }),
      candidate({ lens: "security", title: "Loop bound skips final element", locations: [{ file: "src/app.js", line: 10, side: "base" }] }),
    ],
    "c01-tests-p1": [candidate({ lens: "tests", title: "Secret written to disk", locations: [{ file: "src/app.js", line: 11 }] })],
    "c01-correctness-p2": [candidate({ title: "Loop bound skips final element", locations: [{ file: "src/app.js", line: 16 }] })],
  });
  const members = merged.groups.map((group) => group.candidates.map((item) => item.id).sort()).sort((left, right) => (left[0] < right[0] ? -1 : 1));
  assert.deepEqual(members, [
    ["c01-correctness-p1#1", "c01-security-p1#1"],
    ["c01-correctness-p1#2"],
    ["c01-correctness-p1#3"],
    ["c01-correctness-p2#1"],
    ["c01-security-p1#2"],
    ["c01-tests-p1#1"],
  ]);
  const pair = merged.groups.find((group) => group.candidates.length === 2);
  assert.deepEqual(pair.lenses, ["correctness", "security"]);
  assert.deepEqual(pair.found_by, ["c01-correctness-p1", "c01-security-p1"]);
  assert.equal(pair.passes, 1);
});

test("group locations drop duplicates and spans contained in another span", () => {
  const merged = merge({
    "c01-correctness-p1": [
      candidate({ locations: [{ file: "src/app.js", line: 10, end_line: 20 }, { file: "src/z.js", line: 5 }] }),
      candidate({ locations: [{ file: "src/app.js", line: 12 }, { file: "src/app.js", line: 12 }] }),
      candidate({ locations: [{ file: "src/app.js", line: 18, end_line: 22 }, { file: "src/a.js", line: 3 }] }),
      candidate({ locations: [{ file: "src/app.js", line: 15, side: "base" }] }),
    ],
  });
  assert.equal(merged.groups.length, 2);
  const [head] = merged.groups.filter((group) => group.candidates.length === 3);
  assert.deepEqual(head.locations, [
    { side: "head", file: "src/a.js", line: 3 },
    { side: "head", file: "src/app.js", line: 10, end_line: 20 },
    { side: "head", file: "src/app.js", line: 18, end_line: 22 },
    { side: "head", file: "src/z.js", line: 5 },
  ]);
});

test("the representative is chosen by severity, confidence, evidence and id", () => {
  const near = (overrides) => candidate({ locations: [{ file: "src/app.js", line: 10 }], ...overrides });
  const same = "Loop bound skips final element";
  const severity = merge({ "c01-correctness-p1": [near({ title: same }), near({ title: `${same} badly`, severity: "high" })] });
  assert.deepEqual([severity.groups[0].lead, severity.groups[0].title, severity.groups[0].severity], ["c01-correctness-p1#2", `${same} badly`, "high"]);
  const confidence = merge({ "c01-correctness-p1": [near({ title: same }), near({ title: `${same} surely`, confidence: "high" })] });
  assert.equal(confidence.groups[0].title, `${same} surely`);
  const evidence = merge({ "c01-correctness-p1": [near({ title: same, evidence: [] }), near({ title: `${same} thick`, evidence: ["a:1", "b:2"] })] });
  assert.equal(evidence.groups[0].title, `${same} thick`);
  const tie = merge({ "c01-correctness-p1": [near({ title: same }), near({ title: `${same} again` })] });
  assert.equal(tie.groups[0].lead, "c01-correctness-p1#1");
  const pre = merge({ "c01-correctness-p1": [near({ title: "Old", pre_existing: true })] });
  assert.equal(pre.groups[0].finder_pre_existing, true);
});

test("groups sort by severity, then file and line, and get sequential ids", () => {
  const merged = merge({
    "c01-correctness-p1": [
      candidate({ title: "Medium in b", locations: [{ file: "src/b.js", line: 50 }] }),
      candidate({ title: "High late", severity: "high", locations: [{ file: "src/b.js", line: 90 }] }),
      candidate({ title: "Medium in a", locations: [{ file: "src/a.js", line: 80 }] }),
      candidate({ title: "Note", severity: "note", locations: [{ file: "src/a.js", line: 1 }] }),
    ],
  });
  assert.deepEqual(merged.groups.map((group) => [group.id, group.title]), [["G01", "High late"], ["G02", "Medium in a"], ["G03", "Medium in b"], ["G04", "Note"]]);
  assert.deepEqual(Object.keys(merged.groups[0]).slice(0, 2), ["id", "lenses"]);
});

test("groups past the verifier cap are listed as unverified", () => {
  const many = Array.from({ length: 4 }, (_, index) => candidate({ title: `Distinct problem number ${index}`, locations: [{ file: `src/f${index}.js`, line: 1 }] }));
  assert.deepEqual(merge({ "c01-correctness-p1": many }, { verifierCap: 2 }).unverified, ["G03", "G04"]);
  assert.deepEqual(merge({ "c01-correctness-p1": many }, { verifierCap: null }).unverified, []);
  assert.equal(merge({ "c01-correctness-p1": many }, { final: false }).final, false);
});

test("similarTitles ignores stop words and needs half the tokens shared", () => {
  assert.equal(similarTitles("Missing null check for the user", "Null check missing when user absent"), true);
  assert.equal(similarTitles("Cache never expires", "Token logged in plain text"), false);
  assert.equal(similarTitles("the and for", "the and for"), false);
});

test("digestOf ignores the order of outputs", () => {
  const one = new Map([["a", { x: 1 }], ["b", { y: 2 }]]);
  const two = new Map([["b", { y: 2 }], ["a", { x: 1 }]]);
  assert.equal(digestOf(one), digestOf(two));
  assert.notEqual(digestOf(one), digestOf(new Map([["a", { x: 2 }], ["b", { y: 2 }]])));
});

test("verifierDescriptor points at the verifier prompt and the group's claim", () => {
  const [group] = merge({ "c01-correctness-p1": [candidate()] }).groups;
  const scope = { repo: "/r", tree: "/t", base: { ref: "main", sha: "b" }, head: { ref: "f", sha: "h", snapshot: false }, base_tree: "/bt", rules: [], shallow: { entries: [] }, plan: { ledger: null, context: false } };
  const paths = { dir: "/run", intent: "/run/intent.json", intentSources: "/run/intent-sources.md", rules: "/run/rules.md", ledger: "/run/ledger.json", context: "/run/context.json", diff: "/run/diff.patch", verify: "/run/verify" };
  const descriptor = verifierDescriptor(group, { scope, paths, references: "/refs", rubric: "/skill/SKILL.md" });
  assert.deepEqual(
    { id: descriptor.id, kind: descriptor.kind, group: descriptor.group, instructions: descriptor.instructions, lens_guide: descriptor.lens_guide, output: descriptor.output, head: descriptor.head, rubric: descriptor.rubric, base_tree: descriptor.base_tree, rules: descriptor.inputs.rules, ledger: descriptor.inputs.ledger, shallow: descriptor.inputs.shallow_wrappers },
    { id: "verify-G01", kind: "verifier", group: "G01", instructions: join("/refs", "engine-verifier-prompt.md"), lens_guide: join("/refs", "engine-lenses.md"), output: join("/run/verify", "G01.result.json"), head: { ref: "f", sha: "h" }, rubric: "/skill/SKILL.md", base_tree: "/bt", rules: null, ledger: null, shallow: null },
  );
  assert.equal(descriptor.claim.candidates.length, 1);
});

test("a shape must be a lowercase slug and travels with the candidate", () => {
  const merged = merge({ "c01-correctness-p1": [candidate({ shape: "unwrap-in-daemon-loop" }), candidate({ shape: "Not A Slug", title: "Another distinct defect here", locations: [{ file: "src/app.js", line: 80 }] })] });
  assert.equal(merged.stats.excluded, 1);
  assert.deepEqual(merged.excluded[0].reasons, ["shape is not a lowercase slug"]);
  assert.equal(merged.groups[0].candidates[0].shape, "unwrap-in-daemon-loop");
});
