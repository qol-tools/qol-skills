export function fence(text) {
  const longest = Math.max(2, ...[...String(text).matchAll(/`+/g)].map((match) => match[0].length));
  return "`".repeat(longest + 1);
}

const SEVERITY_SECTIONS = [
  ["blocker", "Confirmed blockers"],
  ["high", "Confirmed high"],
  ["medium", "Confirmed medium"],
  ["low", "Confirmed low"],
];

function where(location) {
  const span = location.end_line && location.end_line !== location.line ? `${location.line}-${location.end_line}` : `${location.line}`;
  return `${location.file}:${span}${location.side === "base" ? " (base)" : ""}`;
}

export function plural(count, word) {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

export function list(items) {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

export function statementFor(verdict, report) {
  const { findings, coverage, level } = report;
  const ids = (items) => list(items.map((finding) => `${finding.id} (${finding.severity})`));
  const lenses = (names) => `${list(names)} lens${names.length === 1 ? "" : "es"}`;
  if (verdict === "block") {
    const blocking = findings.filter((finding) => finding.status === "confirmed" && ["blocker", "high"].includes(finding.severity));
    return `Blocked by ${plural(blocking.length, "confirmed blocker or high finding")}: ${ids(blocking)}.`;
  }
  if (verdict === "conditional") {
    const fix = findings.filter((finding) => finding.status === "confirmed" && finding.severity === "medium");
    const settle = findings.filter((finding) => finding.status === "needs_verification" && ["blocker", "high"].includes(finding.severity));
    const steps = [fix.length > 0 ? `fix ${ids(fix)}` : null, settle.length > 0 ? `settle the unverified ${ids(settle)} with evidence` : null].filter(Boolean);
    return `Conditional: ${steps.join(fix.length > 1 ? ", and " : " and ")} before merging.`;
  }
  const read = coverage.files.filter((file) => file.read !== "skipped");
  const ran = coverage.lenses.filter((lens) => ["ran", "partial"].includes(lens.status)).map((lens) => lens.lens);
  const notRun = coverage.lenses.filter((lens) => ["not run", "failed"].includes(lens.status)).map((lens) => lens.lens);
  const skipped = coverage.files.filter((file) => file.read === "skipped");
  const open = findings.filter((finding) => finding.status === "needs_verification");
  const warrants = [
    coverage.executed.length === 0 ? "runtime behavior, because no tests or builds were run" : `runtime behavior beyond the ${plural(coverage.executed.length, "command")} listed under executed`,
  ];
  if (skipped.length > 0) warrants.push(`the ${plural(skipped.length, "changed file")} that ${skipped.length === 1 ? "was" : "were"} not read (${skipped.slice(0, 5).map((file) => file.path).join(", ")}${skipped.length > 5 ? ", and more" : ""})`);
  if (notRun.length > 0) warrants.push(`defects of the kinds the ${lenses(notRun)} look${notRun.length === 1 ? "s" : ""} for`);
  if (open.length > 0) warrants.push(`the ${plural(open.length, "open question")} under needs verification`);
  warrants.push("code outside this diff, except where a finding names it");
  return `No confirmed blocker, high or medium defect was found in ${read.length} of ${coverage.files.length} changed files by the ${lenses(ran)} at the ${level} level${report.run.mode === "single-agent" ? " in a single-agent run, whose finders and verifiers were not independent" : ""}. This pass does not warrant ${warrants.join("; ")}.`;
}

export function locationsText(finding) {
  return finding.locations.map(where).join(", ");
}

function cell(text) {
  return String(text ?? "").replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
}

function findingBlock(finding) {
  const label = finding.status === "confirmed" ? `${finding.severity}, confirmed, ${finding.confidence} confidence` : `${finding.severity}, needs verification`;
  const lenses = finding.lenses.length > 0 ? ` Lens${finding.lenses.length === 1 ? "" : "es"}: ${finding.lenses.join(", ")}.` : "";
  const parts = [`### ${finding.id} ${finding.title}`, "", `${label}.${lenses}`, "", `Locations: ${locationsText(finding)}.`, ""];
  if (finding.trigger) parts.push(`- Trigger: ${finding.trigger}`);
  parts.push(`- Observed: ${finding.observed}`);
  if (finding.expected) parts.push(`- Expected: ${finding.expected}`);
  const verification = finding.verification;
  if (finding.status === "confirmed") parts.push(`- Required action: ${finding.required_action}`);
  else {
    if (verification?.question) parts.push(`- Open question: ${verification.question}`);
    parts.push(`- Required action, if confirmed: ${finding.required_action}`);
  }
  for (const item of finding.evidence ?? []) parts.push(`- Evidence: ${item}`);
  if (verification?.checked?.length) parts.push(`- ${verification.verifier && verification.verifier !== "self" ? verification.verifier : "The session"} checked: ${verification.checked.join("; ")}.`);
  if (verification?.note) parts.push(`- Verification note: ${verification.note}.`);
  if (finding.conflict) parts.push(`- Conflict: ${finding.conflict.claims.map((claim) => `"${claim}"`).join(" against ")}. Settled by: ${finding.conflict.resolution}`);
  if (finding.severity_trail?.length > 1) parts.push(`- Severity trail: ${finding.severity_trail.join(", ")}.`);
  if (finding.severity_reason) parts.push(`- Severity reason: ${finding.severity_reason}`);
  if (finding.found_by?.length) parts.push(`- Found by: ${finding.found_by.join(", ")}.`);
  if (finding.origin) parts.push(`- Origin: ${finding.origin}`);
  return parts.join("\n");
}

function entryOf(finding, extra = {}) {
  const [first] = finding.locations;
  const action = finding.status === "confirmed" ? finding.required_action : `Settle first: ${finding.verification?.question ?? "the open question"} If confirmed: ${finding.required_action}`;
  return {
    id: finding.id,
    title: finding.title,
    severity: finding.severity,
    confidence: finding.confidence,
    file: first.file,
    line: first.line,
    ...(finding.shape ? { shape: finding.shape } : {}),
    required_action: action,
    ...extra,
  };
}

export function buildSummary(report) {
  const live = [...report.findings, ...report.notes];
  const counts = { blocker: 0, high: 0, medium: 0, low: 0, note: 0 };
  for (const finding of live) counts[finding.severity] += 1;
  const mustFix = report.findings.filter((finding) => (finding.status === "confirmed" ? ["blocker", "high", "medium"] : ["blocker", "high"]).includes(finding.severity));
  const must = new Set(mustFix.map((finding) => finding.id));
  const deferred = [
    ...report.findings.filter((finding) => !must.has(finding.id)).map((finding) => entryOf(finding)),
    ...report.pre_existing.map((finding) => entryOf(finding, { pre_existing: true })),
  ];
  return {
    verdict: report.verdict,
    agent_board: report.agent_board,
    counts,
    must_fix: mustFix.map((finding) => entryOf(finding)),
    deferred_followups: deferred,
    contextual_quick_wins: report.quick_wins,
    shallow_wrappers: report.shallow_wrappers,
    accepted_risks: report.accepted_risks,
    verification: report.coverage.executed,
  };
}

function boardText(board, solo) {
  if (solo) return "none (single-agent run: the session ran every job itself)";
  const roles = new Map();
  for (const item of board) roles.set(item.reviewer, [...(roles.get(item.reviewer) ?? []), item]);
  const failed = board.filter((item) => item.status === "failed").length;
  const rows = [...roles].map(([reviewer, items]) => `${reviewer} ${items.length === 1 ? `${items[0].job} ${items[0].agent_id} ${items[0].status}` : `x${items.length}`}`);
  return `${plural(board.length, "lane")}${failed > 0 ? `, ${failed} failed` : ""}: ${rows.join("; ")}. Every agent id is in the json block.`;
}

function idList(findings) {
  return findings.length === 0 ? "none" : findings.map((finding) => `${finding.id} (${finding.title})`).join("; ");
}

function section(parts, heading, lead, findings) {
  parts.push("", heading);
  if (lead) parts.push("", lead);
  for (const finding of findings) parts.push("", findingBlock(finding));
}

export function renderMarkdown(report, scope, summary = buildSummary(report)) {
  const confirmed = report.findings.filter((finding) => finding.status === "confirmed");
  const open = report.findings.filter((finding) => finding.status === "needs_verification");
  const files = report.coverage.files;
  const executed = report.coverage.executed;
  const parts = [
    `# Review board result: ${scope.target.kind} \`${scope.target.input}\``,
    "",
    `- Scope: base \`${report.base.ref}\` at \`${report.base.sha.slice(0, 12)}\`, head \`${report.head.ref}\` at \`${report.head.sha.slice(0, 12)}\`${report.head.snapshot ? " (snapshot of uncommitted changes)" : ""}; ${plural(files.length, "changed file")}; level ${report.level}; ${report.run.mode} run on ${report.run.runtime}${report.pr ? `; pull request #${report.pr.number}` : ""}.`,
    `- Verdict: **${report.verdict}**. ${report.statement}`,
    `- Agent board: ${boardText(report.agent_board, scope.plan.solo)}`,
    `- Baseline: ${executed.length === 0 ? "no tests or builds were run against the change" : executed.map((item) => `\`${item.command}\` exited ${item.exit}${item.where ? ` on the ${item.where}` : ""}`).join("; ")}.`,
  ];
  if (report.intent) parts.push(`- Intent (${report.intent.source === "none" ? "no stated intent" : report.intent.source}): ${report.intent.summary}`);
  for (const [severity, heading] of SEVERITY_SECTIONS) {
    section(parts, `## ${heading}`, null, confirmed.filter((finding) => finding.severity === severity));
    if (!confirmed.some((finding) => finding.severity === severity)) parts.push("", "none");
  }
  if (open.length > 0) section(parts, "## Needs verification", "Each entry is a question the review could not settle with evidence.", open);
  section(parts, "## Notes", report.notes.length === 0 ? "none" : "These do not block the change.", report.notes);
  parts.push("", "## Contextual quick wins", "");
  if (report.quick_wins.length === 0) parts.push("none");
  for (const item of report.quick_wins) parts.push(`- ${item.id} ${item.title} (${item.file}:${item.line}): ${item.action}`);
  parts.push("", "## Shallow wrappers", "");
  if (report.shallow_wrappers.length === 0) parts.push(`none (detector ran on ${plural(report.shallow_scanned, "file")})`);
  for (const item of report.shallow_wrappers) parts.push(`- ${item.file}:${item.line} ${item.name} -> ${item.callee}: ${item.disposition}${item.reason ? `, ${item.reason}` : ""}`);
  parts.push("", "## Must fix before commit", "", idList(report.findings.filter((finding) => summary.must_fix.some((item) => item.id === finding.id))));
  parts.push("", "## Deferred follow-ups", "", summary.deferred_followups.length === 0 ? "none" : summary.deferred_followups.map((item) => `${item.id} (${item.title})`).join("; "));
  parts.push("", "## Risks now accepted by design", "");
  if (report.accepted_risks.length === 0) parts.push("none");
  for (const item of report.accepted_risks) parts.push(`- ${item}`);
  parts.push("", "## Verification commands", "");
  if (executed.length === 0) parts.push("none were run");
  for (const item of executed) parts.push(`- \`${item.command}\` exited ${item.exit}${item.where ? ` on the ${item.where}` : ""}.`);
  parts.push("", "## Open questions", "");
  const questions = [...open.map((finding) => `${finding.id}: ${finding.verification?.question ?? finding.title}`), ...report.open_questions];
  if (questions.length === 0) parts.push("none");
  for (const item of questions) parts.push(`- ${item}`);
  if (report.pre_existing.length > 0) section(parts, "## Pre-existing issues", "These exist at the base too, so this change did not introduce them.", report.pre_existing);
  if (report.claims.length > 0) {
    parts.push("", "## Author claims", "", "| Claim | Status | Evidence |", "|---|---|---|");
    for (const claim of report.claims) parts.push(`| ${cell(claim.claim)} | ${claim.status} | ${cell(claim.evidence ?? "")} |`);
  }
  if (report.dropped.length > 0) {
    parts.push("", "## Dropped candidates", "", "| Group | Title | Reason |", "|---|---|---|");
    for (const item of report.dropped) parts.push(`| ${item.group} | ${cell(item.title)} | ${cell(item.reason)} |`);
  }
  const coverage = report.coverage;
  parts.push("", "## Coverage", "", "| File | Tier | Read |", "|---|---|---|");
  for (const file of coverage.files) parts.push(`| ${cell(file.path)} | ${file.tier} | ${file.read}${file.reason ? `: ${cell(file.reason)}` : ""} |`);
  parts.push("", "| Lens | Status | Jobs |", "|---|---|---|");
  for (const lens of coverage.lenses) parts.push(`| ${lens.lens} | ${lens.status}${lens.reason ? `: ${cell(lens.reason)}` : ""} | ${lens.jobs}${lens.failed ? `, ${lens.failed} failed` : ""} |`);
  if (coverage.declined.length > 0) {
    parts.push("", "Declined to judge:", "");
    for (const item of coverage.declined) parts.push(`- ${item.job}${item.lens ? ` (${item.lens})` : ""}: ${item.topic}, because ${item.reason}`);
  }
  parts.push("", "Not reviewed:", "");
  if (coverage.not_reviewed.length === 0) parts.push("- Nothing: every changed file was read and every planned job finished.");
  for (const item of coverage.not_reviewed) parts.push(`- ${item}`);
  const json = JSON.stringify(summary, null, 2);
  const marker = fence(json);
  parts.push("", "## Machine-parseable block", "", `${marker}json`, json, marker, "");
  return parts.join("\n");
}

export function prettyFindings(findings) {
  if (findings.length === 0) return [];
  return [
    "| ID | Severity | Status | Location | Finding |",
    "|---|---|---|---|---|",
    ...findings.map((finding) => `| ${finding.id} | ${finding.severity} | ${finding.status === "confirmed" ? "confirmed" : "unverified"} | ${cell(where(finding.location))} | ${cell(finding.title)} |`),
  ];
}
