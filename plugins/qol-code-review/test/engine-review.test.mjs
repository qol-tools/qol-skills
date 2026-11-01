import assert from "node:assert/strict";
import { test } from "node:test";
import { CORE_LENSES, LENS_NAMES } from "../src/lenses.mjs";
import { mergeCandidates } from "../src/merge.mjs";
import { composeReview, deriveVerdict, reviewTemplate } from "../src/review.mjs";
import { renderMarkdown } from "../src/render.mjs";
import { candidate } from "./engine-helpers.mjs";

const INTENT = { source: "stated", summary: "Fix the loop.", requirements: ["Visit every element."], claims: ["The loop visits every element."] };
const CORE_JOBS = CORE_LENSES.map((lens) => ({ id: `c01-${lens}-p1`, kind: "finder", lenses: [lens], pass: 1, chunk: "c01" }));
const SOLO_JOBS = [{ id: "c01-all-p1", kind: "finder", lenses: LENS_NAMES, pass: 1, chunk: "c01" }];

function scopeOf({ solo = false, level = solo ? "quick" : "standard", files = [{ path: "src/app.js" }, { path: "src/util.js" }] } = {}) {
  return {
    run_id: `repo-1111111-2222222-${level}`,
    target: { kind: "commit", input: "HEAD" },
    base: { ref: "HEAD^", sha: "2".repeat(40) },
    head: { ref: "HEAD", sha: "1".repeat(40), snapshot: false },
    pr: null,
    level: { used: level },
    plan: { solo, verify: solo ? "self" : "agent", lenses: solo ? LENS_NAMES : CORE_LENSES, jobs: solo ? SOLO_JOBS : CORE_JOBS },
    files: files.map((file) => ({ old_path: null, tier: "medium", excluded: false, exclude_reason: null, ...file })),
  };
}

function setup({ solo, level, files, byJob = {}, verdicts = {}, failed = {}, verifierCap } = {}) {
  const scope = scopeOf({ solo, level, files });
  const read = scope.files.filter((file) => !file.excluded).map((file) => ({ path: file.path, read: "full" }));
  const finds = new Map(scope.plan.jobs.map((job) => [job.id, failed[job.id] ? { job: job.id, failed: failed[job.id], agent_id: `agent-${job.id}` } : { job: job.id, candidates: byJob[job.id] ?? [], files_read: read, declined: [], agent_id: `agent-${job.id}` }]));
  const candidates = mergeCandidates({ jobs: scope.plan.jobs, outputs: finds, check: () => null, verifierCap: verifierCap ?? (solo ? null : 30), final: true });
  const verdictMap = new Map(Object.entries(verdicts).map(([group, value]) => [group, { group, agent_id: `agent-verify-${group}`, ...value }]));
  return { scope, finds, candidates, verdicts: verdictMap };
}

function compose(state, review = {}, check = () => null) {
  const base = {
    verdict: "pass",
    run: { runtime: "claude-code", mode: state.scope.plan.solo ? "single-agent" : "multi-agent" },
    findings: state.candidates.groups.map((group) => ({ groups: [group.id] })),
    dropped: [],
    claims: [],
    coverage: { files: [], not_reviewed: [], executed: [] },
  };
  return composeReview({ ...state, review: { ...base, ...review }, intent: INTENT, check });
}

const confirmed = (extra = {}) => ({ status: "confirmed", confidence: "high", checked: ["read src/app.js:10"], ...extra });
const open = (extra = {}) => ({ status: "needs_verification", confidence: "low", checked: ["read src/app.js:10"], ...extra });
const at = (file, line) => ({ locations: [{ file, line }] });
const one = (overrides = {}) => ({ byJob: { "c01-correctness-p1": [candidate(overrides)] } });

function includes(problems, expected) {
  assert.ok(problems.includes(expected), `missing problem: ${expected}\nproblems:\n${problems.join("\n")}`);
}

test("deriveVerdict blocks on confirmed blockers or highs and conditions on medium or unverified highs", () => {
  const cases = [
    [[], "pass"],
    [[{ status: "confirmed", severity: "low" }], "pass"],
    [[{ status: "confirmed", severity: "note" }], "pass"],
    [[{ status: "needs_verification", severity: "medium" }], "pass"],
    [[{ status: "confirmed", severity: "medium" }], "conditional"],
    [[{ status: "needs_verification", severity: "high" }], "conditional"],
    [[{ status: "needs_verification", severity: "blocker" }], "conditional"],
    [[{ status: "confirmed", severity: "high" }], "block"],
    [[{ status: "confirmed", severity: "blocker" }], "block"],
    [[{ status: "confirmed", severity: "blocker", pre_existing: true }], "pass"],
    [[{ status: "confirmed", severity: "medium" }, { status: "confirmed", severity: "high" }], "block"],
  ];
  for (const [findings, verdict] of cases) assert.equal(deriveVerdict(findings), verdict, JSON.stringify(findings));
});

test("a clean review composes with no problems and fills verification from the verifier", () => {
  const state = setup({ ...one(), verdicts: { G01: confirmed() } });
  const { report, problems } = compose(state, { verdict: "conditional" });
  assert.deepEqual(problems, []);
  const [finding] = report.findings;
  assert.deepEqual(
    { id: finding.id, status: finding.status, confidence: finding.confidence, severity: finding.severity, verification: finding.verification, found_by: finding.found_by, severity_trail: finding.severity_trail },
    { id: "correctness-1", status: "confirmed", confidence: "high", severity: "medium", verification: { verifier: "verify-G01", checked: ["read src/app.js:10"], refutation: null, question: null, note: null }, found_by: ["c01-correctness-p1"], severity_trail: ["c01-correctness-p1: medium"] },
  );
  assert.equal(report.schema, "code-review-engine/report@2");
  assert.equal(report.statement, "Conditional: fix correctness-1 (medium) before merging.");
});

test("every group must land in findings or dropped, but not both", () => {
  const state = setup({ byJob: { "c01-correctness-p1": [candidate(), candidate({ title: "Cache never expires", ...at("src/util.js", 50) })] }, verdicts: { G01: confirmed(), G02: confirmed() } });
  includes(compose(state, { verdict: "conditional", findings: [{ groups: ["G01"] }] }).problems, "group G02 (Cache never expires) is neither in findings nor in dropped");
  includes(compose(state, { verdict: "conditional", dropped: [{ group: "G02", reason: "not a defect" }] }).problems, "group G02 is in findings and in dropped");
  const unknown = compose(state, { verdict: "conditional", findings: [{ groups: ["G01"] }, { groups: ["G02"] }, { groups: ["G09"] }], dropped: [{ group: "G08", reason: "x" }, { group: "G02" }] }).problems;
  includes(unknown, "findings[2]: group G09 does not exist in candidates.json");
  includes(unknown, "dropped[0]: group G08 does not exist in candidates.json");
  includes(unknown, "dropped[1] needs a reason");
  includes(compose(state, { verdict: "conditional", findings: [{ groups: ["G01"] }, { groups: ["G02"] }, {}] }).problems, "findings[2]: a finding without groups needs origin, saying where it came from");
});

test("more than five notes is a problem", () => {
  const notes = Array.from({ length: 6 }, (_, index) => candidate({ severity: "note", title: `Distinct naming remark ${index}`, ...at("src/app.js", 10 + index * 10) }));
  const verdicts = Object.fromEntries(notes.map((_, index) => [`G0${index + 1}`, confirmed({ confidence: "medium" })]));
  const state = setup({ byJob: { "c01-correctness-p1": notes }, verdicts });
  includes(compose(state).problems, "6 notes exceed the cap of 5; keep the 5 most useful and drop the rest");
  const five = compose(state, { findings: state.candidates.groups.slice(0, 5).map((group) => ({ groups: [group.id] })), dropped: [{ group: "G06", reason: "least useful" }] });
  assert.deepEqual(five.problems, []);
  assert.deepEqual(five.report.notes.map((note) => note.id), ["correctness-1", "correctness-2", "correctness-3", "correctness-4", "correctness-5"]);
});

test("two findings that look like the same defect are a problem, including through title overrides", () => {
  const state = setup({
    byJob: {
      "c01-correctness-p1": [candidate({ title: "Loop bound skips final element" })],
      "c01-tests-p1": [candidate({ lens: "tests", title: "Coverage gap for single items", ...at("src/app.js", 12) })],
    },
    verdicts: { G01: confirmed(), G02: confirmed() },
  });
  assert.equal(state.candidates.groups.length, 2);
  assert.deepEqual(compose(state, { verdict: "conditional" }).problems, []);
  const renamed = compose(state, { verdict: "conditional", findings: [{ groups: ["G01"] }, { groups: ["G02"], title: "Final element skipped by loop bound" }] });
  includes(renamed.problems, "findings[0] and findings[1] look like the same defect; merge them into one finding with all locations, or retitle them to say how they differ");
});

test("the verdict must match the findings", () => {
  const state = setup({ ...one(), verdicts: { G01: confirmed() } });
  includes(compose(state, { verdict: "pass" }).problems, "verdict says pass but the findings give conditional");
  includes(compose(state, { verdict: null }).problems, "verdict must be one of pass, conditional, block; these findings give conditional");
  const report = compose(state, { verdict: "pass" }).report;
  assert.equal(report.statement, null);
});

test("run.runtime and run.mode must match the plan", () => {
  const agent = setup({ ...one(), verdicts: { G01: confirmed() } });
  includes(compose(agent, { verdict: "conditional", run: { runtime: "codex", mode: "single-agent" } }).problems, "run.mode must be multi-agent for this plan; a multi-agent run is never replaced by a solo one unless the user asked for a solo review");
  includes(compose(agent, { verdict: "conditional", run: { mode: "multi-agent" } }).problems, "run.runtime is missing; name the runtime, such as claude-code, codex, pi or kimi");
  const solo = setup({ solo: true, byJob: { "c01-all-p1": [candidate()] } });
  includes(compose(solo, { verdict: "conditional", run: { runtime: "codex", mode: "multi-agent" } }).problems, "run.mode must be single-agent for this plan");
});

test("author claims need a status and evidence for checked or contradicted claims", () => {
  const state = setup();
  const problems = compose(state, {
    claims: [
      { claim: "The loop visits every element.", status: null, evidence: null },
      { claim: "Tests cover it.", status: "checked", evidence: null },
      { claim: "No API change.", status: "unchecked", evidence: null },
      { status: "contradicted", evidence: "src/app.js:3" },
    ],
  }).problems;
  assert.deepEqual(problems, [
    "claims[0].status must be one of checked, unchecked, contradicted",
    "claims[1] needs evidence for a checked claim",
    "claims[3].claim is missing",
  ]);
});

test("a multi-agent run cannot claim self verification", () => {
  const state = setup({ ...one(), verdicts: { G01: confirmed() } });
  const problems = compose(state, { verdict: "conditional", findings: [{ groups: ["G01"], status: "confirmed", confidence: "high", verification: { verifier: "self", checked: ["read src/app.js:10"] } }] }).problems;
  includes(problems, "findings[0]: this run used verifier agents, so verification.verifier cannot be self");
});

test("a cited refutation must be dropped or kept with a conflict block", () => {
  const state = setup({ ...one(), verdicts: { G01: { status: "refuted", confidence: "high", checked: ["read src/app.js:12"], refutation: "src/app.js:12 already clamps the bound" } } });
  includes(compose(state).problems, "findings[0]: verify-G01 refuted G01 (src/app.js:12 already clamps the bound); move it to dropped, or set status and add a conflict block quoting both claims");
  const kept = { groups: ["G01"], status: "confirmed", confidence: "high" };
  includes(compose(state, { verdict: "conditional", findings: [kept] }).problems, "findings[0]: verify-G01 refuted G01 (src/app.js:12 already clamps the bound); keeping it needs a conflict block quoting both claims");
  const conflict = { claims: ["finder: the loop stops one short", "verifier: src/app.js:12 clamps the bound"], resolution: "src/app.js:12 runs after the loop, so the clamp is too late" };
  const settled = compose(state, { verdict: "conditional", findings: [{ ...kept, conflict }] });
  assert.deepEqual(settled.problems, []);
  assert.equal(settled.report.findings[0].verification.refutation, "src/app.js:12 already clamps the bound");
  const dropped = compose(state, { findings: [], dropped: [{ group: "G01", reason: "refuted by verify-G01" }] });
  assert.deepEqual(dropped.problems, []);
  assert.deepEqual(dropped.report.dropped, [{ group: "G01", title: "Off by one in the loop bound", reason: "refuted by verify-G01", conflict: null }]);
});

test("an uncited refutation leaves the finding open", () => {
  const state = setup({ ...one(), verdicts: { G01: { status: "refuted", confidence: "medium", checked: ["read the caller"], refutation: "callers never pass an empty list" } } });
  const { report, problems } = compose(state);
  assert.deepEqual(problems, []);
  assert.deepEqual([report.findings[0].status, report.findings[0].confidence, report.findings[0].verification.note], ["needs_verification", "low", "the verifier's refutation cited no file:line, so the finding stays open"]);
});

test("groups without a verdict stay open with the reason", () => {
  const capped = setup({ byJob: { "c01-correctness-p1": [candidate(), candidate({ title: "Cache never expires", severity: "low", ...at("src/util.js", 50) })] }, verdicts: { G01: confirmed() }, verifierCap: 1 });
  const { report, problems } = compose(capped, { verdict: "conditional" });
  assert.deepEqual(problems, []);
  assert.deepEqual(report.findings[1].verification, { verifier: null, checked: [], refutation: null, question: null, note: "not verified: the group was over the verifier cap" });
  assert.ok(report.coverage.not_reviewed.includes("group G02 was not verified: over the verifier cap"));
  const failed = setup({ ...one(), verdicts: { G01: { failed: "the verifier ran out of time" } } });
  assert.equal(compose(failed).report.findings[0].verification.note, "the verifier failed: the verifier ran out of time");
});

test("a location outside the changed files needs pre_existing", () => {
  const state = setup({ ...one({ ...at("src/other.js", 4) }), verdicts: { G01: confirmed() } });
  includes(compose(state, { verdict: "conditional" }).problems, "findings[0]: no location is in a changed file; mark it pre_existing or point at the changed code that causes it");
  const marked = compose(state, { findings: [{ groups: ["G01"], pre_existing: true }] });
  assert.deepEqual(marked.problems, []);
  assert.deepEqual(marked.report.pre_existing.map((finding) => finding.id), ["correctness-1"]);
  const renamed = setup({ ...one({ ...at("src/old.js", 4) }), files: [{ path: "src/new.js", old_path: "src/old.js" }], verdicts: { G01: confirmed() } });
  assert.deepEqual(compose(renamed, { verdict: "conditional" }).problems, []);
});

test("check problems are reported per location", () => {
  const state = setup({ ...one(), verdicts: { G01: confirmed() } });
  const problems = compose(state, { verdict: "conditional" }, () => "src/app.js:10 is past the end of the file, which has 5 lines at the head").problems;
  includes(problems, "findings[0].locations[0]: src/app.js:10 is past the end of the file, which has 5 lines at the head");
});

test("a confirmed finding cannot lead its required action with a vague verb", () => {
  const state = setup({ ...one({ required_action: "Ensure the bound is right." }), verdicts: { G01: confirmed() } });
  includes(compose(state, { verdict: "conditional" }).problems, "findings[0]: required_action starts with a vague verb; name the concrete change");
  const note = setup({ ...one({ severity: "note", required_action: "Consider a clearer name." }), verdicts: { G01: confirmed() } });
  assert.deepEqual(compose(note).problems, []);
});

test("self verification must set status in a single-agent run", () => {
  const state = setup({ solo: true, byJob: { "c01-all-p1": [candidate()] } });
  includes(compose(state, { verdict: "conditional" }).problems, "findings[0]: set status, confidence and verification; in this run the session verifies its own findings");
  const done = compose(state, { verdict: "conditional", findings: [{ groups: ["G01"], status: "confirmed", confidence: "medium", verification: { verifier: "self", checked: ["read src/app.js:10"] } }] });
  assert.deepEqual(done.problems, []);
  assert.equal(done.report.run.mode, "single-agent");
});

test("coverage needs a read for every changed file", () => {
  const state = setup({ files: [{ path: "src/app.js" }, { path: "src/util.js" }, { path: "src/extra.js" }, { path: "yarn.lock", excluded: true, exclude_reason: "lockfile", tier: "low" }] });
  const problems = compose(state, { coverage: { files: [{ path: "src/ghost.js", read: "full" }, { path: "src/util.js", read: "skipped" }], executed: [{ command: "npm test" }] } }).problems;
  assert.deepEqual(problems.sort(), [
    "coverage.executed[0] needs the command and its exit code",
    "coverage.files names src/ghost.js, which is not part of this review",
    "coverage.files[1] skips src/util.js without a reason",
  ].sort());
  const fixed = setup({ files: [{ path: "src/app.js" }, { path: "src/util.js" }, { path: "src/extra.js" }, { path: "yarn.lock", excluded: true, exclude_reason: "lockfile", tier: "low" }] });
  const { report } = compose(fixed, { coverage: { files: [{ path: "src/extra.js", read: "skipped", reason: "too large to read" }], executed: [] } });
  assert.deepEqual(report.coverage.files.map((file) => [file.path, file.read, file.reason]), [
    ["src/app.js", "full", null],
    ["src/util.js", "full", null],
    ["src/extra.js", "skipped", "too large to read"],
    ["yarn.lock", "skipped", "lockfile"],
  ]);
});

test("findings get ids per reviewer domain in severity, status, confidence and location order", () => {
  const state = setup({
    byJob: {
      "c01-correctness-p1": [candidate({ severity: "high", title: "Null dereference on empty input", ...at("src/app.js", 40) }), candidate({ title: "Loop bound skips final element", ...at("src/app.js", 10) })],
      "c01-security-p1": [candidate({ lens: "security", severity: "high", title: "Token logged in plain text", ...at("src/util.js", 5) })],
      "c01-contracts-p1": [candidate({ lens: "contracts", severity: "low", title: "Return type widened silently", ...at("src/util.js", 30) }), candidate({ lens: "contracts", severity: "note", title: "Helper name hides intent", ...at("src/util.js", 60) })],
      "c01-tests-p1": [candidate({ lens: "tests", title: "Retry counter resets each call", ...at("src/app.js", 80) })],
    },
    verdicts: { G01: confirmed(), G02: open(), G03: confirmed(), G04: confirmed({ pre_existing: true }), G05: confirmed({ confidence: "medium" }), G06: confirmed({ confidence: "medium" }) },
  });
  assert.deepEqual(state.candidates.groups.map((group) => group.title), ["Null dereference on empty input", "Token logged in plain text", "Loop bound skips final element", "Retry counter resets each call", "Return type widened silently", "Helper name hides intent"]);
  const { report, problems } = compose(state, { verdict: "block" });
  assert.deepEqual(problems, []);
  const ids = (list) => list.map((finding) => [finding.id, finding.title]);
  assert.deepEqual(ids(report.findings), [["correctness-1", "Null dereference on empty input"], ["security-1", "Token logged in plain text"], ["correctness-2", "Loop bound skips final element"], ["ux-api-1", "Return type widened silently"]]);
  assert.deepEqual(ids(report.notes), [["ux-api-2", "Helper name hides intent"]]);
  assert.deepEqual(ids(report.pre_existing), [["tests-qa-1", "Retry counter resets each call"]]);
  assert.deepEqual(report.counts, { confirmed: { blocker: 0, high: 1, medium: 1, low: 1 }, needs_verification: 1, notes: 1, pre_existing: 1, dropped: 0, groups: 6, candidates: 6, excluded_candidates: 0 });
  assert.equal(report.statement, "Blocked by 1 confirmed blocker or high finding: correctness-1 (high).");
});

test("block and conditional statements list the findings that decide them", () => {
  const block = setup({
    byJob: { "c01-correctness-p1": [candidate({ severity: "blocker", title: "Data loss on save" }), candidate({ severity: "high", title: "Crash on empty list", ...at("src/util.js", 50) })] },
    verdicts: { G01: confirmed(), G02: confirmed() },
  });
  assert.equal(compose(block, { verdict: "block" }).report.statement, "Blocked by 2 confirmed blocker or high findings: correctness-1 (blocker) and correctness-2 (high).");
  const conditional = setup({
    byJob: { "c01-correctness-p1": [candidate({ title: "Loop bound skips final element" }), candidate({ severity: "high", title: "Token logged in plain text", ...at("src/util.js", 5) })] },
    verdicts: { G01: open(), G02: confirmed() },
  });
  assert.equal(compose(conditional, { verdict: "conditional" }).report.statement, "Conditional: fix correctness-2 (medium) and settle the unverified correctness-1 (high) with evidence before merging.");
});

test("the pass statement names coverage, gaps and what it does not warrant", () => {
  const state = setup({ ...one({ severity: "low" }), verdicts: { G01: confirmed() } });
  assert.equal(
    compose(state, { coverage: { files: [], executed: [{ command: "npm test", exit: 0, where: "head" }] } }).report.statement,
    "No confirmed blocker, high or medium defect was found in 2 of 2 changed files by the correctness, security, contracts and tests lenses at the standard level. This pass does not warrant runtime behavior beyond the 1 command listed under executed; defects of the kinds the errors, concurrency, data, release, performance, redundancy and architecture lenses look for; code outside this diff, except where a finding names it.",
  );
  const gaps = setup({ ...one(), verdicts: { G01: open() }, failed: { "c01-tests-p1": "timed out" } });
  const gapped = compose(gaps, { coverage: { files: [{ path: "src/util.js", read: "skipped", reason: "vendored by hand" }] } }).report;
  assert.equal(
    gapped.statement,
    "No confirmed blocker, high or medium defect was found in 1 of 2 changed files by the correctness, security and contracts lenses at the standard level. This pass does not warrant runtime behavior, because no tests or builds were run; the 1 changed file that was not read (src/util.js); defects of the kinds the errors, concurrency, data, release, tests, performance, redundancy and architecture lenses look for; the 1 open question under needs verification; code outside this diff, except where a finding names it.",
  );
  assert.deepEqual(gapped.coverage.lenses.find((lens) => lens.lens === "tests"), { lens: "tests", status: "failed", jobs: 1, failed: 1, chunks: 1 });
  assert.deepEqual(gapped.coverage.lenses.find((lens) => lens.lens === "errors"), { lens: "errors", status: "not run", jobs: 0, failed: 0, reason: "not part of the standard level" });
  assert.deepEqual(gapped.coverage.not_reviewed, ["finder job c01-tests-p1 failed: timed out", "src/util.js: vendored by hand"]);
  const solo = setup({ solo: true });
  assert.equal(
    compose(solo).report.statement,
    "No confirmed blocker, high or medium defect was found in 2 of 2 changed files by the correctness, errors, concurrency, security, data, contracts, release, tests, performance, redundancy and architecture lenses at the quick level in a single-agent run, whose finders and verifiers were not independent. This pass does not warrant runtime behavior, because no tests or builds were run; code outside this diff, except where a finding names it.",
  );
});

test("lens coverage explains lenses a deep plan did not route", () => {
  const state = setup({ level: "deep" });
  const lens = compose(state).report.coverage.lenses.find((item) => item.lens === "data");
  assert.equal(lens.reason, "no changed file carried a signal that routes to it");
});

test("reviewTemplate drops cited refutations and lists every other group", () => {
  const state = setup({
    byJob: { "c01-correctness-p1": [candidate(), candidate({ title: "Cache never expires", ...at("src/util.js", 50) }), candidate({ title: "Slow path taken", ...at("src/util.js", 90) })] },
    verdicts: { G01: { status: "refuted", confidence: "high", checked: ["x"], refutation: "src/app.js:12 clamps it" }, G02: { status: "refuted", confidence: "high", checked: ["x"], refutation: "not reachable" }, G03: confirmed() },
  });
  assert.deepEqual(reviewTemplate({ ...state, intent: INTENT, digest: "d1" }), {
    digest: "d1",
    verdict: null,
    run: { runtime: null, mode: "multi-agent" },
    findings: [{ groups: ["G02"] }, { groups: ["G03"] }],
    dropped: [{ group: "G01", reason: "refuted by verify-G01: src/app.js:12 clamps it" }],
    claims: [{ claim: "The loop visits every element.", status: null, evidence: null }],
    shallow_wrappers: [],
    quick_wins: [],
    accepted_risks: [],
    open_questions: [],
    coverage: { files: [], not_reviewed: [], executed: [] },
  });
  assert.equal(reviewTemplate({ ...setup({ solo: true }), intent: null }).run.mode, "single-agent");
});

test("a finding the session found itself stays open in a multi-agent run", () => {
  const state = setup();
  const own = {
    groups: [],
    origin: "a topic c01-security-p1 declined",
    title: "Lock taken twice on retry",
    severity: "high",
    trigger: "A retry after a timeout.",
    observed: "The retry takes the lock while it is still held.",
    expected: "The retry reuses the held lock.",
    required_action: "Release the lock before the retry.",
    locations: [{ file: "src/app.js", line: 20 }],
  };
  const { report, problems } = compose(state, { verdict: "conditional", findings: [own] });
  assert.deepEqual(problems, []);
  assert.deepEqual([report.findings[0].status, report.findings[0].confidence, report.findings[0].verification.note], ["needs_verification", "low", "found during the review, not by a lane, so no fresh verifier checked it"]);
  includes(compose(state, { verdict: "block", findings: [{ ...own, status: "confirmed", confidence: "high" }] }).problems, "findings[0]: no lane found it and no fresh verifier checked it, so in a multi-agent run it stays needs_verification");
});

test("confirming a group its verifier left open needs a conflict block", () => {
  const state = setup({ ...one(), verdicts: { G01: open({ question: "Does any caller pass a one-element list?" }) } });
  const upgrade = { groups: ["G01"], status: "confirmed", confidence: "medium" };
  includes(compose(state, { verdict: "conditional", findings: [upgrade] }).problems, "findings[0]: verify-G01 could not settle G01; confirming it needs a conflict block quoting both claims and the evidence that settles it");
  const conflict = { claims: ["verify-G01: no caller was shown to pass one element", "review: src/cli.js:8 passes the parsed argument list"], resolution: "src/cli.js:8 calls run([arg]) with one argument" };
  const settled = compose(state, { verdict: "conditional", findings: [{ ...upgrade, conflict }] });
  assert.deepEqual(settled.problems, []);
  assert.equal(settled.report.findings[0].verification.question, "Does any caller pass a one-element list?");
  const uncited = setup({ ...one(), verdicts: { G01: { status: "refuted", confidence: "medium", checked: ["read the caller"], refutation: "callers never pass one element" } } });
  includes(compose(uncited, { verdict: "conditional", findings: [upgrade] }).problems, "findings[0]: verify-G01 refuted G01 without citing a file:line; confirming it needs a conflict block quoting both claims and the evidence that settles it");
  const capped = setup({ byJob: { "c01-correctness-p1": [candidate(), candidate({ title: "Cache never expires", ...at("src/util.js", 50) })] }, verdicts: { G01: confirmed() }, verifierCap: 1 });
  includes(
    compose(capped, { verdict: "conditional", findings: [{ groups: ["G01"] }, { groups: ["G02"], status: "confirmed", confidence: "high" }] }).problems,
    "findings[1]: no verifier result exists for G02 (over the verifier cap), so in a multi-agent run it stays needs_verification",
  );
});

test("a severity the review changes needs a reason and joins the trail", () => {
  const state = setup({ ...one({ severity: "high" }), verdicts: { G01: confirmed({ severity: "medium", reason: "Only the export path reaches it." }) } });
  const derived = compose(state, { verdict: "conditional" });
  assert.deepEqual(derived.problems, []);
  const [finding] = derived.report.findings;
  assert.deepEqual([finding.severity, finding.severity_reason, finding.severity_trail], ["medium", "Only the export path reaches it.", ["c01-correctness-p1: high", "verify-G01: medium"]]);
  includes(compose(state, { findings: [{ groups: ["G01"], severity: "low" }] }).problems, "findings[0]: severity low differs from the verifier's medium; set severity_reason to say why");
  const conflict = { claims: ["verify-G01: medium", "review: low"], resolution: "src/flags.js:3 keeps the export path off" };
  const lowered = compose(state, { findings: [{ groups: ["G01"], severity: "low", severity_reason: "The export path sits behind a flag that is off.", conflict }] });
  assert.deepEqual(lowered.problems, []);
  assert.deepEqual(lowered.report.findings[0].severity_trail, ["c01-correctness-p1: high", "verify-G01: medium", "review: low"]);
  const finders = setup({ ...one(), verdicts: { G01: confirmed() } });
  includes(compose(finders, { verdict: "block", findings: [{ groups: ["G01"], severity: "high" }] }).problems, "findings[0]: severity high differs from the finders' medium; set severity_reason to say why");
});

test("a group sits in one finding and is dropped at most once", () => {
  const state = setup({ ...one(), verdicts: { G01: confirmed() } });
  includes(compose(state, { verdict: "conditional", findings: [{ groups: ["G01"] }, { groups: ["G01"], title: "Second copy" }] }).problems, "group G01 is in findings[0] and findings[1]; list it in one finding");
  includes(compose(state, { findings: [], dropped: [{ group: "G01", reason: "a" }, { group: "G01", reason: "b" }] }).problems, "dropped[1]: group G01 is already dropped");
});

test("duplicate findings are named by their index in review.json", () => {
  const state = setup({
    byJob: { "c01-correctness-p1": [candidate({ title: "Loop bound skips final element" })], "c01-tests-p1": [candidate({ lens: "tests", title: "Coverage gap for single items", ...at("src/app.js", 12) })] },
    verdicts: { G01: confirmed(), G02: confirmed() },
  });
  const problems = compose(state, { verdict: "conditional", findings: ["junk", { groups: ["G01"] }, { groups: ["G02"], title: "Final element skipped by loop bound" }] }).problems;
  includes(problems, "findings[0] is not an object");
  includes(problems, "findings[1] and findings[2] look like the same defect; merge them into one finding with all locations, or retitle them to say how they differ");
});

test("a review whose finder jobs all failed cannot reach a verdict", () => {
  const state = setup({ failed: Object.fromEntries(CORE_JOBS.map((job) => [job.id, "timed out"])) });
  const skipped = { files: ["src/app.js", "src/util.js"].map((file) => ({ path: file, read: "skipped", reason: "no finder finished" })) };
  includes(compose(state, { coverage: skipped }).problems, "every finder job failed, so nothing was reviewed; submit their outputs again");
});

test("a failed ledger and a failed verifier are listed as not reviewed", () => {
  const state = setup({ ...one(), verdicts: { G01: { failed: "the verifier ran out of time" } } });
  const { report, problems } = compose({ ...state, ledger: { failed: "the tree was missing" } });
  assert.deepEqual(problems, []);
  assert.deepEqual(report.coverage.not_reviewed, ["the ledger job failed: the tree was missing", "group G01 was not verified: the verifier failed: the verifier ran out of time"]);
});

test("the saved review shows the verifier's question and the severity reason", () => {
  const state = setup({ ...one({ severity: "high" }), verdicts: { G01: open({ severity: "medium", reason: "Only the export path reaches it.", question: "Does the export path run in production?" }) } });
  const { report, problems } = compose(state);
  assert.deepEqual(problems, []);
  const markdown = renderMarkdown(report, state.scope);
  assert.match(markdown, /^- Open question: Does the export path run in production\?\n- Required action, if confirmed: Change the bound from length - 1 to length\.$/m);
  assert.match(markdown, /^- Severity trail: c01-correctness-p1: high, verify-G01: medium\.\n- Severity reason: Only the export path reaches it\.$/m);
});
