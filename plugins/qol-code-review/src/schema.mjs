export const LIMITS = { candidates: 15, words: 60 };
export const SEVERITIES = ["blocker", "high", "medium", "low", "note"];
export const CONFIDENCES = ["high", "medium", "low"];
export const STATUSES = ["confirmed", "needs_verification", "refuted"];
export const READS = ["full", "hunks", "skipped"];
export const CITATION = /[\w./@+-]+:\d+/;
const BANNED_LEADS = /^\s*(ensure|verify|consider|make sure|double[- ]check|check that|be careful|think about)\b/i;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const isText = (value) => typeof value === "string" && value.trim().length > 0;
export const rank = (list, value) => {
  const index = list.indexOf(value);
  return index < 0 ? list.length : index;
};

export function requiredFields(severity) {
  return severity === "note" ? ["observed", "required_action"] : ["trigger", "observed", "expected", "required_action"];
}

export function statusConfidenceProblems(status, confidence, label) {
  if (status === "confirmed" && confidence === "low") return [`${label} needs high or medium confidence`];
  if (status === "needs_verification" && confidence !== "low") return [`${label} carries low confidence`];
  return [];
}
const isLine = (value) => Number.isInteger(value) && value > 0;

export function checkLocation(location, where) {
  const problems = [];
  if (!isObject(location)) return [`${where} is not an object`];
  if (!isText(location.file)) problems.push(`${where}.file is missing`);
  if (!isLine(location.line)) problems.push(`${where}.line must be a positive integer`);
  if (location.end_line !== undefined && location.end_line !== null && (!isLine(location.end_line) || location.end_line < location.line)) {
    problems.push(`${where}.end_line must be an integer at or after line`);
  }
  if (location.side !== undefined && !["head", "base"].includes(location.side)) problems.push(`${where}.side must be head or base`);
  return problems;
}

export function checkIntent(intent) {
  const problems = [];
  if (!isObject(intent)) return ["intent.json must hold an object"];
  if (!["stated", "inferred", "none"].includes(intent.source)) problems.push("intent.source must be stated, inferred or none");
  if (!isText(intent.summary)) problems.push("intent.summary is missing; write the intent in two sentences, or \"no stated intent\"");
  if (!Array.isArray(intent.requirements) || !intent.requirements.every(isText)) problems.push("intent.requirements must be a list of sentences (it may be empty)");
  if (intent.claims !== undefined && (!Array.isArray(intent.claims) || !intent.claims.every(isText))) problems.push("intent.claims must be a list of sentences");
  return problems;
}

export function checkLedger(ledger, items) {
  const problems = [];
  if (!isObject(ledger)) return ["ledger.json must hold an object"];
  if (isText(ledger.failed)) return [];
  if (!Array.isArray(ledger.entries)) return ["ledger.entries must be a list"];
  ledger.entries.forEach((entry, index) => {
    const where = `ledger.entries[${index}]`;
    if (!isText(entry?.file)) problems.push(`${where}.file is missing`);
    if (!Array.isArray(entry?.assumptions)) problems.push(`${where}.assumptions must be a list`);
    for (const [at, item] of (entry?.assumptions ?? []).entries()) {
      if (!isText(item?.assumption)) problems.push(`${where}.assumptions[${at}].assumption is missing`);
      const cited = isText(item?.enforced_at) && CITATION.test(item.enforced_at);
      if (!cited && !isText(item?.question)) problems.push(`${where}.assumptions[${at}] needs enforced_at as file:line or a question`);
    }
  });
  const covered = new Set(ledger.entries.map((entry) => entry?.file));
  for (const item of items) if (!covered.has(item)) problems.push(`ledger has no entry for high-risk file ${item}`);
  return problems;
}

export function checkFinderOutput(output, job) {
  if (!isObject(output)) return [`${job.id}: the output must be an object`];
  if (output.job !== job.id) return [`${job.id}: the output names job ${JSON.stringify(output.job)}`];
  if (isText(output.failed)) return [];
  const problems = [];
  if (!Array.isArray(output.candidates)) problems.push(`${job.id}: candidates must be a list`);
  else if (output.candidates.length > LIMITS.candidates) problems.push(`${job.id}: ${output.candidates.length} candidates exceed the limit of ${LIMITS.candidates}; keep the ${LIMITS.candidates} most severe`);
  if (!Array.isArray(output.files_read)) problems.push(`${job.id}: files_read must be a list`);
  if (!Array.isArray(output.declined)) problems.push(`${job.id}: declined must be a list (it may be empty)`);
  for (const [index, read] of (output.files_read ?? []).entries()) {
    if (!isText(read?.path) || !["full", "hunks"].includes(read?.read)) problems.push(`${job.id}: files_read[${index}] needs a path and read full or hunks`);
  }
  for (const [index, item] of (output.declined ?? []).entries()) {
    if (!isText(item?.topic) || !isText(item?.reason)) problems.push(`${job.id}: declined[${index}] needs a topic and a reason`);
  }
  for (const [index, candidate] of (output.candidates ?? []).entries()) {
    if (!isObject(candidate)) problems.push(`${job.id}: candidates[${index}] is not an object`);
  }
  return problems;
}

export function candidateDefects(candidate, lenses) {
  const defects = [];
  if (!isText(candidate.title)) defects.push("no title");
  if (!lenses.includes(candidate.lens)) defects.push(`lens ${JSON.stringify(candidate.lens)} is not one of ${lenses.join(", ")}`);
  if (!SEVERITIES.includes(candidate.severity)) defects.push(`severity ${JSON.stringify(candidate.severity)} is not one of ${SEVERITIES.join(", ")}`);
  if (!CONFIDENCES.includes(candidate.confidence)) defects.push(`confidence ${JSON.stringify(candidate.confidence)} is not one of ${CONFIDENCES.join(", ")}`);
  if (!Array.isArray(candidate.locations) || candidate.locations.length === 0) defects.push("no location");
  else candidate.locations.forEach((location, index) => defects.push(...checkLocation(location, `locations[${index}]`)));
  for (const field of requiredFields(candidate.severity)) if (!isText(candidate[field])) defects.push(`no ${field}`);
  if (candidate.evidence !== undefined && !Array.isArray(candidate.evidence)) defects.push("evidence is not a list");
  if (candidate.shape !== undefined && !(typeof candidate.shape === "string" && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(candidate.shape))) defects.push("shape is not a lowercase slug");
  return defects;
}

export function checkVerifierOutput(output, group) {
  if (!isObject(output)) return [`${group}: the verifier output must be an object`];
  if (output.group !== group) return [`${group}: the verifier output names group ${JSON.stringify(output.group)}`];
  if (isText(output.failed)) return [];
  const problems = [];
  if (!STATUSES.includes(output.status)) problems.push(`${group}: status must be one of ${STATUSES.join(", ")}`);
  if (!CONFIDENCES.includes(output.confidence)) problems.push(`${group}: confidence must be one of ${CONFIDENCES.join(", ")}`);
  if (output.severity !== undefined && output.severity !== null && !SEVERITIES.includes(output.severity)) problems.push(`${group}: severity must be one of ${SEVERITIES.join(", ")}`);
  if (!Array.isArray(output.checked) || output.checked.length === 0 || !output.checked.every(isText)) problems.push(`${group}: checked must list what the verifier read or ran`);
  problems.push(...statusConfidenceProblems(output.status, output.confidence, `${group}: ${output.status === "confirmed" ? "a confirmed finding" : "needs_verification"}`));
  if (output.pre_existing !== undefined && typeof output.pre_existing !== "boolean") problems.push(`${group}: pre_existing must be true or false`);
  return problems;
}

export function refutationCited(output) {
  return isText(output?.refutation) && CITATION.test(output.refutation);
}

export function conflictProblem(conflict) {
  return !isObject(conflict) || !Array.isArray(conflict.claims) || conflict.claims.length < 2 || !conflict.claims.every(isText) || !isText(conflict.resolution);
}

export function findingProblems(finding, where, { solo }) {
  const problems = [];
  if (!SEVERITIES.includes(finding.severity)) problems.push(`${where}: severity must be one of ${SEVERITIES.join(", ")}`);
  if (!CONFIDENCES.includes(finding.confidence)) problems.push(`${where}: confidence must be one of ${CONFIDENCES.join(", ")}`);
  if (!["confirmed", "needs_verification"].includes(finding.status)) problems.push(`${where}: status must be confirmed or needs_verification; refuted groups belong in dropped`);
  problems.push(...statusConfidenceProblems(finding.status, finding.confidence, `${where}: ${finding.status === "confirmed" ? "a confirmed finding" : "a needs_verification finding"}`));
  if (!isText(finding.title)) problems.push(`${where}: title is missing`);
  if (!Array.isArray(finding.locations) || finding.locations.length === 0) problems.push(`${where}: at least one location is required`);
  else finding.locations.forEach((location, index) => problems.push(...checkLocation(location, `${where}.locations[${index}]`)));
  for (const field of requiredFields(finding.severity)) if (!isText(finding[field])) problems.push(`${where}: ${field} is missing`);
  if (finding.status === "confirmed" && finding.severity !== "note" && BANNED_LEADS.test(finding.required_action ?? "")) {
    problems.push(`${where}: required_action starts with a vague verb; name the concrete change`);
  }
  if (finding.status === "confirmed") {
    const verification = finding.verification;
    if (!isObject(verification) || !Array.isArray(verification.checked) || verification.checked.length === 0) {
      problems.push(`${where}: a confirmed finding needs verification.checked`);
    } else if (!solo && verification.verifier === "self") {
      problems.push(`${where}: this run used verifier agents, so verification.verifier cannot be self`);
    }
  }
  if (finding.conflict !== undefined && conflictProblem(finding.conflict)) {
    problems.push(`${where}: conflict needs both claims quoted and the evidence that settled it`);
  }
  return problems;
}
