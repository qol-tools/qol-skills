import assert from "node:assert/strict";
import { closeSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { gitRoot, readHookInput } from "../input.mjs";

function readFrom(text) {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "hook-kit-input-")), "stdin.json");
  writeFileSync(file, text);
  const fd = openSync(file, "r");
  try {
    return readHookInput(fd);
  } finally {
    closeSync(fd);
  }
}

test("readHookInput parses the payload, treats empty input as an empty object and refuses the rest", () => {
  assert.deepEqual(readFrom('{"prompt":"sw scan","cwd":"/repo"}'), { prompt: "sw scan", cwd: "/repo" });
  assert.deepEqual(readFrom(""), {});
  for (const text of ["{not json", "null", "5", '"text"']) assert.equal(readFrom(text), null, text);
});

test("gitRoot keeps a directory outside any repository", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hook-kit-git-"));
  assert.equal(gitRoot(dir), dir);
});
