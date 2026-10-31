import assert from "node:assert/strict";
import test from "node:test";

import { parseSpec, validateFront } from "../src/loop/spec.mjs";

const FRONT = {
  lane: { tool: "claude", model: "claude-sonnet-5-5", effort: "high" },
  owned: ["plugins/x/**"],
  accept: [{ id: "unit", argv: ["node", "--test", "plugins/x/test/a.test.mjs"] }],
  implementers: 1,
  budget_usd: 5,
};

function specText(front, info = "json loop") {
  return `# Title\n\nIntro text.\n\n\`\`\`${info}\n${JSON.stringify(front, null, 2)}\n\`\`\`\n\n## Details\n\nMore text.\n`;
}

test("a valid block parses and the body drops the fence", () => {
  const parsed = parseSpec(specText(FRONT));
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.front, FRONT);
  assert.match(parsed.body, /^# Title/);
  assert.match(parsed.body, /## Details/);
  assert.doesNotMatch(parsed.body, /json loop|claude-sonnet/);
});

test("defaults fill accept and implementers", () => {
  const { lane, owned } = FRONT;
  const parsed = parseSpec(specText({ lane, owned }));
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.front.accept, []);
  assert.equal(parsed.front.implementers, 1);
});

test("a tilde fence works and other fence tags are ignored", () => {
  const text = `~~~json loop\n${JSON.stringify(FRONT)}\n~~~\n\n\`\`\`json ratchet\n{}\n\`\`\`\n`;
  assert.deepEqual(parseSpec(text).errors, []);
});

test("zero or two loop blocks are errors", () => {
  assert.match(parseSpec("# nothing here").errors[0], /found 0/);
  assert.equal(parseSpec("# nothing here").front, null);
  const twice = `${specText(FRONT)}\n${specText(FRONT)}`;
  assert.match(parseSpec(twice).errors[0], /found 2/);
  assert.match(parseSpec(specText(FRONT, "json ratchet")).errors[0], /found 0/);
});

test("invalid JSON and an unclosed fence are errors", () => {
  assert.match(parseSpec("```json loop\n{nope\n```\n").errors[0], /invalid JSON/);
  assert.match(parseSpec("```json loop\n{}\n").errors[0], /never closed/);
});

test("a missing model is an error and never gets a default", () => {
  const parsed = parseSpec(specText({ ...FRONT, lane: { tool: "claude" } }));
  assert.ok(parsed.errors.some((error) => /lane\.model is required/.test(error)));
});

const INVALID = [
  ["lane is not an object", { ...FRONT, lane: "claude" }, /lane must be an object/],
  ["missing tool", { ...FRONT, lane: { model: "m" } }, /lane\.tool is required/],
  ["bad effort", { ...FRONT, lane: { tool: "claude", model: "m", effort: "turbo" } }, /lane\.effort/],
  ["owned missing", { lane: FRONT.lane }, /owned must be a non-empty array/],
  ["owned empty", { ...FRONT, owned: [] }, /owned must be a non-empty array/],
  ["owned entry blank", { ...FRONT, owned: ["a", " "] }, /owned must be a non-empty array/],
  ["accept not an array", { ...FRONT, accept: "x" }, /accept must be an array/],
  ["accept entry without argv", { ...FRONT, accept: [{ id: "u" }] }, /accept\[0\]\.argv/],
  ["accept id with a slash", { ...FRONT, accept: [{ id: "a/b", argv: ["x"] }] }, /accept\[0\]\.id/],
  ["accept duplicate id", { ...FRONT, accept: [{ id: "u", argv: ["x"] }, { id: "u", argv: ["y"] }] }, /more than once/],
  ["three implementers", { ...FRONT, implementers: 3 }, /implementers must be 1 or 2/],
  ["zero budget", { ...FRONT, budget_usd: 0 }, /budget_usd/],
  ["string budget", { ...FRONT, budget_usd: "5" }, /budget_usd/],
  ["unknown key", { ...FRONT, budgt_usd: 5 }, /unknown key budgt_usd/],
];

for (const [name, front, pattern] of INVALID) {
  test(`validateFront rejects: ${name}`, () => {
    const errors = validateFront(front);
    assert.ok(errors.some((error) => pattern.test(error)), errors.join(" | "));
    assert.ok(parseSpec(specText(front)).errors.length > 0);
  });
}

test("validateFront rejects non-objects and accepts a minimal front", () => {
  assert.deepEqual(validateFront(null), ["the loop block must be a JSON object"]);
  assert.deepEqual(validateFront([]), ["the loop block must be a JSON object"]);
  assert.deepEqual(validateFront({ lane: { tool: "claude", model: "m" }, owned: ["a/**"] }), []);
});
