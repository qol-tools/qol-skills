import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyFile } from "../src/classify.mjs";
import { CORE_LENSES, LENS_NAMES } from "../src/lenses.mjs";
import { CHUNK_LINES, LEVELS, buildChunks, buildPlan, reviewableChanged, shuffle, suggestLevel } from "../src/plan.mjs";

function hunkOf({ start = 1, add = 0, remove = 0, before = 0 }) {
  const lines = [...Array(before).fill(" context"), ...Array.from({ length: remove }, (_, index) => `-old ${index}`), ...Array.from({ length: add }, (_, index) => `+new ${index}`)];
  return { header: "@@", old_start: start, old_count: before + remove, new_start: start, new_count: before + add, context: "", lines, added: add, removed: remove };
}

function classified(path, hunks, extra = {}) {
  const file = { path, status: "M", old_path: path, hunks, binary: false, mode_change: false, ...extra };
  return { ...file, ...classifyFile(file) };
}

const source = (path, add, remove = 0) => classified(path, [hunkOf({ add, remove })]);

test("suggestLevel routes excluded-only, docs-only and pure renames to the trivial quick path", () => {
  assert.deepEqual(suggestLevel([classified("yarn.lock", [hunkOf({ add: 50 })])]), { level: "quick", trivial: true, reasons: ["only generated, vendored, lockfile or binary files changed"] });
  assert.equal(suggestLevel([classified("docs/a.md", [hunkOf({ add: 200 })]), classified("img/a.png", [hunkOf({ add: 1 })])]).trivial, true);
  const rename = classified("src/b.js", [], { status: "R", old_path: "src/a.js" });
  assert.deepEqual(suggestLevel([rename]).level, "quick");
  assert.equal(suggestLevel([rename]).trivial, true);
});

test("suggestLevel picks quick, standard, deep and max from size and risk", () => {
  assert.deepEqual(suggestLevel([source("src/a.js", 20, 10)]), { level: "quick", trivial: false, reasons: ["30 changed lines and no high-risk file"] });
  assert.equal(suggestLevel([source("src/a.js", 31)]).level, "standard");
  const deep = suggestLevel([source("src/auth/token.js", 5)]);
  assert.equal(deep.level, "deep");
  assert.match(deep.reasons[0], /src\/auth\/token\.js \(security-path\)/);
  const loosened = classified("src/auth/login.js", [{ ...hunkOf({ remove: 1 }), lines: ['-if (!user) throw new Error("x");'] }]);
  const loosening = suggestLevel([loosened]);
  assert.equal(loosening.level, "deep");
  assert.match(loosening.reasons[1], /validation removed from security-sensitive code/);
  const categories = suggestLevel([source("src/auth/a.js", 5), classified("db/migrations/1.sql", [hunkOf({ add: 2 })]), classified(".github/workflows/ci.yml", [hunkOf({ add: 2 })])]);
  assert.equal(categories.level, "deep");
  assert.match(categories.reasons[1], /3 distinct high-risk categories: ci-config, migration, security-path/);
});

test("reviewableChanged ignores excluded files", () => {
  assert.equal(reviewableChanged([source("src/a.js", 10, 5), classified("yarn.lock", [hunkOf({ add: 900 })])]), 15);
});

test("buildChunks packs small files and splits an oversized hunk into focus windows", () => {
  const files = [source("src/b.js", 100), source("src/a.js", 100), classified("yarn.lock", [hunkOf({ add: 5 })])];
  const [chunk] = buildChunks(files);
  assert.deepEqual(chunk, {
    id: "c01",
    changed: 200,
    files: [
      { path: "src/a.js", changed: 100, hunks: [0], focus: "all" },
      { path: "src/b.js", changed: 100, hunks: [0], focus: "all" },
    ],
  });
  const huge = buildChunks([classified("src/big.js", [hunkOf({ start: 1, add: 900 })])], CHUNK_LINES);
  assert.deepEqual(huge.map((item) => item.changed), [400, 400, 100]);
  assert.deepEqual(huge.map((item) => item.files[0].focus), [
    [{ head: [1, 400], base: null }],
    [{ head: [401, 800], base: null }],
    [{ head: [801, 900], base: null }],
  ]);
  const removal = buildChunks([classified("src/old.js", [hunkOf({ start: 10, remove: 500 })])]);
  assert.deepEqual(removal[0].files[0].focus, [{ head: null, base: [10, 409] }]);
});

test("buildChunks keeps files without hunks as zero-change units", () => {
  const rename = classified("src/b.js", [], { status: "R", old_path: "src/a.js" });
  const [chunk] = buildChunks([rename, source("src/c.js", 10)]);
  assert.deepEqual(chunk.files.map((file) => [file.path, file.changed, file.focus]), [["src/b.js", 0, "all"], ["src/c.js", 10, "all"]]);
});

test("buildPlan gives one job per core lens at standard", () => {
  const files = [source("src/a.js", 50)];
  const plan = buildPlan({ chunks: buildChunks(files), files, level: "standard", seed: "s" });
  assert.deepEqual(plan.jobs.map((job) => job.id), CORE_LENSES.map((lens) => `c01-${lens}-p1`));
  assert.deepEqual({ solo: plan.solo, passes: plan.passes, verify: plan.verify, verifier_cap: plan.verifier_cap, job_cap: plan.job_cap, over_cap: plan.over_cap, ledger: plan.ledger, ledger_skipped: plan.ledger_skipped, hunt: plan.hunt, context: plan.context }, {
    solo: false, passes: 1, verify: "agent", verifier_cap: 30, job_cap: 20, over_cap: false, ledger: null, ledger_skipped: null, hunt: null, context: false,
  });
  assert.deepEqual(plan.lenses, CORE_LENSES);
});

test("buildPlan reduces by pairing lenses, then passes, then one job per chunk", () => {
  const files = [source("src/a.js", 50)];
  const chunks = buildChunks(files);
  const paired = buildPlan({ chunks, files, level: "deep", maxJobs: 5, seed: "s" });
  assert.deepEqual(paired.reductions, ["lenses paired into shared finder jobs", "passes reduced to 2"]);
  assert.equal(paired.jobs.length, 4);
  assert.equal(paired.jobs[0].id, "c01-correctness+security-p1");
  const single = buildPlan({ chunks, files, level: "standard", maxJobs: 1, seed: "s" });
  assert.deepEqual(single.reductions, ["lenses paired into shared finder jobs", "all lenses of a chunk share one finder job"]);
  assert.deepEqual(single.jobs.map((job) => job.id), ["c01-correctness+security+contracts+tests-p1"]);
  const wide = Array.from({ length: 3 }, (_, index) => source(`src/f${index}.js`, 300));
  const max = buildPlan({ chunks: buildChunks(wide), files: wide, level: "max", seed: "s" });
  assert.deepEqual(max.reductions, ["lenses paired into shared finder jobs"]);
  assert.equal(max.jobs.length, 3 * Math.ceil(LENS_NAMES.length / 2) * 5);
  assert.ok(max.jobs.length <= LEVELS.max.jobs);
});

test("buildPlan marks over_cap when one job per chunk still exceeds the cap", () => {
  const files = [source("src/a.js", 300), source("src/b.js", 300)];
  const plan = buildPlan({ chunks: buildChunks(files), files, level: "standard", maxJobs: 1, seed: "s" });
  assert.equal(plan.over_cap, true);
  assert.equal(plan.jobs.length, 2);
});

test("solo plans run one pass with every lens in one job and verify themselves, and a quick plan uses agents", () => {
  const files = [source("src/auth/a.js", 20)];
  const plan = buildPlan({ chunks: buildChunks(files), files, level: "max", solo: true, seed: "s" });
  assert.deepEqual(plan.jobs.map((job) => job.id), ["c01-all-p1"]);
  assert.deepEqual(plan.jobs[0].lenses, LENS_NAMES);
  assert.deepEqual({ solo: plan.solo, passes: plan.passes, verify: plan.verify, job_cap: plan.job_cap, hunt: plan.hunt }, { solo: true, passes: 1, verify: "self", job_cap: Infinity, hunt: { id: "hunt", kind: "hunt" } });
  const quick = buildPlan({ chunks: buildChunks(files), files, level: "quick", seed: "s" });
  assert.deepEqual([quick.solo, quick.verify, quick.jobs.length, quick.jobs[0].lenses], [false, "agent", 1, LENS_NAMES]);
  const alone = buildPlan({ chunks: buildChunks(files), files, level: "quick", solo: true, seed: "s" });
  assert.deepEqual([alone.solo, alone.verify, alone.jobs.length], [true, "self", 1]);
});

test("deep routes lenses by signals and builds a ledger only for high-risk files", () => {
  const plain = [source("src/a.js", 40)];
  const quiet = buildPlan({ chunks: buildChunks(plain), files: plain, level: "deep", seed: "s" });
  assert.deepEqual(quiet.lenses, CORE_LENSES);
  assert.equal(quiet.ledger, null);
  assert.equal(quiet.ledger_skipped, "no high-risk file to build a ledger for");
  const locks = classified("src/pool.js", [{ ...hunkOf({ add: 1 }), lines: ["+const lock = new Mutex();"] }]);
  const routed = buildPlan({ chunks: buildChunks([locks]), files: [locks], level: "deep", seed: "s" });
  assert.deepEqual(routed.lenses, ["correctness", "concurrency", "security", "contracts", "tests"]);
  assert.deepEqual(routed.ledger, { id: "ledger", kind: "ledger", items: ["src/pool.js"] });
  assert.equal(routed.ledger_skipped, null);
  assert.equal(routed.passes, 3);
  assert.equal(routed.jobs.length, 15);
});

test("pass 1 reads the central file first and later passes shuffle with a fixed seed", () => {
  const files = [source("src/a.js", 10), source("src/b.js", 90), source("src/c.js", 20), source("src/d.js", 30)];
  const chunks = buildChunks(files);
  const plan = buildPlan({ chunks, files, level: "deep", seed: "seed" });
  const first = plan.jobs.find((job) => job.pass === 1);
  assert.deepEqual(first.file_order, ["src/b.js", "src/a.js", "src/c.js", "src/d.js"]);
  assert.equal(first.hunk_order, "forward");
  const second = plan.jobs.find((job) => job.pass === 2);
  assert.equal(second.hunk_order, "reverse");
  assert.deepEqual([...second.file_order].sort(), ["src/a.js", "src/b.js", "src/c.js", "src/d.js"]);
  const again = buildPlan({ chunks, files, level: "deep", seed: "seed" });
  assert.deepEqual(again.jobs, plan.jobs);
});

test("shuffle is a deterministic permutation per seed", () => {
  const items = Array.from({ length: 20 }, (_, index) => index);
  const one = shuffle(items, "alpha");
  assert.deepEqual(one, shuffle(items, "alpha"));
  assert.deepEqual([...one].sort((left, right) => left - right), items);
  assert.notDeepEqual(one, shuffle(items, "beta"));
  assert.deepEqual(items, Array.from({ length: 20 }, (_, index) => index));
});

test("a refactor adds the redundancy lens even at the standard level", () => {
  const moved = classified("src/b.js", [hunkOf({ add: 30, remove: 30 })]);
  assert.ok(moved.signals.includes("refactor"));
  const plan = buildPlan({ chunks: buildChunks([moved]), files: [moved], level: "standard", seed: "s" });
  assert.deepEqual(plan.lenses, [...CORE_LENSES.slice(0, 1), "security", "contracts", "tests", "redundancy"].sort((left, right) => LENS_NAMES.indexOf(left) - LENS_NAMES.indexOf(right)));
  assert.equal(buildPlan({ chunks: buildChunks([source("src/a.js", 40)]), files: [source("src/a.js", 40)], level: "standard", seed: "s" }).lenses.includes("redundancy"), false);
});
