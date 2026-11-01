import { agentBoard } from "./board.mjs";
import { LENS_NAMES, reviewerOf } from "./lenses.mjs";
import { locationKey, nearSpans, similarTitles, spansOf } from "./merge.mjs";
import { statementFor } from "./render.mjs";
import { CONFIDENCES, READS, SEVERITIES, conflictProblem, findingProblems, isText, rank, refutationCited } from "./schema.mjs";

export const VERDICTS = ["pass", "conditional", "block"];
const CLAIM_STATUSES = ["checked", "unchecked", "contradicted"];
const DISPOSITIONS = ["delete", "keep"];
const QUICK_WIN_CAP = 5;
const NOTE_CAP = 5;
const FIELDS = ["title", "trigger", "observed", "expected", "required_action"];
const VERIFIER_ORDER = ["confirmed", "needs_verification", "refuted"];


export function deriveVerdict(findings) {
  const live = findings.filter((finding) => !finding.pre_existing);
  const has = (status, severities) => live.some((finding) => finding.status === status && severities.includes(finding.severity));
  if (has("confirmed", ["blocker", "high"])) return "block";
  if (has("confirmed", ["medium"]) || has("needs_verification", ["blocker", "high"])) return "conditional";
  return "pass";
}

function order(left, right) {
  return (
    rank(SEVERITIES, left.severity) - rank(SEVERITIES, right.severity) ||
    (left.status === right.status ? 0 : left.status === "confirmed" ? -1 : 1) ||
    rank(CONFIDENCES, left.confidence) - rank(CONFIDENCES, right.confidence) ||
    (left.locations[0]?.file < right.locations[0]?.file ? -1 : left.locations[0]?.file > right.locations[0]?.file ? 1 : 0) ||
    (left.locations[0]?.line ?? 0) - (right.locations[0]?.line ?? 0)
  );
}

function verdictText({ group, verdict }) {
  if (verdict.status !== "refuted") return `verify-${group.id} could not settle ${group.id}`;
  return refutationCited(verdict) ? `verify-${group.id} refuted ${group.id} (${verdict.refutation})` : `verify-${group.id} refuted ${group.id} without citing a file:line`;
}

function overlaps(left, right) {
  const b = spansOf(right.locations);
  return spansOf(left.locations).some((span) => b.some((other) => nearSpans(span, other)));
}

function composeFinding(entry, index, context) {
  const where = `findings[${index}]`;
  const problems = [];
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return { problems: [`${where} is not an object`] };
  const ids = entry.groups ?? [];
  if (!Array.isArray(ids)) return { problems: [`${where}.groups must be a list of group ids`] };
  const groups = [];
  for (const id of ids) {
    const group = context.groups.get(id);
    if (group) groups.push(group);
    else problems.push(`${where}: group ${id} does not exist in candidates.json`);
  }
  if (ids.length === 0 && !isText(entry.origin)) problems.push(`${where}: a finding without groups needs origin, saying where it came from`);
  const lead = groups[0]?.candidates.find((candidate) => candidate.id === groups[0].lead) ?? null;
  const verdicts = groups.map((group) => ({ group, verdict: context.verdicts.get(group.id) ?? null }));
  const verified =
    verdicts
      .filter((item) => item.verdict && !item.verdict.failed)
      .sort((left, right) => rank(VERIFIER_ORDER, left.verdict.status) - rank(VERIFIER_ORDER, right.verdict.status))[0] ?? null;
  const finding = {
    groups: ids,
    origin: entry.origin ?? null,
    lenses: entry.lenses ?? [...new Set(groups.flatMap((group) => group.lenses))],
    severity: entry.severity ?? verified?.verdict.severity ?? lead?.severity,
    confidence: entry.confidence,
    status: entry.status,
    pre_existing: entry.pre_existing ?? verified?.verdict.pre_existing ?? false,
    locations: entry.locations ?? [...new Map(groups.flatMap((group) => group.locations).map((location) => [locationKey(location), location])).values()],
    evidence: entry.evidence ?? lead?.evidence ?? [],
    verification: entry.verification,
    conflict: entry.conflict,
    found_by: [...new Set(groups.flatMap((group) => group.found_by))].sort(),
    severity_trail: [
      ...groups.flatMap((group) => group.candidates.map((candidate) => `${candidate.job}: ${candidate.severity}`)),
      ...verdicts.filter((item) => item.verdict?.severity).map((item) => `verify-${item.group.id}: ${item.verdict.severity}`),
    ],
    severity_reason: entry.severity_reason ?? verified?.verdict.reason ?? null,
    shape: entry.shape ?? lead?.shape ?? null,
  };
  for (const field of FIELDS) finding[field] = entry[field] ?? lead?.[field];
  const given = verified?.verdict.severity ?? lead?.severity;
  if (entry.severity !== undefined && given !== undefined && entry.severity !== given) {
    finding.severity_trail.push(`review: ${entry.severity}`);
    if (!isText(entry.severity_reason)) problems.push(`${where}: severity ${entry.severity} differs from the ${verified?.verdict.severity ? "verifier's" : "finders'"} ${given}; set severity_reason to say why`);
  }
  if (context.mode === "agent" && ids.length === 0) {
    if (entry.status && entry.status !== "needs_verification") problems.push(`${where}: no lane found it and no fresh verifier checked it, so in a multi-agent run it stays needs_verification`);
    finding.status ??= "needs_verification";
    finding.verification ??= { verifier: null, checked: [], refutation: null, question: null, note: "found during the review, not by a lane, so no fresh verifier checked it" };
  }
  if (context.mode === "agent" && groups.length > 0) {
    const refuted = verified?.verdict.status === "refuted";
    const cited = refuted && refutationCited(verified.verdict);
    const settled = verified && !refuted ? verified.verdict.status : "needs_verification";
    const failed = verdicts.find((item) => item.verdict?.failed);
    const upgraded = entry.status === "confirmed" && settled !== "confirmed";
    if (!entry.status) {
      if (cited) problems.push(`${where}: ${verdictText(verified)}; move it to dropped, or set status and add a conflict block quoting both claims`);
      else {
        finding.status = settled;
        if (settled === "confirmed") finding.confidence ??= verified.verdict.confidence;
      }
    } else if (upgraded && !verified) {
      problems.push(`${where}: no verifier result exists for ${ids.join(", ")} (${failed ? `the verifier failed: ${failed.verdict.failed}` : "over the verifier cap"}), so in a multi-agent run it stays needs_verification`);
    } else if ((cited || upgraded) && !entry.conflict) {
      problems.push(`${where}: ${verdictText(verified)}; ${cited ? "keeping it needs a conflict block quoting both claims" : "confirming it needs a conflict block quoting both claims and the evidence that settles it"}`);
    }
    const confirmedBy = verified?.verdict.status === "confirmed" ? verified : null;
    if (confirmedBy) {
      const departures = [];
      if (entry.status && entry.status !== "confirmed") departures.push(`status ${entry.status}`);
      const settled = confirmedBy.verdict.severity ?? lead?.severity;
      if (settled && rank(SEVERITIES, finding.severity) > rank(SEVERITIES, settled)) departures.push(`severity ${finding.severity} below ${settled}`);
      if (finding.pre_existing && confirmedBy.verdict.pre_existing !== true && finding.locations?.some((location) => context.changed.has(location?.file))) departures.push("pre_existing");
      if (departures.length > 0 && !entry.conflict) {
        problems.push(`${where}: ${departures.join(", ")} departs from the result verify-${confirmedBy.group.id} confirmed and needs a conflict block quoting both claims and the evidence that settles it`);
      }
    }
    finding.verification ??= verified
      ? {
          verifier: `verify-${verified.group.id}`,
          checked: verified.verdict.checked,
          refutation: verified.verdict.refutation ?? null,
          question: verified.verdict.question ?? null,
          note: refuted && !cited ? "the verifier's refutation cited no file:line, so the finding stays open" : null,
        }
      : { verifier: null, checked: [], refutation: null, question: null, note: failed ? `the verifier failed: ${failed.verdict.failed}` : "not verified: the group was over the verifier cap" };
  }
  if (finding.status === "needs_verification") finding.confidence ??= "low";
  if (context.mode === "self" && !entry.status) problems.push(`${where}: set status, confidence and verification; in this run the session verifies its own findings`);
  if (problems.length === 0) problems.push(...findingProblems(finding, where, { solo: context.mode === "self" }));
  for (const [at, location] of (Array.isArray(finding.locations) ? finding.locations : []).entries()) {
    const problem = location && typeof location.file === "string" && Number.isInteger(location.line) ? context.check(location) : null;
    if (problem) problems.push(`${where}.locations[${at}]: ${problem}`);
  }
  if (finding.pre_existing && Array.isArray(finding.locations) && finding.locations.some((location) => context.onAddedLines(location))) {
    problems.push(`${where}: added lines are introduced by this change, so a finding on them cannot be pre_existing`);
  }
  if (!finding.pre_existing && Array.isArray(finding.locations) && !finding.locations.some((location) => context.changed.has(location?.file))) {
    problems.push(`${where}: no location is in a changed file; mark it pre_existing or point at the changed code that causes it`);
  }
  return { finding, problems };
}

function checkClaims(claims) {
  const problems = [];
  if (!Array.isArray(claims)) return { claims: [], problems: ["claims must be a list"] };
  claims.forEach((claim, index) => {
    if (!isText(claim?.claim)) problems.push(`claims[${index}].claim is missing`);
    if (!CLAIM_STATUSES.includes(claim?.status)) problems.push(`claims[${index}].status must be one of ${CLAIM_STATUSES.join(", ")}`);
    if (claim?.status && claim.status !== "unchecked" && !isText(claim?.evidence)) problems.push(`claims[${index}] needs evidence for a ${claim.status} claim`);
  });
  return { claims, problems };
}

function lensCoverage(scope, finds) {
  return LENS_NAMES.map((lens) => {
    const jobs = scope.plan.jobs.filter((job) => job.lenses.includes(lens));
    if (jobs.length === 0) {
      const reason = scope.plan.lenses.includes(lens)
        ? "no job covers it"
        : scope.level.used === "deep"
          ? "no changed file carried a signal that routes to it"
          : `not part of the ${scope.level.used} level`;
      return { lens, status: "not run", jobs: 0, failed: 0, reason };
    }
    const failed = jobs.filter((job) => finds.get(job.id)?.failed);
    const status = failed.length === 0 ? "ran" : failed.length === jobs.length ? "failed" : "partial";
    return { lens, status, jobs: jobs.length, failed: failed.length, chunks: new Set(jobs.map((job) => job.chunk)).size };
  });
}

function fileCoverage(scope, finds, overrides) {
  const problems = [];
  const reads = new Map();
  for (const output of finds.values()) {
    for (const item of output.files_read ?? []) if (reads.get(item.path) !== "full") reads.set(item.path, item.read);
  }
  const given = new Map();
  for (const [index, item] of overrides.entries()) {
    if (typeof item?.path !== "string" || !READS.includes(item?.read)) problems.push(`coverage.files[${index}] needs a path and read full, hunks or skipped`);
    else if (item.read === "skipped" && !isText(item.reason)) problems.push(`coverage.files[${index}] skips ${item.path} without a reason`);
    else given.set(item.path, item);
  }
  const files = scope.files.map((file) => {
    const override = given.get(file.path);
    if (override) return { path: file.path, tier: file.tier, read: override.read, reason: override.reason ?? null };
    if (file.excluded) return { path: file.path, tier: file.tier, read: "skipped", reason: file.exclude_reason };
    const read = reads.get(file.path);
    if (read) return { path: file.path, tier: file.tier, read, reason: null };
    problems.push(`no finder reported reading ${file.path}; re-run its job, or list it in coverage.files with read skipped and a reason`);
    return { path: file.path, tier: file.tier, read: "skipped", reason: "no finder reported reading it" };
  });
  for (const path of given.keys()) if (!scope.files.some((file) => file.path === path)) problems.push(`coverage.files names ${path}, which is not part of this review`);
  return { files, problems };
}

function checkShallow(entries, given) {
  const problems = [];
  const items = Array.isArray(given) ? given : (problems.push("shallow_wrappers must be a list"), []);
  const key = (item) => `${item?.file}:${item?.line}`;
  const byKey = new Map(items.map((item) => [key(item), item]));
  const result = [];
  for (const entry of entries) {
    const item = byKey.get(key(entry));
    if (!DISPOSITIONS.includes(item?.disposition)) problems.push(`shallow wrapper ${key(entry)} (${entry.name}) needs a disposition of delete or keep`);
    else if (item.disposition === "keep" && !isText(item.reason)) problems.push(`shallow wrapper ${key(entry)} (${entry.name}) is kept without a reason`);
    else result.push({ ...entry, disposition: item.disposition, reason: isText(item.reason) ? item.reason : null });
  }
  const known = new Set(entries.map(key));
  for (const item of items) if (!known.has(key(item))) problems.push(`shallow_wrappers names ${key(item)}, which the detector did not list`);
  return { wrappers: result, problems };
}

function checkQuickWins(given) {
  const problems = [];
  const items = Array.isArray(given) ? given : (problems.push("quick_wins must be a list"), []);
  if (items.length > QUICK_WIN_CAP) problems.push(`${items.length} quick wins exceed the cap of ${QUICK_WIN_CAP}`);
  items.forEach((item, index) => {
    for (const field of ["id", "title", "file", "action"]) if (!isText(item?.[field])) problems.push(`quick_wins[${index}].${field} is missing`);
    if (!Number.isInteger(item?.line) || item.line < 1) problems.push(`quick_wins[${index}].line must be a positive integer`);
  });
  return { items, problems };
}

function domainOf(finding) {
  const lens = finding.lenses?.[0];
  return lens ? reviewerOf(lens).replace(/-reviewer$/, "") : "review";
}

function assignIds(findings) {
  const counts = new Map();
  return findings.map((finding) => {
    const domain = domainOf(finding);
    const count = (counts.get(domain) ?? 0) + 1;
    counts.set(domain, count);
    return { id: `${domain}-${count}`, ...finding };
  });
}

export function composeReview({ scope, candidates, verdicts, finds, review, intent, check, ledger = null, digest = null }) {
  const problems = [];
  if (review === null || typeof review !== "object" || Array.isArray(review)) return { problems: ["review.json must hold an object"] };
  const mode = scope.plan.verify === "agent" ? "agent" : "self";
  const run = review.run ?? {};
  if (digest !== null && review.digest !== digest) problems.push("review.json was written for an earlier merge of the finder outputs; copy review.template.json to review.json again and redo the decisions");
  if (!isText(run.runtime)) problems.push("run.runtime is missing; name the runtime, such as claude-code, codex, pi or kimi");
  const expectedMode = scope.plan.solo ? "single-agent" : "multi-agent";
  if (run.mode !== expectedMode) problems.push(`run.mode must be ${expectedMode} for this plan${scope.plan.solo ? "" : "; a multi-agent run is never replaced by a solo one unless the user asked for a solo review"}`);
  if (scope.plan.jobs.length > 0 && scope.plan.jobs.every((job) => finds.get(job.id)?.failed)) {
    problems.push("every finder job failed, so nothing was reviewed; submit their outputs again");
  }
  const board = agentBoard(scope, { finds, verdicts, ledger });
  if (!scope.plan.solo) {
    for (const entry of board) if (!isText(entry.agent_id)) problems.push(`${entry.job} has no agent id; submit its output with --agent-id`);
  }
  const changed = new Set(scope.files.flatMap((file) => [file.path, file.old_path].filter(Boolean)));
  const onAddedLines = (location) => {
    if ((location?.side ?? "head") !== "head") return false;
    const runs = scope.files.find((file) => file.path === location?.file)?.added_runs ?? [];
    return runs.some(([start, end]) => location.line <= end && (location.end_line ?? location.line) >= start);
  };
  const context = { groups: new Map(candidates.groups.map((group) => [group.id, group])), verdicts, mode, check, changed, onAddedLines };
  const entries = Array.isArray(review.findings) ? review.findings : (problems.push("findings must be a list"), []);
  const composed = [];
  const indexes = [];
  const owner = new Map();
  entries.forEach((entry, index) => {
    const result = composeFinding(entry, index, context);
    problems.push(...result.problems);
    if (!result.finding) return;
    for (const id of result.finding.groups) {
      if (owner.has(id)) problems.push(`group ${id} is in findings[${owner.get(id)}] and findings[${index}]; list it in one finding`);
      else owner.set(id, index);
    }
    composed.push(result.finding);
    indexes.push(index);
  });
  const dropped = Array.isArray(review.dropped) ? review.dropped : (problems.push("dropped must be a list"), []);
  const droppedIds = new Set();
  dropped.forEach((item, index) => {
    if (!context.groups.has(item?.group)) problems.push(`dropped[${index}]: group ${item?.group} does not exist in candidates.json`);
    else if (droppedIds.has(item.group)) problems.push(`dropped[${index}]: group ${item.group} is already dropped`);
    if (!isText(item?.reason)) problems.push(`dropped[${index}] needs a reason`);
    const result = verdicts.get(item?.group);
    const settled = result?.severity ?? context.groups.get(item?.group)?.severity;
    if (result && !result.failed && result.status === "confirmed" && settled !== "note") {
      if (item.conflict === undefined) problems.push(`dropped[${index}]: group ${item.group} was confirmed by verify-${item.group}; dropping it needs a conflict block quoting both claims and the evidence that settles it`);
      else if (conflictProblem(item.conflict)) problems.push(`dropped[${index}]: conflict needs both claims quoted and the evidence that settled it`);
    }
    droppedIds.add(item?.group);
  });
  const inFindings = new Set(composed.flatMap((finding) => finding.groups));
  for (const group of candidates.groups) {
    if (!inFindings.has(group.id) && !droppedIds.has(group.id)) problems.push(`group ${group.id} (${group.title}) is neither in findings nor in dropped`);
    if (inFindings.has(group.id) && droppedIds.has(group.id)) problems.push(`group ${group.id} is in findings and in dropped`);
  }
  for (let left = 0; left < composed.length; left++) {
    for (let right = left + 1; right < composed.length; right++) {
      const a = composed[left];
      const b = composed[right];
      if (Array.isArray(a.locations) && Array.isArray(b.locations) && isText(a.title) && isText(b.title) && overlaps(a, b) && similarTitles(a.title, b.title)) {
        problems.push(`findings[${indexes[left]}] and findings[${indexes[right]}] look like the same defect; merge them into one finding with all locations, or retitle them to say how they differ`);
      }
    }
  }
  const notes = composed.filter((finding) => !finding.pre_existing && finding.severity === "note");
  if (notes.length > NOTE_CAP) problems.push(`${notes.length} notes exceed the cap of ${NOTE_CAP}; keep the ${NOTE_CAP} most useful and drop the rest`);
  const claims = checkClaims(review.claims ?? []);
  problems.push(...claims.problems);
  const shallow = checkShallow(scope.shallow?.entries ?? [], review.shallow_wrappers ?? []);
  problems.push(...shallow.problems);
  const quickWins = checkQuickWins(review.quick_wins ?? []);
  problems.push(...quickWins.problems);
  const risks = review.accepted_risks ?? [];
  if (!Array.isArray(risks) || !risks.every(isText)) problems.push("accepted_risks must be a list of sentences");
  const coverageInput = review.coverage ?? {};
  const files = fileCoverage(scope, finds, Array.isArray(coverageInput.files) ? coverageInput.files : []);
  problems.push(...files.problems);
  const executed = Array.isArray(coverageInput.executed) ? coverageInput.executed : [];
  executed.forEach((item, index) => {
    if (!isText(item?.command) || !Number.isInteger(item?.exit)) problems.push(`coverage.executed[${index}] needs the command and its exit code`);
  });
  const extraGaps = Array.isArray(coverageInput.not_reviewed) ? coverageInput.not_reviewed.filter(isText) : [];
  const questions = Array.isArray(review.open_questions) ? review.open_questions.filter(isText) : [];
  const derived = deriveVerdict(composed.filter((finding) => finding.status));
  if (!VERDICTS.includes(review.verdict)) problems.push(`verdict must be one of ${VERDICTS.join(", ")}; these findings give ${derived}`);
  else if (review.verdict !== derived) problems.push(`verdict says ${review.verdict} but the findings give ${derived}`);
  const ranked = assignIds([...composed].filter((finding) => Array.isArray(finding.locations) && finding.locations.length > 0).sort(order));
  const main = ranked.filter((finding) => !finding.pre_existing && finding.severity !== "note");
  const noteList = ranked.filter((finding) => !finding.pre_existing && finding.severity === "note");
  const preExisting = ranked.filter((finding) => finding.pre_existing);
  const failedJobs = [...finds.entries()].filter(([, output]) => output.failed).map(([id, output]) => `finder job ${id} failed: ${output.failed}`);
  const unverified = candidates.unverified ?? [];
  const lenses = lensCoverage(scope, finds);
  const declined = [...finds.entries()].flatMap(([job, output]) => (output.declined ?? []).map((item) => ({ job, lens: item.lens ?? null, topic: item.topic, reason: item.reason })));
  const report = {
    schema: "code-review-engine/report@2",
    run_id: scope.run_id,
    target: scope.target,
    base: { ref: scope.base.ref, sha: scope.base.sha },
    head: { ref: scope.head.ref, sha: scope.head.sha, snapshot: scope.head.snapshot },
    pr: scope.pr ? { number: scope.pr.number, url: scope.pr.url } : null,
    level: scope.level.used,
    run: { runtime: run.runtime ?? null, mode: run.mode ?? null },
    verdict: review.verdict,
    statement: null,
    intent: intent ? { source: intent.source, summary: intent.summary, requirements: intent.requirements } : null,
    counts: {
      confirmed: Object.fromEntries(SEVERITIES.slice(0, 4).map((severity) => [severity, main.filter((finding) => finding.status === "confirmed" && finding.severity === severity).length])),
      needs_verification: main.filter((finding) => finding.status === "needs_verification").length,
      notes: noteList.length,
      pre_existing: preExisting.length,
      dropped: dropped.length,
      groups: candidates.groups.length,
      candidates: candidates.stats.received,
      excluded_candidates: candidates.stats.excluded,
    },
    agent_board: board,
    findings: main,
    notes: noteList,
    pre_existing: preExisting,
    dropped: dropped.map((item) => ({ group: item.group, title: context.groups.get(item.group)?.title ?? null, reason: item.reason, conflict: item.conflict ?? null })),
    claims: claims.claims,
    shallow_wrappers: shallow.wrappers,
    shallow_scanned: scope.shallow?.scanned ?? 0,
    quick_wins: quickWins.items,
    accepted_risks: risks,
    open_questions: questions,
    coverage: {
      files: files.files,
      lenses,
      declined,
      not_reviewed: [
        ...failedJobs,
        ...(ledger?.failed ? [`the ledger job failed: ${ledger.failed}`] : []),
        ...files.files.filter((file) => file.read === "skipped").map((file) => `${file.path}: ${file.reason}`),
        ...unverified.map((id) => `group ${id} was not verified: over the verifier cap`),
        ...[...verdicts].filter(([, verdict]) => verdict.failed).map(([id, verdict]) => `group ${id} was not verified: the verifier failed: ${verdict.failed}`),
        ...extraGaps,
      ],
      executed,
      excluded_candidates: candidates.excluded.length,
    },
  };
  if (problems.length === 0) report.statement = statementFor(review.verdict, report);
  return { report, problems };
}

export function reviewTemplate({ scope, candidates, verdicts, intent, digest }) {
  const findings = [];
  const dropped = [];
  for (const group of candidates.groups) {
    const verdict = verdicts.get(group.id);
    if (verdict && !verdict.failed && verdict.status === "refuted" && refutationCited(verdict)) dropped.push({ group: group.id, reason: `refuted by verify-${group.id}: ${verdict.refutation}` });
    else findings.push({ groups: [group.id] });
  }
  return {
    digest,
    verdict: null,
    run: { runtime: null, mode: scope.plan.solo ? "single-agent" : "multi-agent" },
    findings,
    dropped,
    claims: (intent?.claims ?? []).map((claim) => ({ claim, status: null, evidence: null })),
    shallow_wrappers: (scope.shallow?.entries ?? []).map((entry) => ({ ...entry, disposition: null, reason: null })),
    quick_wins: [],
    accepted_risks: [],
    open_questions: [],
    coverage: { files: [], not_reviewed: [], executed: [] },
  };
}
