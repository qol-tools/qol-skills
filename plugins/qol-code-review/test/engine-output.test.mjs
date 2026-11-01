import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after } from "node:test";
import { runNext } from "../src/next.mjs";
import { runScope } from "../src/scope.mjs";
import { ENV, candidate, commit, depsFor, makeRepo, numbered, readJson, tempRoot, verifierResult, writeFinds, writeJson, test } from "./engine-helpers.mjs";

const root = tempRoot();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const INTENT = { source: "stated", summary: "Grow the file. Nothing else changes.", requirements: [], claims: ["Only lines are added."] };
const RUST = "pub fn real(value: &str) -> usize {\n    let size = value.len();\n    size + 1\n}\n";

function scoped(name, { base = { "src/app.js": numbered(20) }, head = { "src/app.js": numbered(60) }, options = { level: "standard" } } = {}) {
  const dir = makeRepo(root, name);
  commit(dir, base, "base");
  const sha = commit(dir, head, "change");
  const scope = runScope(sha, options, depsFor(dir, path.join(root, `${name}-out`)));
  writeJson(path.join(scope.run_dir, "intent.json"), INTENT);
  return scope;
}

const next = (scope) => runNext(scope.run_dir, { env: ENV });
const file = (scope, name) => path.join(scope.run_dir, name);

function toReview(scope, byJob, results = {}) {
  writeFinds(scope, byJob);
  next(scope);
  for (const [group, value] of Object.entries(results)) verifierResult(scope, group, value);
  return next(scope);
}

function answer(scope, edit = (value) => value) {
  const template = readJson(file(scope, "review.template.json"));
  writeJson(file(scope, "review.json"), edit({ ...template, run: { ...template.run, runtime: "claude-code" }, claims: template.claims.map((claim) => ({ ...claim, status: "checked", evidence: "the diff only adds lines" })), coverage: { ...template.coverage, executed: [{ command: "node --test", exit: 0, where: "head" }] } }));
  return next(scope);
}

const confirmed = { status: "confirmed", confidence: "high", checked: ["read src/app.js:30"] };

test("the saved review follows the review board shape and the writer's files", () => {
  const scope = scoped("shape");
  const review = toReview(
    scope,
    {
      "c01-correctness-p1": [candidate({ severity: "high", title: "Loop bound skips the final element", shape: "off-by-one-bound", locations: [{ file: "src/app.js", line: 30 }] })],
      "c01-security-p1": [candidate({ lens: "security", severity: "medium", title: "Token written to the log", locations: [{ file: "src/app.js", line: 40 }] }), candidate({ lens: "security", severity: "low", title: "Weak default timeout value", locations: [{ file: "src/app.js", line: 50 }] })],
      "c01-contracts-p1": [candidate({ lens: "contracts", severity: "note", title: "Helper name hides intent", locations: [{ file: "src/app.js", line: 55 }] })],
    },
    { G01: confirmed, G02: confirmed, G03: confirmed, G04: { ...confirmed, confidence: "medium" } },
  );
  assert.equal(review.stage, "review");
  const done = answer(scope, (value) => ({ ...value, verdict: "block", accepted_risks: ["The helper name stays as it is."] }));
  assert.equal(done.verdict, "block");
  const saved = path.dirname(done.review);
  assert.deepEqual(fs.readdirSync(saved).sort(), ["report.json", "review.md", "summary.json"]);
  const summary = readJson(path.join(saved, "summary.json"));
  assert.deepEqual(Object.keys(summary), ["verdict", "agent_board", "counts", "must_fix", "deferred_followups", "contextual_quick_wins", "shallow_wrappers", "accepted_risks", "verification"]);
  assert.equal(summary.verdict, "block");
  assert.deepEqual(summary.counts, { blocker: 0, high: 1, medium: 1, low: 1, note: 1 });
  assert.deepEqual(summary.must_fix.map((item) => [item.id, item.severity, item.file, item.line]), [["correctness-1", "high", "src/app.js", 30], ["security-1", "medium", "src/app.js", 40]]);
  assert.deepEqual(Object.keys(summary.must_fix[0]), ["id", "title", "severity", "confidence", "file", "line", "shape", "required_action"]);
  assert.equal(summary.must_fix[0].shape, "off-by-one-bound");
  assert.deepEqual(summary.deferred_followups.map((item) => [item.id, item.severity]), [["security-2", "low"]]);
  assert.deepEqual(summary.accepted_risks, ["The helper name stays as it is."]);
  assert.deepEqual(summary.verification, [{ command: "node --test", exit: 0, where: "head" }]);
  assert.ok(summary.agent_board.length >= 8);
  assert.deepEqual(summary.agent_board.find((item) => item.job === "c01-security-p1"), { reviewer: "security-reviewer", job: "c01-security-p1", agent_id: "agent-c01-security-p1", status: "completed" });
  assert.deepEqual(summary.agent_board.find((item) => item.job === "verify-G01"), { reviewer: "adversarial-reviewer", job: "verify-G01", agent_id: "agent-verify-G01", status: "completed" });
  const writer = readJson(path.join(saved, "report.json"));
  assert.deepEqual([writer.name, writer.status], ["code-review", "block"]);
  assert.match(writer.next[0], /fix the findings now: correctness-1, security-1, security-2/);
  const markdown = fs.readFileSync(done.review, "utf8");
  const headings = ["# Review board result:", "- Scope:", "- Verdict: **block**", "- Agent board:", "## Confirmed blockers", "## Confirmed high", "## Confirmed medium", "## Confirmed low", "## Notes", "## Contextual quick wins", "## Shallow wrappers", "## Must fix before commit", "## Deferred follow-ups", "## Risks now accepted by design", "## Verification commands", "## Open questions", "## Author claims", "## Coverage", "## Machine-parseable block"];
  let at = 0;
  for (const heading of headings) {
    const found = markdown.indexOf(heading, at);
    assert.ok(found >= 0, `${heading} after offset ${at}`);
    at = found;
  }
  assert.match(markdown, /### correctness-1 Loop bound skips the final element/);
  assert.match(markdown, /none \(detector ran on 0 files\)/);
  assert.match(markdown, /Agent ids|Every agent id is in the json block/);
  assert.deepEqual(JSON.parse(/```json\n([\s\S]*?)\n```/.exec(markdown)[1]), summary);
});

test("a pass review has empty work lists and a pass summary", () => {
  const scope = scoped("pass");
  toReview(scope, {});
  const done = answer(scope, (value) => ({ ...value, verdict: "pass" }));
  const summary = readJson(done.summary);
  assert.deepEqual([summary.verdict, summary.must_fix, summary.deferred_followups, summary.counts], ["pass", [], [], { blocker: 0, high: 0, medium: 0, low: 0, note: 0 }]);
  assert.match(done.next_step, /^open /);
});

test("a review missing an agent id is refused in a multi-agent run", () => {
  const scope = scoped("no-agent");
  toReview(scope, {});
  const output = readJson(file(scope, "finds/c01-security-p1.json"));
  delete output.agent_id;
  writeJson(file(scope, "finds/c01-security-p1.json"), output);
  const error = (() => {
    try {
      return answer(scope, (value) => ({ ...value, verdict: "pass" }));
    } catch (thrown) {
      return thrown;
    }
  })();
  assert.deepEqual(error.problems, ["c01-security-p1 has no agent id; submit its output with --agent-id"]);
});

test("every shallow wrapper the detector lists needs a disposition", () => {
  const scope = scoped("shallow-gate", { base: { "src/lib.rs": RUST }, head: { "src/lib.rs": `${RUST}\npub fn normalize(value: &str) -> String {\n    other::normalize(value)\n}\n` } });
  toReview(scope, {});
  const entry = scope.shallow.entries[0];
  const template = readJson(file(scope, "review.template.json"));
  assert.deepEqual(template.shallow_wrappers, [{ ...entry, disposition: null, reason: null }]);
  const problems = (edit) => {
    try {
      answer(scope, edit);
    } catch (thrown) {
      return thrown.problems;
    }
    return [];
  };
  const verdict = (value) => ({ ...value, verdict: "pass" });
  assert.deepEqual(problems(verdict), ["shallow wrapper src/lib.rs:6 (normalize) needs a disposition of delete or keep"]);
  assert.deepEqual(problems((value) => ({ ...verdict(value), shallow_wrappers: [{ ...entry, disposition: "keep" }] })), ["shallow wrapper src/lib.rs:6 (normalize) is kept without a reason"]);
  assert.deepEqual(problems((value) => ({ ...verdict(value), shallow_wrappers: [{ ...entry, disposition: "delete" }, { file: "src/other.rs", line: 1, disposition: "delete" }] })), ["shallow_wrappers names src/other.rs:1, which the detector did not list"]);
  const done = answer(scope, (value) => ({ ...verdict(value), shallow_wrappers: [{ ...entry, disposition: "delete" }] }));
  assert.deepEqual(readJson(done.summary).shallow_wrappers, [{ ...entry, disposition: "delete", reason: null }]);
  assert.match(fs.readFileSync(done.review, "utf8"), /^- src\/lib\.rs:6 normalize -> other::normalize: delete$/m);
});

test("quick wins are capped at five and each needs its fields", () => {
  const scope = scoped("quick-wins");
  toReview(scope, {});
  const wins = Array.from({ length: 6 }, (_, index) => ({ id: `quick-win-${index + 1}`, title: "Name the constant", file: "src/app.js", line: 3, action: "Extract the literal into a named constant." }));
  let thrown;
  try {
    answer(scope, (value) => ({ ...value, verdict: "pass", quick_wins: [...wins, { id: "x" }] }));
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown.problems.includes("7 quick wins exceed the cap of 5"));
  assert.ok(thrown.problems.includes("quick_wins[6].title is missing"));
  const done = answer(scope, (value) => ({ ...value, verdict: "pass", quick_wins: wins.slice(0, 2) }));
  assert.deepEqual(readJson(done.summary).contextual_quick_wins.map((item) => item.id), ["quick-win-1", "quick-win-2"]);
});

test("a review written for an earlier merge is refused", () => {
  const scope = scoped("old-review");
  toReview(scope, {});
  const template = readJson(file(scope, "review.template.json"));
  writeJson(file(scope, "review.json"), { ...template, digest: "stale", verdict: "pass", run: { ...template.run, runtime: "claude-code" } });
  let thrown;
  try {
    next(scope);
  } catch (error) {
    thrown = error;
  }
  assert.match(thrown.problems[0], /review\.json was written for an earlier merge of the finder outputs/);
});

test("next saves the review once and saves it again when the saved copy is gone", () => {
  const scope = scoped("resave");
  toReview(scope, {});
  const first = answer(scope, (value) => ({ ...value, verdict: "pass" }));
  assert.equal(next(scope).review, first.review);
  fs.rmSync(path.dirname(first.review), { recursive: true, force: true });
  const again = next(scope);
  assert.notEqual(again.review, first.review);
  assert.ok(fs.existsSync(again.review));
});
