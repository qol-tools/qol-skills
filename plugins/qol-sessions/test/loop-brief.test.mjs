import assert from "node:assert/strict";
import test from "node:test";

import { LANE_RULES, buildBrief } from "../src/loop/brief.mjs";

const SPEC = {
  front: { owned: ["plugins/x/**", "docs/x.md"], accept: [{ id: "unit", argv: ["node", "--test", "a.test.mjs"] }] },
  body: "# Feature\n\nDo the thing.\n",
  path: "/repo/.git/qol-sessions/loops/demo/spec.md",
};

function order(brief, markers) {
  const positions = markers.map((marker) => brief.indexOf(marker));
  assert.ok(positions.every((position) => position >= 0), `${markers.join(", ")} -> ${positions.join(", ")}`);
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
}

test("the five parts come first and in order", () => {
  const brief = buildBrief({ spec: SPEC });
  order(brief, ["Role: implement", "## Owned paths", "## Spec document", "## Rules", "## Report", "## Spec\n"]);
  assert.match(brief, /- plugins\/x\/\*\*\n- docs\/x\.md/);
  assert.ok(brief.includes(SPEC.path));
  assert.match(brief, /files and lines you changed plus any conscious deviations/);
});

test("the lane rules cover owned paths, tooling, comments and the question line", () => {
  const brief = buildBrief({ spec: SPEC });
  for (const rule of LANE_RULES) assert.ok(brief.includes(`- ${rule}`), rule);
  assert.match(brief, /Edit only the owned paths/);
  assert.match(brief, /Never run build, test, lint, format or git commands/);
  assert.match(brief, /QUESTION:/);
});

test("the spec body is embedded in a fence longer than any backtick run inside it", () => {
  const body = "text\n\n```js\nconst a = 1;\n```\n";
  const brief = buildBrief({ spec: { ...SPEC, body } });
  assert.ok(brief.includes("````markdown\ntext"));
  assert.ok(brief.trimEnd().endsWith("````"));
});

test("traps, findings, verdict and answer sections appear only when given", () => {
  const plain = buildBrief({ spec: SPEC });
  for (const heading of ["## Known traps", "## Gate findings", "## Architect verdict", "## Answer"]) assert.ok(!plain.includes(heading), heading);
  const full = buildBrief({
    spec: SPEC,
    traps: [{ judge: "qac", rule: "no-comments", message: "comment added", loops: ["a", "b"] }],
    findings: [{ id: "qac#1", judge: "qac", rule: "no-comments", file: "src/a.mjs", line: 7, message: "comment\nadded" }],
    verdict: { blame: "impl", finding: "qac#1", hunk: "src/a.mjs:7", why: "remove the comment" },
    answer: "use the second option",
  });
  order(full, ["## Rules", "## Report", "## Known traps", "## Gate findings", "## Architect verdict", "## Answer", "## Acceptance checks", "## Spec\n"]);
  assert.match(full, /- qac \/ no-comments: comment added \(caught first time in 2 earlier loops\)/);
  assert.match(full, /- qac#1 qac \/ no-comments at src\/a\.mjs:7: comment added/);
  assert.match(full, /- why: remove the comment/);
  assert.match(full, /use the second option/);
  assert.match(full, /- unit: node --test a\.test\.mjs/);
});

test("a finding without a file or line still renders", () => {
  const brief = buildBrief({ spec: SPEC, findings: [{ judge: "tamper", rule: "owner", message: "outside owned paths" }] });
  assert.match(brief, /- tamper \/ owner at \(no file\): outside owned paths/);
});

test("the brief never contains an em-dash", () => {
  const brief = buildBrief({ spec: SPEC, traps: [{ judge: "j", rule: "r", message: "m" }], findings: [{ judge: "j", rule: "r", message: "m" }], answer: "a" });
  assert.ok(!brief.includes(String.fromCharCode(0x2014)));
});
