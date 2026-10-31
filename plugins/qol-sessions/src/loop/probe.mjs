import { changedPaths } from "./diff.mjs";

function filesOf(gate, diff) {
  const listed = Array.isArray(gate?.changed) ? gate.changed : changedPaths(diff);
  return [...new Set(listed)].sort();
}

function judgeStatuses(gate) {
  return new Map((gate?.judges ?? []).map((judge) => [judge.id, judge.status]));
}

function fingerprints(gate) {
  return new Set((gate?.findings ?? []).filter((finding) => !finding.baseline).map((finding) => finding.fingerprint ?? finding.id));
}

function sameSet(a, b) {
  return a.size === b.size && [...a].every((value) => b.has(value));
}

function compareAgainst(first, other, position) {
  const label = `implementer 1 vs ${position}`;
  const reasons = [];
  const verdictA = first.gate?.verdict ?? "missing";
  const verdictB = other.gate?.verdict ?? "missing";
  if (verdictA !== verdictB) reasons.push(`${label}: gate verdicts differ (${verdictA} vs ${verdictB})`);
  const filesA = filesOf(first.gate, first.diff);
  const filesB = filesOf(other.gate, other.diff);
  const onlyA = filesA.filter((file) => !filesB.includes(file));
  const onlyB = filesB.filter((file) => !filesA.includes(file));
  if (onlyA.length > 0 || onlyB.length > 0) {
    reasons.push(`${label}: changed files differ (only in 1: ${onlyA.join(", ") || "none"}; only in ${position}: ${onlyB.join(", ") || "none"})`);
  }
  const statusA = judgeStatuses(first.gate);
  const statusB = judgeStatuses(other.gate);
  for (const [id, status] of statusA) {
    if (statusB.has(id) && statusB.get(id) !== status) reasons.push(`${label}: judge ${id} differs (${status} vs ${statusB.get(id)})`);
  }
  if (verdictA === "findings" && verdictB === "findings" && !sameSet(fingerprints(first.gate), fingerprints(other.gate))) {
    reasons.push(`${label}: both are red but on different findings`);
  }
  return reasons;
}

export function compareImplementers(gates, diffs = []) {
  const entries = (gates ?? []).map((gate, index) => ({ gate, diff: diffs[index] ?? "" }));
  if (entries.length < 2) return { ambiguous: false, reasons: [] };
  const [first, ...rest] = entries;
  const reasons = [];
  rest.forEach((other, offset) => {
    const identical = typeof first.diff === "string" && first.diff !== "" && first.diff === other.diff;
    if (!identical) reasons.push(...compareAgainst(first, other, offset + 2));
  });
  return { ambiguous: reasons.length > 0, reasons };
}
