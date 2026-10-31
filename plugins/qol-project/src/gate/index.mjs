import { closeSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import path from "node:path";

const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10000;
const LOCK_RETRY_MS = 25;
const NULL_LOOP_KEEP_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_RETENTION_LOOPS = 50;

export function gatesFile(commonDir) {
  return path.join(commonDir, "qac", "gates.jsonl");
}

function sleepMs(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function removeIfStale(lock, nowMs) {
  try {
    if (nowMs - statSync(lock).mtimeMs <= LOCK_STALE_MS) return false;
    unlinkSync(lock);
    return true;
  } catch (error) {
    return error.code === "ENOENT";
  }
}

function acquire(lock, deps) {
  const nowMs = deps.nowMs ?? Date.now;
  const sleep = deps.sleep ?? sleepMs;
  const deadline = nowMs() + LOCK_WAIT_MS;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      return;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (removeIfStale(lock, nowMs())) continue;
      if (nowMs() >= deadline) throw new Error(`gate index lock is busy: ${lock}`);
      sleep(LOCK_RETRY_MS);
    }
  }
}

function release(lock) {
  try {
    unlinkSync(lock);
  } catch {
    return;
  }
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
  mkdirSync(path.dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  acquire(lock, deps);
  try {
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
  } finally {
    release(lock);
  }
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
