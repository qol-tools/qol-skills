import { createHash } from "node:crypto";
import { join } from "node:path";
import { LENS_NAMES } from "./lenses.mjs";
import { jobInputs } from "./run.mjs";
import { CONFIDENCES, SEVERITIES, candidateDefects, rank } from "./schema.mjs";

const STOP = new Set(["the", "and", "for", "with", "when", "that", "this", "from", "into", "not", "are", "can", "may", "does", "its", "but", "has", "have", "missing", "wrong"]);

export function digestOf(outputs) {
  const hash = createHash("sha1");
  for (const [id, output] of [...outputs].sort(([left], [right]) => (left < right ? -1 : 1))) {
    const { agent_id: _agent, ...content } = output;
    hash.update(`${id}\0${JSON.stringify(content)}\0`);
  }
  return hash.digest("hex");
}

export function spansOf(locations) {
  return locations.map((location) => ({
    file: location.file,
    side: location.side ?? "head",
    start: location.line,
    end: location.end_line ?? location.line,
  }));
}

export function nearSpans(left, right) {
  return left.file === right.file && left.side === right.side && left.start <= right.end + 3 && right.start <= left.end + 3;
}

function tokens(title) {
  return new Set(String(title).toLowerCase().split(/[^a-z0-9_]+/).filter((word) => word.length >= 3 && !STOP.has(word)));
}

export function similarTitles(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  if (a.size === 0 || b.size === 0) return false;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared++;
  return shared / (a.size + b.size - shared) >= 0.5;
}

function related(left, right) {
  if (!similarTitles(left.title, right.title)) return false;
  const a = spansOf(left.locations);
  const b = spansOf(right.locations);
  return a.some((span) => b.some((other) => nearSpans(span, other)));
}

function representative(members) {
  return [...members].sort(
    (left, right) =>
      rank(SEVERITIES, left.severity) - rank(SEVERITIES, right.severity) ||
      rank(CONFIDENCES, left.confidence) - rank(CONFIDENCES, right.confidence) ||
      (right.evidence?.length ?? 0) - (left.evidence?.length ?? 0) ||
      (left.id < right.id ? -1 : 1),
  )[0];
}

function leadJob(group) {
  return group.candidates.find((candidate) => candidate.id === group.lead).job;
}

function unverifiedAfter(groups, cap) {
  if (cap === null) return [];
  const queues = new Map();
  for (const group of groups) queues.set(leadJob(group), [...(queues.get(leadJob(group)) ?? []), group.id]);
  const picked = new Set();
  while (picked.size < cap && [...queues.values()].some((queue) => queue.length > 0)) {
    for (const queue of queues.values()) {
      if (picked.size >= cap) break;
      if (queue.length > 0) picked.add(queue.shift());
    }
  }
  return groups.filter((group) => !picked.has(group.id)).map((group) => group.id);
}

export function locationKey(location) {
  return `${location.side ?? "head"}:${location.file}:${location.line}:${location.end_line ?? location.line}`;
}

function unionLocations(members) {
  const seen = new Map();
  for (const member of members) for (const location of member.locations) seen.set(locationKey(location), { side: "head", ...location });
  const all = [...seen.values()];
  const last = (location) => location.end_line ?? location.line;
  const inside = (inner, outer) => inner !== outer && inner.file === outer.file && inner.side === outer.side && outer.line <= inner.line && last(inner) <= last(outer);
  return all
    .filter((location) => !all.some((other) => inside(location, other)))
    .sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : left.line - right.line));
}

export function mergeCandidates({ jobs, outputs, check, verifierCap, final }) {
  const kept = [];
  const excluded = [];
  let received = 0;
  for (const job of jobs) {
    const output = outputs.get(job.id);
    if (!output || output.failed) continue;
    const lenses = job.kind === "hunt" ? LENS_NAMES : job.lenses;
    output.candidates.forEach((raw, index) => {
      received++;
      const candidate = { ...raw, id: `${job.id}#${index + 1}`, job: job.id, pass: job.pass ?? null };
      const reasons = candidateDefects(candidate, lenses);
      if (reasons.length === 0) {
        for (const location of candidate.locations) {
          const problem = check(location);
          if (problem) reasons.push(problem);
        }
      }
      if (reasons.length > 0) excluded.push({ id: candidate.id, job: job.id, title: candidate.title ?? null, reasons });
      else kept.push(candidate);
    });
  }
  const parent = kept.map((_, index) => index);
  const find = (index) => (parent[index] === index ? index : (parent[index] = find(parent[index])));
  for (let left = 0; left < kept.length; left++) {
    for (let right = left + 1; right < kept.length; right++) {
      if (related(kept[left], kept[right])) parent[find(right)] = find(left);
    }
  }
  const buckets = new Map();
  kept.forEach((candidate, index) => {
    const root = find(index);
    buckets.set(root, [...(buckets.get(root) ?? []), candidate]);
  });
  const groups = [...buckets.values()].map((members) => {
    const lead = representative(members);
    return {
      lenses: [...new Set(members.map((member) => member.lens))].sort((left, right) => rank(LENS_NAMES, left) - rank(LENS_NAMES, right)),
      severity: lead.severity,
      confidence: lead.confidence,
      title: lead.title,
      finder_pre_existing: members.some((member) => member.pre_existing),
      locations: unionLocations(members),
      found_by: [...new Set(members.map((member) => member.job))].sort(),
      passes: new Set(members.map((member) => member.pass).filter(Boolean)).size,
      lead: lead.id,
      candidates: members.map(({ id, job, pass, lens, title, severity, confidence, pre_existing, locations, trigger, observed, expected, evidence, required_action, shape }) => ({
        id, job, pass, lens, title, severity, confidence, pre_existing: Boolean(pre_existing), locations, trigger, observed, expected, evidence: evidence ?? [], required_action, ...(shape ? { shape } : {}),
      })),
    };
  });
  groups.sort(
    (left, right) =>
      rank(SEVERITIES, left.severity) - rank(SEVERITIES, right.severity) ||
      (left.locations[0].file < right.locations[0].file ? -1 : left.locations[0].file > right.locations[0].file ? 1 : 0) ||
      left.locations[0].line - right.locations[0].line,
  );
  groups.forEach((group, index) => {
    group.id = `G${String(index + 1).padStart(2, "0")}`;
  });
  const byReason = {};
  for (const item of excluded) for (const reason of item.reasons) {
    const key = reason.replace(/^[^ ]*:\d+ is past.*/, "line past the end of the file").replace(/^\S+ does not exist.*/, "file does not exist").replace(/^lens .*/, "lens outside the job");
    byReason[key] = (byReason[key] ?? 0) + 1;
  }
  const ordered = groups.map(({ id, ...rest }) => ({ id, ...rest }));
  return {
    final,
    stats: { received, excluded: excluded.length, kept: kept.length, groups: groups.length, excluded_by_reason: byReason },
    groups: ordered,
    excluded,
    unverified: unverifiedAfter(ordered, verifierCap),
  };
}

export function verifierDescriptor(group, { scope, paths, references, rubric }) {
  return {
    id: `verify-${group.id}`,
    kind: "verifier",
    group: group.id,
    run_dir: paths.dir,
    repo: scope.repo,
    tree: scope.tree,
    base_tree: scope.base_tree,
    rubric,
    base: scope.base,
    head: { ref: scope.head.ref, sha: scope.head.sha },
    instructions: join(references, "engine-verifier-prompt.md"),
    lens_guide: join(references, "engine-lenses.md"),
    claim: {
      lenses: group.lenses,
      title: group.title,
      severity: group.severity,
      finder_pre_existing: group.finder_pre_existing,
      locations: group.locations,
      candidates: group.candidates,
    },
    inputs: jobInputs(scope, paths),
    output: join(paths.verify, `${group.id}.result.json`),
  };
}
