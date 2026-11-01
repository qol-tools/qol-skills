import { join, resolve } from "node:path";
import { contractError, inputError, usageError } from "./errors.mjs";
import { loadScope, outputPath, tryJson, writeJson } from "./run.mjs";
import { checkFinderOutput, checkLedger, checkVerifierOutput } from "./schema.mjs";

function parseReply(text) {
  const body = String(text ?? "").trim().replace(/^```(?:json)?\s*\n/, "").replace(/\n```\s*$/, "");
  if (body === "") throw contractError("the reply is empty", ["the reply is empty; submit the lane's JSON object"]);
  try {
    return JSON.parse(body);
  } catch (error) {
    throw contractError("the reply is not JSON", [`the reply is not valid JSON: ${error.message}`]);
  }
}

function target(scope, paths, jobId) {
  if (scope.plan.ledger && jobId === scope.plan.ledger.id) {
    return { path: paths.ledger, check: (value) => checkLedger(value, scope.plan.ledger.items) };
  }
  const job = [...scope.plan.jobs, ...(scope.plan.hunt ? [scope.plan.hunt] : [])].find((item) => item.id === jobId);
  if (job) return { path: outputPath(paths, job), check: (value) => checkFinderOutput(value, job) };
  const verifier = /^verify-(G\d+)$/.exec(jobId);
  if (verifier) {
    const descriptor = tryJson(join(paths.verify, `${verifier[1]}.json`));
    if (descriptor.value === undefined) throw inputError(`${jobId} has no job file; run next until it lists ${jobId}`);
    return { path: join(paths.verify, `${verifier[1]}.result.json`), check: (value) => checkVerifierOutput(value, verifier[1]), stamp: { finds_digest: descriptor.value.finds_digest } };
  }
  throw inputError(`${jobId} is not a job of this run`);
}

export function runSubmit(runDir, jobId, reply, options = {}) {
  const { paths, scope } = loadScope(resolve(runDir));
  if (!scope.plan.solo && !options.agentId) throw usageError("a multi-agent run records every lane in the agent board: pass --agent-id <the id the runtime gave the lane>");
  const where = target(scope, paths, jobId);
  const value = parseReply(reply);
  const problems = where.check(value);
  if (problems.length > 0) throw contractError(`${problems.length} problem${problems.length === 1 ? "" : "s"} in the reply for ${jobId}`, problems);
  writeJson(where.path, { ...value, ...(where.stamp ?? {}), ...(options.agentId ? { agent_id: options.agentId } : {}) });
  return { run_dir: paths.dir, job: jobId, output: where.path, agent_id: options.agentId ?? null, failed: Boolean(value.failed), next: `next ${paths.dir}` };
}
