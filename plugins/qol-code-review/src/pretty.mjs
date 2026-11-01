import { prettyFindings } from "./render.mjs";

export function prettyScope(summary, ctx) {
  const plan = summary.plan;
  return [
    `run ${summary.run_dir}`,
    `target ${summary.target.kind} ${summary.target.input}: base ${summary.base.ref} ${summary.base.sha.slice(0, 12)}, head ${summary.head.ref} ${summary.head.sha.slice(0, 12)}${summary.head.snapshot ? " (snapshot)" : ""}`,
    `level ${summary.level.used}${summary.level.forced ? ` (forced; suggested ${summary.level.suggested})` : ""}: ${summary.level.reasons.join("; ")}`,
    `files ${summary.stats.files} changed, ${summary.stats.reviewable_files} reviewable, ${summary.stats.excluded_files} excluded; tiers high ${summary.stats.tiers.high}, medium ${summary.stats.tiers.medium}, low ${summary.stats.tiers.low}`,
    `plan ${summary.chunks} chunks, ${plan.finder_jobs} finder jobs, ${plan.passes} pass${plan.passes === 1 ? "" : "es"}, lenses ${plan.lenses.join(", ")}${plan.ledger ? ", ledger" : ""}${plan.hunt ? ", missed-bug hunt" : ""}, verify ${plan.verify === "agent" ? "by fresh agents" : "by the session"}${plan.solo ? ", solo" : ""}`,
    ...(plan.reductions.length ? [`reduced: ${plan.reductions.join("; ")}`] : []),
    `rules ${summary.rules.length ? summary.rules.join(", ") : "none on the base ref"}${summary.rules_changed.length ? `; changed by this diff: ${summary.rules_changed.join(", ")}` : ""}`,
    `shallow wrappers ${summary.shallow.entries} in ${summary.shallow.scanned} scanned files`,
    ...summary.notes.map((note) => `note ${note}`),
    `next ${ctx.name} next ${summary.run_dir}`,
  ].join("\n");
}

export function prettyNext(value, ctx) {
  const lines = [`stage ${value.stage} (${value.level}${value.solo ? ", solo" : ""}): ${value.action}`];
  for (const problem of value.problems ?? []) lines.push(`problem ${problem}`);
  for (const job of value.jobs ?? []) lines.push(`job ${job.id} (${job.reviewer}) -> ${ctx.name} ${job.submit}`);
  if (value.pruned?.length) lines.push(`pruned stale results ${value.pruned.join(", ")}`);
  if (value.template) lines.push(`template ${value.template}`);
  if (value.write) lines.push(`write ${value.write}`);
  if (value.stage === "done") {
    lines.push(`verdict ${value.verdict}: ${value.statement}`);
    lines.push(...prettyFindings(value.findings));
    lines.push(`review ${value.review}`, `summary ${value.summary}`, `next ${value.next_step}`);
  }
  return lines.join("\n");
}

export function prettySubmit(value, ctx) {
  return `stored ${value.job}${value.failed ? " (a recorded failure)" : ""} at ${value.output}\nnext ${ctx.name} ${value.next}`;
}
