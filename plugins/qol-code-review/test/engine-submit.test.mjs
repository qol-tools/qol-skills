import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after } from "node:test";
import { EXIT } from "../src/errors.mjs";
import { runNext } from "../src/next.mjs";
import { runScope } from "../src/scope.mjs";
import { runSubmit } from "../src/submit.mjs";
import { ENV, candidate, catching, commit, depsFor, finderOutput, makeRepo, numbered, readJson, tempRoot, writeJson, test } from "./engine-helpers.mjs";

const root = tempRoot();
after(() => fs.rmSync(root, { recursive: true, force: true }));

const INTENT = { source: "stated", summary: "Grow the file. Nothing else changes.", requirements: [], claims: [] };

function scoped(name, options = { level: "standard" }) {
  const dir = makeRepo(root, name);
  commit(dir, { "src/app.js": numbered(20) }, "base");
  const head = commit(dir, { "src/app.js": numbered(60) }, "change");
  const scope = runScope(head, options, depsFor(dir, path.join(root, `${name}-out`)));
  writeJson(path.join(scope.run_dir, "intent.json"), INTENT);
  return scope;
}

const reply = (scope, job, candidates = []) => JSON.stringify(finderOutput(scope, scope.plan.jobs.find((item) => item.id === job), candidates, { agent_id: undefined }));
const outputOf = (scope, name) => path.join(scope.run_dir, name);

test("submit stores a valid finder reply with its agent id and strips a code fence", () => {
  const scope = scoped("submit-finder");
  const fenced = `\`\`\`json\n${reply(scope, "c01-correctness-p1", [candidate({ locations: [{ file: "src/app.js", line: 30 }] })])}\n\`\`\``;
  const result = runSubmit(scope.run_dir, "c01-correctness-p1", fenced, { agentId: "agent-42" });
  assert.deepEqual([result.job, result.agent_id, result.failed], ["c01-correctness-p1", "agent-42", false]);
  const stored = readJson(outputOf(scope, "finds/c01-correctness-p1.json"));
  assert.deepEqual([stored.agent_id, stored.candidates.length], ["agent-42", 1]);
  assert.deepEqual(runNext(scope.run_dir, { env: ENV }).jobs.map((job) => job.id), ["c01-security-p1", "c01-contracts-p1", "c01-tests-p1"]);
});

test("submit refuses a reply that breaks the contract and writes nothing", () => {
  const scope = scoped("submit-bad");
  const wrongJob = catching(() => runSubmit(scope.run_dir, "c01-security-p1", JSON.stringify({ job: "c01-tests-p1", candidates: [], files_read: [], declined: [] }), { agentId: "a" }));
  assert.deepEqual([wrongJob.code, wrongJob.problems], [EXIT.contract, ['c01-security-p1: the output names job "c01-tests-p1"']]);
  const notJson = catching(() => runSubmit(scope.run_dir, "c01-security-p1", "I found nothing", { agentId: "a" }));
  assert.equal(notJson.code, EXIT.contract);
  assert.match(notJson.problems[0], /the reply is not valid JSON/);
  const empty = catching(() => runSubmit(scope.run_dir, "c01-security-p1", "  ", { agentId: "a" }));
  assert.equal(empty.code, EXIT.contract);
  assert.equal(fs.existsSync(outputOf(scope, "finds/c01-security-p1.json")), false);
  const unknown = catching(() => runSubmit(scope.run_dir, "c99-nothing-p1", "{}", { agentId: "a" }));
  assert.deepEqual([unknown.code, unknown.message], [EXIT.input, "c99-nothing-p1 is not a job of this run"]);
});

test("a multi-agent run needs the agent id, and a solo run does not", () => {
  const scope = scoped("submit-agent");
  const missing = catching(() => runSubmit(scope.run_dir, "c01-correctness-p1", reply(scope, "c01-correctness-p1"), {}));
  assert.equal(missing.code, EXIT.usage);
  assert.match(missing.message, /pass --agent-id/);
  const solo = scoped("submit-solo", { level: "quick", solo: true });
  const result = runSubmit(solo.run_dir, "c01-all-p1", reply(solo, "c01-all-p1"), {});
  assert.equal(result.agent_id, null);
  assert.equal("agent_id" in readJson(outputOf(solo, "finds/c01-all-p1.json")), false);
});

test("submit stamps a verifier result with the merge its job file was written for", () => {
  const scope = scoped("submit-verifier");
  for (const job of scope.plan.jobs) runSubmit(scope.run_dir, job.id, reply(scope, job.id, job.id === "c01-correctness-p1" ? [candidate({ severity: "high", locations: [{ file: "src/app.js", line: 30 }] })] : []), { agentId: `agent-${job.id}` });
  const early = catching(() => runSubmit(scope.run_dir, "verify-G01", "{}", { agentId: "v" }));
  assert.equal(early.code, EXIT.input);
  const verify = runNext(scope.run_dir, { env: ENV });
  assert.deepEqual(verify.jobs.map((job) => job.id), ["verify-G01"]);
  const digest = readJson(outputOf(scope, "candidates.json")).digest;
  const bad = catching(() => runSubmit(scope.run_dir, "verify-G01", JSON.stringify({ group: "G01", status: "confirmed", confidence: "low", checked: ["x"] }), { agentId: "v" }));
  assert.deepEqual(bad.problems, ["G01: a confirmed finding needs high or medium confidence"]);
  runSubmit(scope.run_dir, "verify-G01", JSON.stringify({ group: "G01", status: "confirmed", confidence: "high", checked: ["read src/app.js:30"] }), { agentId: "agent-v" });
  const stored = readJson(outputOf(scope, "verify/G01.result.json"));
  assert.deepEqual([stored.finds_digest, stored.agent_id], [digest, "agent-v"]);
  assert.equal(runNext(scope.run_dir, { env: ENV }).stage, "review");
});

test("a submitted failure is recorded and a failed lane shows in the agent board", () => {
  const scope = scoped("submit-failed");
  const result = runSubmit(scope.run_dir, "c01-security-p1", JSON.stringify({ job: "c01-security-p1", failed: "ran out of context" }), { agentId: "agent-s" });
  assert.equal(result.failed, true);
  assert.deepEqual(readJson(outputOf(scope, "finds/c01-security-p1.json")), { job: "c01-security-p1", failed: "ran out of context", agent_id: "agent-s" });
});
