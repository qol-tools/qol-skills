import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after } from "node:test";
import { EXIT, ReviewError } from "../src/errors.mjs";
import { runNext } from "../src/next.mjs";
import { runScope } from "../src/scope.mjs";
import { LENS_NAMES } from "../src/lenses.mjs";
import { ENV, candidate, catching, commit, depsFor, finderOutput, makeRepo, numbered, readJson, tempRoot, verifierResult, writeFinds, writeJson, test } from "./engine-helpers.mjs";

const root = tempRoot();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const INTENT = { source: "stated", summary: "Grow the file. Nothing else changes.", requirements: ["Keep the old lines."], claims: ["Only lines are added."] };
const next = (scope) => runNext(scope.run_dir, { env: ENV });

function scoped(name, files, options = {}) {
  const dir = makeRepo(root, name);
  commit(dir, { "src/app.js": numbered(20), "src/auth/session.js": numbered(5) }, "base");
  const head = commit(dir, files, "change");
  return runScope(head, options, depsFor(dir, path.join(root, `${name}-out`)));
}

function failing(scope) {
  const error = catching(() => next(scope));
  assert.ok(error instanceof ReviewError);
  assert.equal(error.code, EXIT.contract);
  assert.deepEqual(error.problems, error.report.problems);
  return error;
}

const file = (scope, name) => path.join(scope.run_dir, name);
const confirmed = (scope, group) => verifierResult(scope, group, { status: "confirmed", confidence: "high", checked: ["read src/app.js:30"] });

function finishReview(scope, edit) {
  const template = readJson(file(scope, "review.template.json"));
  const review = { ...template, run: { ...template.run, runtime: "claude-code" }, claims: template.claims.map((claim) => ({ ...claim, status: "checked", evidence: "the diff only adds lines" })), coverage: { ...template.coverage, executed: [{ command: "node --test", exit: 0, where: "head" }] } };
  writeJson(file(scope, "review.json"), edit(review));
}

test("a standard review walks intent, find, verify, review and done", () => {
  const scope = scoped("standard", { "src/app.js": numbered(60) });
  assert.equal(scope.level.used, "standard");
  const intent = next(scope);
  assert.deepEqual({ stage: intent.stage, write: intent.write, sources: intent.sources, jobs: intent.jobs }, { stage: "intent", write: file(scope, "intent.json"), sources: file(scope, "intent-sources.md"), jobs: [] });
  writeJson(file(scope, "intent.json"), { source: "stated" });
  assert.deepEqual(failing(scope).report.problems, ['intent.summary is missing; write the intent in two sentences, or "no stated intent"', "intent.requirements must be a list of sentences (it may be empty)"]);
  writeJson(file(scope, "intent.json"), INTENT);
  const find = next(scope);
  assert.equal(find.stage, "find");
  assert.equal(find.done, 0);
  assert.deepEqual(find.jobs.map((job) => job.id), ["c01-correctness-p1", "c01-security-p1", "c01-contracts-p1", "c01-tests-p1"]);
  const [first] = find.jobs;
  assert.deepEqual({ kind: first.kind, lenses: first.lenses, chunk: first.chunk, pass: first.pass, descriptor: first.descriptor, output: first.output }, { kind: "finder", lenses: ["correctness"], chunk: "c01", pass: 1, descriptor: file(scope, "jobs/c01-correctness-p1.json"), output: file(scope, "finds/c01-correctness-p1.json") });
  assert.equal(first.prompt, `You are a code-review engine finder lane. Read the job file ${first.descriptor} first, then the instructions file it names, and follow those instructions exactly. You can only read files. Reply with the result JSON object alone: no prose and no code fence.`);
  assert.deepEqual([first.reviewer, first.submit], ["correctness-reviewer", `submit ${scope.run_dir} c01-correctness-p1 --agent-id <agent id>`]);
  writeJson(file(scope, "finds/c01-correctness-p1.json"), finderOutput(scope, scope.plan.jobs[0], [candidate({ locations: [{ file: "src/app.js", line: 30 }] }), candidate({ title: "Past the end", locations: [{ file: "src/app.js", line: 61 }] })]));
  const partial = next(scope);
  assert.deepEqual([partial.stage, partial.done, partial.jobs.length], ["find", 1, 3]);
  writeJson(file(scope, "finds/c01-security-p1.json"), { job: "c01-tests-p1", candidates: [], files_read: [], declined: [] });
  assert.deepEqual(failing(scope).report.problems, ['c01-security-p1: the output names job "c01-tests-p1"']);
  fs.writeFileSync(file(scope, "finds/c01-security-p1.json"), "{ nope");
  assert.match(failing(scope).report.problems[0], /c01-security-p1\.json is not valid JSON/);
  writeFinds({ ...scope, plan: { ...scope.plan, jobs: scope.plan.jobs.slice(1) } });
  const verify = next(scope);
  assert.deepEqual({ stage: verify.stage, done: verify.done, unverified: verify.unverified, ids: verify.jobs.map((job) => job.id) }, { stage: "verify", done: 0, unverified: [], ids: ["verify-G01"] });
  assert.equal(verify.jobs[0].output, file(scope, "verify/G01.result.json"));
  const candidates = readJson(file(scope, "candidates.json"));
  assert.deepEqual([candidates.final, candidates.stats.received, candidates.stats.excluded, candidates.stats.excluded_by_reason], [true, 2, 1, { "line past the end of the file": 1 }]);
  assert.equal(readJson(file(scope, "verify/G01.json")).instructions.endsWith("engine-verifier-prompt.md"), true);
  verifierResult(scope, "G01", { status: "confirmed", confidence: "low", checked: ["x"] });
  assert.deepEqual(failing(scope).report.problems, ["G01: a confirmed finding needs high or medium confidence"]);
  confirmed(scope, "G01");
  const review = next(scope);
  assert.deepEqual({ stage: review.stage, template: review.template, write: review.write, groups: review.groups, excluded: review.excluded }, { stage: "review", template: file(scope, "review.template.json"), write: file(scope, "review.json"), groups: 1, excluded: 1 });
  assert.deepEqual(readJson(review.template).findings, [{ groups: ["G01"] }]);
  finishReview(scope, (value) => ({ ...value, verdict: "pass" }));
  const problem = failing(scope);
  assert.equal(problem.report.stage, "review");
  assert.deepEqual(problem.report.problems, ["verdict says pass but the findings give conditional"]);
  assert.equal(problem.message, "1 problem in the review stage");
  finishReview(scope, (value) => ({ ...value, verdict: "conditional" }));
  const done = next(scope);
  assert.deepEqual(
    { stage: done.stage, verdict: done.verdict, statement: done.statement, findings: done.findings, pr: done.pr },
    { stage: "done", verdict: "conditional", statement: "Conditional: fix correctness-1 (medium) before merging.", findings: [{ id: "correctness-1", severity: "medium", status: "confirmed", location: { side: "head", file: "src/app.js", line: 30 }, title: "Off by one in the loop bound" }], pr: null },
  );
  assert.equal(fs.existsSync(file(scope, "review.template.json")), false);
  const report = readJson(file(scope, "report.json"));
  assert.deepEqual(report.files, { markdown: file(scope, "review.md"), summary: file(scope, "summary.json"), report: file(scope, "report.json") });
  assert.match(done.review, /code-review\/[^/]+\/review\.md$|review\.md$/);
  assert.match(fs.readFileSync(done.review, "utf8"), /^- Verdict: \*\*conditional\*\*\. Conditional: fix correctness-1 \(medium\) before merging\.$/m);
  assert.equal(readJson(done.summary).verdict, "conditional");
  assert.match(done.next_step, /fix the findings now: correctness-1/);
  const again = next(scope);
  assert.deepEqual({ stage: again.stage, verdict: again.verdict, findings: again.findings, review: again.review }, { stage: done.stage, verdict: done.verdict, findings: done.findings, review: done.review });
  writeJson(file(scope, "finds/c01-tests-p1.json"), finderOutput(scope, scope.plan.jobs[3], [candidate({ lens: "tests", title: "No test for the new lines", locations: [{ file: "src/app.js", line: 50 }] })]));
  const changed = next(scope);
  assert.deepEqual([changed.stage, changed.jobs.map((job) => job.id), changed.pruned], ["verify", ["verify-G01", "verify-G02"], ["G01"]]);
  assert.equal(fs.existsSync(file(scope, "report.json")), false);
});

test("a deep review runs the ledger first and skips verify when nothing was found", () => {
  const scope = scoped("deep", { "src/auth/session.js": numbered(15) });
  assert.equal(scope.level.used, "deep");
  assert.deepEqual(scope.plan.ledger, { id: "ledger", kind: "ledger", items: ["src/auth/session.js"] });
  assert.ok(fs.existsSync(file(scope, "context.json")));
  writeJson(file(scope, "intent.json"), INTENT);
  const ledger = next(scope);
  assert.equal(ledger.stage, "ledger");
  assert.deepEqual(ledger.jobs.map((job) => [job.id, job.kind, job.output]), [["ledger", "ledger", file(scope, "ledger.json")]]);
  assert.match(ledger.jobs[0].prompt, /Reply with the result JSON object alone: no prose and no code fence\.$/);
  assert.equal(ledger.jobs[0].reviewer, "architecture-reviewer");
  writeJson(file(scope, "ledger.json"), { agent_id: "agent-ledger", entries: [{ file: "src/other.js", assumptions: [{ assumption: "callers pass a user" }] }] });
  assert.deepEqual(failing(scope).report.problems, ["ledger.entries[0].assumptions[0] needs enforced_at as file:line or a question", "ledger has no entry for high-risk file src/auth/session.js"]);
  writeJson(file(scope, "ledger.json"), { agent_id: "agent-ledger", entries: [{ file: "src/auth/session.js", assumptions: [{ assumption: "callers pass a user", enforced_at: "src/auth/session.js:3" }] }] });
  const find = next(scope);
  assert.equal(find.stage, "find");
  assert.equal(find.jobs.length, scope.plan.jobs.length);
  assert.equal(readJson(find.jobs[0].descriptor).inputs.ledger, file(scope, "ledger.json"));
  writeFinds(scope);
  const review = next(scope);
  assert.deepEqual([review.stage, review.groups], ["review", 0]);
  finishReview(scope, (value) => ({ ...value, verdict: "pass" }));
  const done = next(scope);
  assert.equal(done.verdict, "pass");
  assert.match(done.statement, /^No confirmed blocker, high or medium defect was found in 1 of 1 changed files by the correctness, security, contracts and tests lenses at the deep level\./);
});

test("a max review merges before the hunt and again after it", () => {
  const scope = scoped("max", { "src/app.js": numbered(60) }, { level: "max" });
  assert.deepEqual([scope.plan.jobs.length, scope.plan.hunt, scope.plan.ledger, scope.plan.ledger_skipped], [LENS_NAMES.length * 5, { id: "hunt", kind: "hunt" }, null, "no high-risk file to build a ledger for"]);
  writeJson(file(scope, "intent.json"), INTENT);
  writeFinds(scope, { "c01-correctness-p1": [candidate({ locations: [{ file: "src/app.js", line: 30 }] })] });
  const hunt = next(scope);
  assert.deepEqual({ stage: hunt.stage, ids: hunt.jobs.map((job) => job.id), candidates: hunt.candidates, groups: hunt.groups }, { stage: "hunt", ids: ["hunt"], candidates: file(scope, "candidates.json"), groups: 1 });
  assert.equal(readJson(file(scope, "candidates.json")).final, false);
  assert.equal(readJson(hunt.jobs[0].descriptor).inputs.candidates, file(scope, "candidates.json"));
  assert.equal(next(scope).stage, "hunt");
  writeJson(file(scope, "finds/hunt.json"), { job: "hunt", agent_id: "agent-hunt", candidates: [candidate({ lens: "performance", title: "Quadratic scan of every line", locations: [{ file: "src/app.js", line: 45 }] })], files_read: [{ path: "src/app.js", read: "full" }], declined: [] });
  const verify = next(scope);
  assert.deepEqual([verify.stage, verify.jobs.map((job) => job.id)], ["verify", ["verify-G01", "verify-G02"]]);
  const merged = readJson(file(scope, "candidates.json"));
  assert.equal(merged.final, true);
  assert.deepEqual(merged.groups.map((group) => group.found_by), [["c01-correctness-p1"], ["hunt"]]);
  confirmed(scope, "G01");
  fs.rmSync(file(scope, "finds/hunt.json"));
  const rewound = next(scope);
  assert.deepEqual([rewound.stage, readJson(file(scope, "candidates.json")).final, fs.existsSync(file(scope, "verify/G01.result.json"))], ["hunt", false, true]);
  writeJson(file(scope, "finds/hunt.json"), { job: "hunt", agent_id: "agent-hunt", candidates: [candidate({ lens: "performance", title: "Quadratic scan of every line", locations: [{ file: "src/app.js", line: 45 }] })], files_read: [{ path: "src/app.js", read: "full" }], declined: [] });
  const merged2 = next(scope);
  assert.deepEqual([merged2.stage, merged2.pruned], ["verify", []]);
  verifierResult(scope, "G02", { status: "refuted", confidence: "high", checked: ["read src/app.js:45"], refutation: "src/app.js:45 runs once per file" });
  assert.equal(next(scope).stage, "review");
  assert.deepEqual(readJson(file(scope, "review.template.json")).dropped, [{ group: "G02", reason: "refuted by verify-G02: src/app.js:45 runs once per file" }]);
  finishReview(scope, (value) => ({ ...value, verdict: "conditional" }));
  const done = next(scope);
  assert.deepEqual([done.stage, done.verdict, done.counts.medium, done.findings.map((finding) => finding.id)], ["done", "conditional", 1, ["correctness-1"]]);
  assert.deepEqual(readJson(done.summary).agent_board.map((item) => [item.reviewer, item.job]).slice(-3), [["adversarial-reviewer", "hunt"], ["adversarial-reviewer", "verify-G01"], ["adversarial-reviewer", "verify-G02"]]);
});

test("a quick review runs one all-lens finder job and verifies by agent", () => {
  const scope = scoped("quick", { "src/app.js": numbered(25) });
  assert.deepEqual([scope.level.used, scope.plan.solo, scope.plan.verify, scope.plan.jobs.map((job) => job.id)], ["quick", false, "agent", ["c01-all-p1"]]);
  writeJson(file(scope, "intent.json"), INTENT);
  const find = next(scope);
  assert.deepEqual([find.stage, find.solo, find.jobs.map((job) => job.id)], ["find", false, ["c01-all-p1"]]);
  writeFinds(scope, { "c01-all-p1": [candidate({ lens: "errors", locations: [{ file: "src/app.js", line: 22 }] })] });
  assert.deepEqual(next(scope).jobs.map((job) => job.id), ["verify-G01"]);
  confirmed(scope, "G01");
  assert.equal(next(scope).stage, "review");
  finishReview(scope, (value) => ({ ...value, verdict: "conditional" }));
  const done = next(scope);
  assert.deepEqual([done.stage, done.verdict, done.findings[0].id], ["done", "conditional", "correctness-1"]);
});

test("a solo review verifies in the session without verifier jobs and records an empty agent board", () => {
  const scope = scoped("solo", { "src/app.js": numbered(25) }, { solo: true });
  assert.deepEqual([scope.level.used, scope.plan.solo, scope.plan.verify, scope.plan.jobs.map((job) => job.id)], ["quick", true, "self", ["c01-all-p1"]]);
  writeJson(file(scope, "intent.json"), INTENT);
  const find = next(scope);
  assert.deepEqual([find.stage, find.solo, find.jobs.map((job) => job.id)], ["find", true, ["c01-all-p1"]]);
  writeFinds(scope, { "c01-all-p1": [candidate({ lens: "errors", locations: [{ file: "src/app.js", line: 22 }] })] });
  const review = next(scope);
  assert.equal(review.stage, "review");
  assert.equal(fs.existsSync(file(scope, "verify")), false);
  const template = readJson(review.template);
  assert.equal(template.run.mode, "single-agent");
  finishReview(scope, (value) => ({ ...value, verdict: "pass" }));
  assert.deepEqual(failing(scope).report.problems, ["findings[0]: set status, confidence and verification; in this run the session verifies its own findings"]);
  finishReview(scope, (value) => ({ ...value, verdict: "conditional", findings: [{ groups: ["G01"], status: "confirmed", confidence: "medium", verification: { verifier: "self", checked: ["read src/app.js:22"] } }] }));
  const done = next(scope);
  assert.deepEqual([done.stage, done.verdict, done.findings[0].id], ["done", "conditional", "correctness-1"]);
  assert.deepEqual(readJson(done.summary).agent_board, []);
  assert.match(fs.readFileSync(done.review, "utf8"), /The session checked: read src\/app\.js:22\./);
});

test("next refuses a folder that is not a run", () => {
  const error = catching(() => runNext(path.join(root, "nowhere"), { env: ENV }));
  assert.equal(error.code, EXIT.input);
  assert.match(error.message, /is not a code-review engine run: scope\.json is missing$/);
});
