import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { fingerprint, normalizeMessage } from "../src/gate/fingerprint.mjs";

const NORMALIZE_CASES = [
  ["quoted span and path token", "Unused variable `foo` at src/a.rs:12", "unused variable q at p"],
  ["digit runs", "Expected 5 got 70", "expected # got #"],
  ["double and single quotes", "He said \"hi there\" and 'x'", "he said q and q"],
  ["backslash path", "cannot open C:\\dir\\file.txt now", "cannot open p now"],
  ["whitespace collapse and trim", "  A   B \n C ", "a b c"],
  ["apostrophe stays a word", "don't panic", "don't panic"],
  ["quoted span with a slash is quoted first", "bad \"src/a b.rs\" here", "bad q here"],
  ["nullish", undefined, ""],
  ["null", null, ""],
];

for (const [name, input, expected] of NORMALIZE_CASES) {
  test(`normalizeMessage: ${name}`, () => {
    assert.equal(normalizeMessage(input), expected);
  });
}

test("fingerprint is the first 16 hex of sha256 over judge, rule and normalized message", () => {
  const expected = createHash("sha256").update("clippy\nunused\nunused variable q at p").digest("hex").slice(0, 16);
  assert.equal(fingerprint("clippy", "unused", "Unused variable `foo` at src/a.rs:12"), expected);
  assert.match(fingerprint("a", "b", "c"), /^[0-9a-f]{16}$/);
});

test("fingerprint ignores paths, digits and quoted names", () => {
  assert.equal(
    fingerprint("eslint", "no-unused-vars", "'alpha' is defined but never used in src/a.js:3"),
    fingerprint("eslint", "no-unused-vars", "'beta' is defined but never used in lib/deep/b.js:99"),
  );
});

test("fingerprint separates judge, rule and message", () => {
  const base = fingerprint("j", "r", "message");
  assert.notEqual(base, fingerprint("k", "r", "message"));
  assert.notEqual(base, fingerprint("j", "s", "message"));
  assert.notEqual(base, fingerprint("j", "r", "other message"));
});
