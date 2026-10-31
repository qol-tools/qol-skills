import assert from "node:assert/strict";
import test from "node:test";

import { compareImplementers } from "../src/loop/probe.mjs";

const patch = (...files) => files.map((file) => `diff --git a/${file} b/${file}\n+x\n`).join("");
const gate = (verdict, extra = {}) => ({ verdict, changed: ["src/a.mjs"], judges: [{ id: "unit", status: verdict === "clean" ? "pass" : "fail" }], findings: [], ...extra });

test("fewer than two implementers is never ambiguous", () => {
  assert.deepEqual(compareImplementers([], []), { ambiguous: false, reasons: [] });
  assert.deepEqual(compareImplementers([gate("clean")], [patch("src/a.mjs")]), { ambiguous: false, reasons: [] });
});

test("two clean gates over the same files agree", () => {
  const result = compareImplementers([gate("clean"), gate("clean")], [patch("src/a.mjs"), `${patch("src/a.mjs")}+y\n`]);
  assert.deepEqual(result, { ambiguous: false, reasons: [] });
});

test("identical diffs agree even when the gate shapes differ", () => {
  const same = patch("src/a.mjs");
  assert.equal(compareImplementers([gate("clean"), gate("findings")], [same, same]).ambiguous, false);
});

test("differing verdicts are ambiguous", () => {
  const result = compareImplementers([gate("clean"), gate("findings")], [patch("src/a.mjs"), patch("src/a.mjs", "src/b.mjs")]);
  assert.equal(result.ambiguous, true);
  assert.ok(result.reasons.some((reason) => /verdicts differ \(clean vs findings\)/.test(reason)));
});

test("differing changed files are ambiguous and name both sides", () => {
  const result = compareImplementers([gate("clean"), gate("clean", { changed: ["src/b.mjs"] })], ["a", "b"]);
  assert.equal(result.ambiguous, true);
  assert.match(result.reasons.join("\n"), /only in 1: src\/a\.mjs; only in 2: src\/b\.mjs/);
});

test("changed files fall back to the diff headers when the gate lists none", () => {
  const a = { verdict: "clean" };
  const b = { verdict: "clean" };
  assert.equal(compareImplementers([a, b], [patch("x.mjs"), patch("x.mjs")]).ambiguous, false);
  assert.equal(compareImplementers([a, b], [patch("x.mjs"), patch("y.mjs")]).ambiguous, true);
});

test("a judge that passes for one and fails for the other is ambiguous", () => {
  const a = gate("clean", { judges: [{ id: "unit", status: "pass" }, { id: "fmt", status: "pass" }] });
  const b = gate("clean", { judges: [{ id: "unit", status: "pass" }, { id: "fmt", status: "fail" }] });
  const result = compareImplementers([a, b], ["a", "b"]);
  assert.equal(result.ambiguous, true);
  assert.match(result.reasons.join("\n"), /judge fmt differs \(pass vs fail\)/);
});

test("two red gates on different findings are ambiguous, on the same findings they are not", () => {
  const red = (fingerprint) => gate("findings", { findings: [{ id: "qac#1", fingerprint, baseline: false }] });
  assert.equal(compareImplementers([red("f1"), red("f1")], ["a", "b"]).ambiguous, false);
  assert.equal(compareImplementers([red("f1"), red("f2")], ["a", "b"]).ambiguous, true);
});

test("a missing gate counts as a differing verdict", () => {
  const result = compareImplementers([gate("clean"), null], ["a", "b"]);
  assert.equal(result.ambiguous, true);
  assert.match(result.reasons.join("\n"), /clean vs missing/);
});
