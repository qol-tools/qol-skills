import assert from "node:assert/strict";
import test from "node:test";

import { commandFor, parsePrompt, summarize } from "../hooks/qols-intercept.mjs";

test("only prompts starting with qols are intercepted", () => {
  for (const prompt of ["fork this", "qolsfork x", "please qols fork x", "", undefined]) {
    assert.equal(parsePrompt(prompt), null, String(prompt));
  }
});

test("trailing picks split off the message and inner + words stay in it", () => {
  const cases = [
    ["qols fork Do this task", { verb: "fork", message: "Do this task", picks: [] }],
    ["qols fork Do this +win +sonnet", { verb: "fork", message: "Do this", picks: ["+win", "+sonnet"] }],
    ["QOLS Bridge add +1 to the counter", { verb: "bridge", message: "add +1 to the counter", picks: [] }],
    ["qols bridge fix it\nnow +cc", { verb: "bridge", message: "fix it now", picks: ["+cc"] }],
  ];
  for (const [prompt, expected] of cases) assert.deepEqual(parsePrompt(prompt), expected, prompt);
});

test("a bare, unknown or empty command shows help", () => {
  for (const prompt of ["qols", "qols help", "qols nope x", "qols fork", "qols fork +win"]) {
    assert.deepEqual(parsePrompt(prompt), { verb: "help" }, prompt);
  }
});

test("fork and bridge map onto the qol sessions CLI", () => {
  assert.deepEqual(commandFor({ verb: "fork", message: "m", picks: ["+win"] }, "/repo"), [
    "sessions", "fork", "--cwd", "/repo", "--brief", "m", "+win",
  ]);
  assert.deepEqual(commandFor({ verb: "bridge", message: "m", picks: [] }, "/repo"), [
    "sessions", "spawn", "--cwd", "/repo", "--task", "m", "--background",
  ]);
});

test("the summary names the key and the resolved launch", () => {
  const outcome = { key: "fork-1a2b", tool: "claude", model: "claude-opus-5-5", effort: "high", surface: "tab" };
  assert.equal(summarize("fork", outcome), "qols fork: fork-1a2b (claude claude-opus-5-5 high tab)");
});
