import { reviewerOf } from "./lenses.mjs";

const ADVERSARIAL = "adversarial-reviewer";
const LEDGER = "architecture-reviewer";

function entry(reviewer, job, output) {
  return { reviewer, job, agent_id: output.agent_id ?? null, status: output.failed ? "failed" : "completed" };
}

export function agentBoard(scope, { finds, verdicts, ledger }) {
  if (scope.plan.solo) return [];
  const board = [];
  if (scope.plan.ledger && ledger) board.push(entry(LEDGER, scope.plan.ledger.id, ledger));
  for (const job of scope.plan.jobs) {
    const output = finds.get(job.id);
    if (output) board.push(entry(reviewerOf(job.lenses[0]), job.id, output));
  }
  if (scope.plan.hunt && finds.get(scope.plan.hunt.id)) board.push(entry(ADVERSARIAL, scope.plan.hunt.id, finds.get(scope.plan.hunt.id)));
  for (const [group, output] of [...verdicts].sort(([left], [right]) => (left < right ? -1 : 1))) board.push(entry(ADVERSARIAL, `verify-${group}`, output));
  return board;
}
