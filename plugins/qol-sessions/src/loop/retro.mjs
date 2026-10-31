import os from "node:os";
import path from "node:path";
import { withDefaults } from "./paths.mjs";

const NUMERIC_FIELDS = ["rounds", "correction_rounds", "review_caught_defects", "lane_deviations"];

export function retroFile(deps) {
  const d = withDefaults(deps);
  if (d.env.QOL_SESSIONS_RETRO) return d.env.QOL_SESSIONS_RETRO;
  return path.join(d.env.HOME ?? os.homedir(), ".config", "qol-tray", "sessions-retro.jsonl");
}

export function legacyRetroFile(file) {
  return file.endsWith(".jsonl") ? `${file.slice(0, -".jsonl".length)}.v1.jsonl` : `${file}.v1`;
}

function countOf(value) {
  return Array.isArray(value) ? value.length : 0;
}

function lastBlame(attempts) {
  const blames = attempts.map((attempt) => attempt.verdict?.blame).filter(Boolean);
  return blames.length > 0 ? blames.at(-1) : null;
}

function costOf(attempts) {
  const total = attempts.reduce((sum, attempt) => sum + (Number(attempt.lane?.cost_usd) || 0), 0);
  return Math.round(total * 10000) / 10000;
}

export function retroLine({ loop, attempts, outcome, now }) {
  const rounds = new Set(attempts.map((attempt) => attempt.n)).size;
  const gated = attempts.filter((attempt) => attempt.gate);
  const redGates = gated.filter((attempt) => attempt.gate.verdict === "findings").length;
  const tamper = gated.reduce((sum, attempt) => sum + countOf(attempt.gate.tamper), 0);
  const slips = attempts.filter((attempt) => attempt.verdict?.blame === "judge").length;
  const latest = gated.at(-1)?.gate?.verdict ?? "none";
  return {
    date: now.toISOString().slice(0, 10),
    loop_key: loop.key,
    tool: loop.lane?.tool ?? null,
    model: loop.lane?.model ?? null,
    rounds,
    correction_rounds: Math.max(0, rounds - 1),
    review_caught_defects: redGates,
    lane_deviations: tamper,
    verdict: `${outcome}: ${rounds} attempt${rounds === 1 ? "" : "s"}, ${redGates} red gate${redGates === 1 ? "" : "s"}, latest gate ${latest}.`,
    skill_gap: null,
    nudge: null,
    schema: 2,
    gate_attempts: gated.length,
    blame: lastBlame(attempts),
    slips,
    cost_usd: costOf(attempts),
    control: Boolean(loop.control),
  };
}

export function appendRetro(line, deps) {
  const d = withDefaults(deps);
  const file = retroFile(d);
  d.append(file, `${JSON.stringify(line)}\n`);
  return file;
}

function normalizeLine(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { text: raw, changed: false };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { text: raw, changed: false };
  let changed = false;
  for (const field of NUMERIC_FIELDS) {
    const value = parsed[field];
    if (typeof value !== "string" || value.trim() === "" || Number.isNaN(Number(value))) continue;
    parsed[field] = Number(value);
    changed = true;
  }
  if (parsed.schema === undefined) {
    parsed.schema = 1;
    changed = true;
  }
  return { text: changed ? JSON.stringify(parsed) : raw, changed };
}

export function normalizeRetro(deps) {
  const d = withDefaults(deps);
  const file = retroFile(d);
  if (!d.exists(file)) return { normalized: false, file, reason: "no retro file", lines: 0, changed: 0 };
  const original = d.read(file);
  const backup = legacyRetroFile(file);
  let backedUp = false;
  if (!d.exists(backup)) {
    d.write(backup, original);
    backedUp = true;
  }
  let changed = 0;
  const lines = original.split("\n").filter((line) => line.trim() !== "");
  const out = lines.map((raw) => {
    const result = normalizeLine(raw);
    if (result.changed) changed += 1;
    return result.text;
  });
  if (changed > 0) d.write(file, `${out.join("\n")}\n`);
  return { normalized: changed > 0, file, backup, backed_up: backedUp, lines: lines.length, changed };
}
