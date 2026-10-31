import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { appendRetro, legacyRetroFile, normalizeRetro, retroFile, retroLine } from "../src/loop/retro.mjs";

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "loop-retro-"));
}

const LOOP = { key: "k1", lane: { tool: "claude", model: "claude-sonnet-5-5" }, control: true };

const ATTEMPTS = [
  { n: 1, index: null, gate: { verdict: "findings", tamper: [{ id: "tamper#1" }] }, lane: { cost_usd: 0.5 }, verdict: null },
  { n: 2, index: null, gate: { verdict: "clean", tamper: [] }, lane: { cost_usd: 0.25 }, verdict: { blame: "judge" } },
];

test("retroLine carries the documented fields plus the schema 2 additions", () => {
  const line = retroLine({ loop: LOOP, attempts: ATTEMPTS, outcome: "accepted", now: new Date("2026-10-31T10:00:00Z") });
  assert.deepEqual(Object.keys(line), [
    "date", "loop_key", "tool", "model", "rounds", "correction_rounds", "review_caught_defects", "lane_deviations",
    "verdict", "skill_gap", "nudge", "schema", "gate_attempts", "blame", "slips", "cost_usd", "control",
  ]);
  assert.equal(line.date, "2026-10-31");
  assert.equal(line.loop_key, "k1");
  assert.equal(line.tool, "claude");
  assert.equal(line.model, "claude-sonnet-5-5");
  assert.equal(line.rounds, 2);
  assert.equal(line.correction_rounds, 1);
  assert.equal(line.review_caught_defects, 1);
  assert.equal(line.lane_deviations, 1);
  assert.match(line.verdict, /^accepted: 2 attempts, 1 red gate, latest gate clean\.$/);
  assert.equal(line.skill_gap, null);
  assert.equal(line.nudge, null);
  assert.equal(line.schema, 2);
  assert.equal(line.gate_attempts, 2);
  assert.equal(line.blame, "judge");
  assert.equal(line.slips, 1);
  assert.equal(line.cost_usd, 0.75);
  assert.equal(line.control, true);
});

test("retroLine copes with a loop that never ran an attempt", () => {
  const line = retroLine({ loop: { key: "k2", lane: {} }, attempts: [], outcome: "paused", now: new Date("2026-10-31T10:00:00Z") });
  assert.equal(line.rounds, 0);
  assert.equal(line.correction_rounds, 0);
  assert.equal(line.blame, null);
  assert.equal(line.cost_usd, 0);
  assert.equal(line.control, false);
  assert.equal(line.tool, null);
  assert.match(line.verdict, /^paused: 0 attempts, 0 red gates, latest gate none\.$/);
});

test("two implementers of one round count as a single round", () => {
  const attempts = [
    { n: 1, index: 1, gate: { verdict: "clean", tamper: [] }, lane: null, verdict: null },
    { n: 1, index: 2, gate: { verdict: "findings", tamper: [] }, lane: null, verdict: null },
  ];
  const line = retroLine({ loop: LOOP, attempts, outcome: "accepted", now: new Date("2026-10-31T10:00:00Z") });
  assert.equal(line.rounds, 1);
  assert.equal(line.gate_attempts, 2);
});

test("retroFile honours QOL_SESSIONS_RETRO and otherwise uses the qol-tray config dir", () => {
  assert.equal(retroFile({ env: { QOL_SESSIONS_RETRO: "/x/r.jsonl", HOME: "/h" } }), "/x/r.jsonl");
  assert.equal(retroFile({ env: { HOME: "/h" } }), "/h/.config/qol-tray/sessions-retro.jsonl");
  assert.equal(legacyRetroFile("/a/sessions-retro.jsonl"), "/a/sessions-retro.v1.jsonl");
});

test("appendRetro appends one JSON line per call", () => {
  const root = tmp();
  const file = path.join(root, "deep", "sessions-retro.jsonl");
  const env = { QOL_SESSIONS_RETRO: file };
  assert.equal(appendRetro({ a: 1 }, { env }), file);
  appendRetro({ b: 2 }, { env });
  assert.deepEqual(fs.readFileSync(file, "utf8").split("\n"), ['{"a":1}', '{"b":2}', ""]);
});

test("normalizeRetro backs up the ledger, types numbers and adds schema 1 once", () => {
  const root = tmp();
  const file = path.join(root, "sessions-retro.jsonl");
  const env = { QOL_SESSIONS_RETRO: file };
  const original = [
    JSON.stringify({ date: "2026-09-24", loop_key: "a", rounds: "2", correction_rounds: "0", review_caught_defects: 3, lane_deviations: "1", skill_gap: null }),
    JSON.stringify({ date: "2026-09-27", loop_key: "b", rounds: 1, correction_rounds: 0, review_caught_defects: 0, lane_deviations: 0 }),
    "not json at all",
    JSON.stringify({ date: "2026-10-31", loop_key: "c", rounds: 1, schema: 2 }),
    "",
  ].join("\n");
  fs.writeFileSync(file, original);
  const first = normalizeRetro({ env });
  assert.equal(first.normalized, true);
  assert.equal(first.backed_up, true);
  assert.equal(first.changed, 2);
  assert.equal(fs.readFileSync(path.join(root, "sessions-retro.v1.jsonl"), "utf8"), original);
  const lines = fs.readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 4);
  const [a, b] = lines.map((line) => {
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  });
  assert.deepEqual([a.rounds, a.correction_rounds, a.review_caught_defects, a.lane_deviations, a.schema], [2, 0, 3, 1, 1]);
  assert.equal(b.schema, 1);
  assert.equal(lines[2], "not json at all");
  assert.equal(JSON.parse(lines[3]).schema, 2);
  const second = normalizeRetro({ env });
  assert.equal(second.normalized, false);
  assert.equal(second.changed, 0);
  assert.equal(second.backed_up, false);
  assert.equal(fs.readFileSync(path.join(root, "sessions-retro.v1.jsonl"), "utf8"), original);
});

test("normalizeRetro never overwrites an existing backup", () => {
  const root = tmp();
  const file = path.join(root, "sessions-retro.jsonl");
  const backup = path.join(root, "sessions-retro.v1.jsonl");
  fs.writeFileSync(file, `${JSON.stringify({ rounds: "3" })}\n`);
  fs.writeFileSync(backup, "precious\n");
  const result = normalizeRetro({ env: { QOL_SESSIONS_RETRO: file } });
  assert.equal(result.backed_up, false);
  assert.equal(fs.readFileSync(backup, "utf8"), "precious\n");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).rounds, 3);
});

test("normalizeRetro reports a missing ledger without creating one", () => {
  const root = tmp();
  const file = path.join(root, "sessions-retro.jsonl");
  const result = normalizeRetro({ env: { QOL_SESSIONS_RETRO: file } });
  assert.equal(result.normalized, false);
  assert.equal(result.reason, "no retro file");
  assert.equal(fs.existsSync(file), false);
});
