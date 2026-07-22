const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const script = path.join(repoRoot, "scripts", "check-skill-invariants.cjs");
const { audit, scanText } = require(script);

function makeSkillRoot(text) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qol-skill-invariants-"));
  const file = path.join(root, "plugins", "alpha", "skills", "alpha", "SKILL.md");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return root;
}

test("flags temporal state, status snapshots, fixed inventories, and mutable versions", () => {
  const violations = scanText([
    "This currently supports the three plugins.",
    "**Status:** aspirational.",
    "Verified against GPUI 0.2.2 on 2026-07-19.",
    "## Current State",
    "- Platforms: Linux and macOS",
  ].join("\n"));

  assert.deepEqual(
    new Set(violations.map((violation) => violation.rule)),
    new Set([
      "temporal-state",
      "fixed-inventory",
      "status-snapshot",
      "dated-verification",
      "mutable-version",
      "snapshot-section",
      "manifest-snapshot",
    ]),
  );
});

test("allows behavioral cardinality and live runtime state", () => {
  const violations = scanText([
    "Keep one implementation per OS.",
    "Cap output at 5 items.",
    "The slot is currently showing the editor.",
    "Branches may contain WIP commits.",
  ].join("\n"));

  assert.deepEqual(violations, []);
});

test("flags versioned action inventory counts", () => {
  const violations = scanText("The 18 v1 action IDs exist.");

  assert.deepEqual(violations.map((violation) => violation.rule), ["fixed-inventory"]);
});

test("ignores examples and constants inside code spans and fenced blocks", () => {
  const violations = scanText([
    "Use `currently` only when quoting an anti-pattern.",
    "```text",
    "There are three plugins as of today.",
    "```",
    "The timeout is `3.0` seconds.",
  ].join("\n"));

  assert.deepEqual(violations, []);
});

test("audits every maintained skill and emits relative paths", () => {
  const root = makeSkillRoot("---\nname: alpha\ndescription: Alpha.\n---\n\nThere are three plugins.\n");
  const report = audit(root);

  assert.equal(report.skill_count, 1);
  assert.equal(report.violation_count, 1);
  assert.equal(report.violations[0].file, "plugins/alpha/skills/alpha/SKILL.md");
});

test("fails closed when the selected root contains no maintained skills", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qol-skill-invariants-empty-"));
  const report = audit(root);

  assert.equal(report.status, "violations");
  assert.equal(report.violations[0].rule, "no-skills-found");
});

test("CLI writes a machine-readable report and fails on violations", () => {
  const root = makeSkillRoot("---\nname: alpha\ndescription: Alpha.\n---\n\nThis is currently unfinished.\n");
  const reportFile = path.join(root, "artifacts", "report.json");
  const result = spawnSync("node", [script, "--root", root, "--report", reportFile], { encoding: "utf8" });
  const report = JSON.parse(fs.readFileSync(reportFile, "utf8"));

  assert.equal(result.status, 1);
  assert.equal(report.status, "violations");
  assert.equal(report.violation_count, 1);
});

test("maintained skills pass the invariance audit", () => {
  const report = audit(repoRoot);

  assert.deepEqual(report.violations, []);
});
