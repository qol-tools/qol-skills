import assert from "node:assert/strict";
import test from "node:test";

import { commandFor, parsePrompt, renderDiagnostic, summarize } from "../hooks/qols-intercept.mjs";

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
  for (const prompt of ["qols fork x --modle opus", "qols fork x --constructor y"]) {
    assert.equal(parsePrompt(prompt).verb, "help", prompt);
    assert.match(parsePrompt(prompt).diagnostic.title, /^unknown flag `--/, prompt);
  }
});

test("a bare command or help shows plain usage", () => {
  for (const prompt of ["qols", "qols help"]) assert.deepEqual(parsePrompt(prompt), { verb: "help" }, prompt);
});

test("an unknown command or a missing task is a diagnostic", () => {
  for (const prompt of ["qols nope x", "qols fork", "qols fork --model opus"]) {
    assert.ok(parsePrompt(prompt).diagnostic, prompt);
  }
});

test("a typo'd flag renders a caret under it and a suggestion", () => {
  const { diagnostic } = parsePrompt("qols bridge look into these --model opus --efort high");
  assert.equal(
    renderDiagnostic(diagnostic),
    [
      "error: unknown flag `--efort`",
      " --> prompt:1:42",
      "  |",
      "1 | qols bridge look into these --model opus --efort high",
      "  |                                          ^^^^^^^ not a flag qols knows",
      "  |",
      "  = help: did you mean `--effort`?",
      "  = note: flags are --harness, --model, --effort, --surface",
      "  = usage: qols bridge <task> [--harness H] [--model M] [--effort E] [--surface S]",
    ].join("\n"),
  );
});

test("a typo'd command suggests the nearest one and a flag on a later line keeps its line number", () => {
  assert.match(renderDiagnostic(parsePrompt("qols brige x").diagnostic), /help: did you mean `bridge`\?/);
  assert.match(renderDiagnostic(parsePrompt("qols fork a\nb --modle x").diagnostic), /2 \| b --modle x/);
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
