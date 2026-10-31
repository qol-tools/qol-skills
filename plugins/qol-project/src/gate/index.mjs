import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";
import { withLock } from "../lock.mjs";
import { DEFAULT_RETENTION_LOOPS } from "./config.mjs";

const NULL_LOOP_KEEP_MS = 30 * 24 * 60 * 60 * 1000;

export function gatesFile(commonDir) {
  return path.join(commonDir, "qac", "gates.jsonl");
}

function parseLines(text) {
  const lines = [];
  for (const raw of text.split("\n")) {
    if (!raw.trim()) continue;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) lines.push(parsed);
    } catch {
      continue;
    }
  }
  return lines;
}

function toMs(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function prune(lines, loops, nowMs) {
  const lastSeen = new Map();
  lines.forEach((line, index) => {
    if (line.loop != null) lastSeen.set(line.loop, index);
  });
  const newest = new Set([...lastSeen].sort((a, b) => b[1] - a[1]).slice(0, loops).map(([key]) => key));
  const cutoff = nowMs - NULL_LOOP_KEEP_MS;
  return lines.filter(line => (line.loop == null ? !(Date.parse(line.at) < cutoff) : newest.has(line.loop)));
}

function existingLines(file, read) {
  try {
    return parseLines(read(file, "utf8"));
  } catch {
    return [];
  }
}

export function appendGate(commonDir, line, deps = {}) {
  const file = gatesFile(commonDir);
  const read = deps.read ?? readFileSync;
  const entry = { ...line };
  const requested = deps.retentionLoops ?? entry.retentionLoops;
  delete entry.retentionLoops;
  const loops = Number.isInteger(requested) && requested > 0 ? requested : DEFAULT_RETENTION_LOOPS;
  const stamp = deps.now ? deps.now() : entry.at ?? new Date().toISOString();
  entry.at ??= typeof stamp === "string" ? stamp : new Date(toMs(stamp)).toISOString();
  return withLock(file, () => {
    const all = [...existingLines(file, read), entry];
    const kept = prune(all, loops, toMs(stamp));
    if (kept.length === all.length) {
      appendFileSync(file, `${JSON.stringify(entry)}\n`);
    } else {
      const temp = `${file}.tmp`;
      writeFileSync(temp, kept.map(item => `${JSON.stringify(item)}\n`).join(""));
      renameSync(temp, file);
    }
    return { file, kept: kept.length, dropped: all.length - kept.length };
  }, deps);
}

export function readGates(commonDir, deps = {}) {
  return existingLines(gatesFile(commonDir), deps.read ?? readFileSync);
}

export function findTraps(lines, { repoId, min = 2 } = {}) {
  const traps = new Map();
  for (const line of lines) {
    if (line.attempt !== 1 || line.loop == null) continue;
    if (repoId !== undefined && line.repo_id !== repoId) continue;
    for (const finding of line.findings ?? []) {
      if (finding.status !== "caught") continue;
      const trap = traps.get(finding.fingerprint) ?? { loops: new Set() };
      trap.fingerprint = finding.fingerprint;
      trap.judge = finding.judge;
      trap.rule = finding.rule;
      trap.message = finding.message;
      trap.loops.add(line.loop);
      traps.set(finding.fingerprint, trap);
    }
  }
  return [...traps.values()]
    .filter(trap => trap.loops.size >= min)
    .map(({ fingerprint, judge, rule, message, loops }) => ({ fingerprint, judge, rule, message, loops: [...loops].sort() }))
    .sort((a, b) => b.loops.length - a.loops.length || a.fingerprint.localeCompare(b.fingerprint));
}
