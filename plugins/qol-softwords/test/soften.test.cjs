const test = require("node:test");
const assert = require("node:assert");
const { soften, softenRecord } = require("../bin/soften-lib.cjs");

test("casing survives the replacement", () => {
  assert.equal(soften("WTF"), "WHAT THE HECK");
  assert.equal(soften("Damn"), "Darn");
  assert.equal(soften("damn"), "darn");
});

test("a longer curse wins over the shorter one inside it", () => {
  assert.equal(soften("so fucking sloppy"), "so freaking sloppy");
});

test("an innocent word that merely contains a key is left alone", () => {
  assert.equal(soften("scrapbook assessment"), "scrapbook assessment");
});

test("only user-authored text in a transcript record is rewritten", () => {
  const record = {
    type: "user",
    message: { role: "user", content: [{ type: "text", text: "this is shit" }] },
    toolUseResult: { stdout: "shit" },
  };

  assert.equal(softenRecord(record), true);
  assert.equal(record.message.content[0].text, "this is junk");
  assert.equal(record.toolUseResult.stdout, "shit");
});

test("an assistant turn is never rewritten", () => {
  const record = { message: { role: "assistant", content: [{ type: "text", text: "damn" }] } };

  assert.equal(softenRecord(record), false);
  assert.equal(record.message.content[0].text, "damn");
});

test("a launcher retrieval query is rewritten", () => {
  const record = { source: "launcher", query: "wtf is the build command" };

  assert.equal(softenRecord(record), true);
  assert.equal(record.query, "what the heck is the build command");
});
