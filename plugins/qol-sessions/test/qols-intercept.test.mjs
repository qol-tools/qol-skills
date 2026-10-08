import assert from "node:assert/strict";
import test from "node:test";

import { commandFor, parsePrompt, summarize } from "../hooks/qols-intercept.mjs";

test("only prompts starting with qols are intercepted", () => {
  for (const prompt of ["fork this", "qolsfork x", "please qols fork x", "", undefined]) {
    assert.equal(parsePrompt(prompt), null, String(prompt));
  }
});

test("trailing named flags split off the message in any order", () => {
  const cases = [
    ["qols fork Do this task", { verb: "fork", message: "Do this task", flags: [] }],
    ["qols test try it --harness pi", { verb: "test", message: "try it", flags: ["--tool", "pi"] }],
    [
      "qols fork Do this --effort max --harness cc",
      { verb: "fork", message: "Do this", flags: ["--effort", "max", "--tool", "cc"] },
    ],
    [
      "QOLS Bridge add -1 to the counter --model sonnet",
      { verb: "bridge", message: "add -1 to the counter", flags: ["--model", "sonnet"] },
    ],
    ["qols bridge fix it\nnow --surface win", { verb: "bridge", message: "fix it now", flags: ["--surface", "win"] }],
  ];
  for (const [prompt, expected] of cases) assert.deepEqual(parsePrompt(prompt), expected, prompt);
});

test("a trailing unknown flag is refused instead of joining the message", () => {
  assert.deepEqual(parsePrompt("qols fork x --modle opus"), { verb: "help", error: "unknown flag --modle" });
  assert.deepEqual(parsePrompt("qols fork x --constructor y"), { verb: "help", error: "unknown flag --constructor" });
});

test("a bare, unknown or empty command shows help", () => {
  for (const prompt of ["qols", "qols help", "qols nope x", "qols fork", "qols fork --model opus"]) {
    assert.deepEqual(parsePrompt(prompt), { verb: "help" }, prompt);
  }
});

test("fork, test and bridge map onto the qol sessions CLI", () => {
  assert.deepEqual(commandFor({ verb: "fork", message: "m", flags: ["--surface", "win"] }, "/repo"), [
    "sessions", "fork", "--cwd", "/repo", "--brief", "m", "--surface", "win",
  ]);
  assert.deepEqual(commandFor({ verb: "test", message: "m", flags: [] }, "/repo"), [
    "sessions", "fork", "--cwd", "/repo", "--brief", "m", "--dry-run",
  ]);
  assert.deepEqual(commandFor({ verb: "bridge", message: "m", flags: [] }, "/repo"), [
    "sessions", "spawn", "--cwd", "/repo", "--task", "m", "--background",
  ]);
});

test("the summary names the key and the resolved launch", () => {
  const outcome = { key: "fork-1a2b", tool: "claude", model: "claude-opus-5-5", effort: "high", surface: "tab" };
  assert.equal(summarize("fork", outcome), "qols fork: fork-1a2b (claude claude-opus-5-5 high tab)");
});
