import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import { cliSessionsBinary, commandFor, parsePrompt, renderDiagnostic, summarize, summarizePark } from "../hooks/qols-intercept.mjs";

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

test("a trailing --park switch opts a fork into parking and stays message text on a bridge", () => {
  const cases = [
    ["qols fork wait on the PR --park", { verb: "fork", message: "wait on the PR", flags: ["--park"] }],
    [
      "qols fork wait --park --model opus",
      { verb: "fork", message: "wait", flags: ["--park", "--model", "opus"] },
    ],
    ["qols test try --model opus --park", { verb: "test", message: "try", flags: ["--model", "opus", "--park"] }],
    ["qols bridge explain --park", { verb: "bridge", message: "explain --park", flags: [] }],
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

test("qols park toggles and takes nothing else", () => {
  assert.deepEqual(parsePrompt("qols park"), { verb: "park" });
  assert.deepEqual(parsePrompt("QOLS Park"), { verb: "park" });
  for (const prompt of ["qols park on", "qols park now please"]) {
    const { verb, diagnostic } = parsePrompt(prompt);
    assert.equal(verb, "help", prompt);
    assert.match(diagnostic.title, /^`qols park` does not take/, prompt);
    assert.match(renderDiagnostic(diagnostic), /usage: qols park$/, prompt);
  }
});

test("qols park reports the state after the toggle", () => {
  assert.match(summarizePark("parking on"), /^qols park: on; a park closes this terminal/);
  assert.match(summarizePark("parking off"), /^qols park: off; a park keeps this terminal open/);
});

test("qols park runs the installed CLI Sessions plugin when it exists", () => {
  const binary = process.platform === "win32" ? "qol-cli-sessions.exe" : "qol-cli-sessions";
  const env = { XDG_CONFIG_HOME: "/cfg" };
  assert.equal(cliSessionsBinary(env, "/home", () => true), join("/cfg", "qol-tray", "plugins", "qol-cli-sessions", binary));
  assert.equal(cliSessionsBinary(env, "/home", () => false), null);
});

test("qols new and qols switchboard parse trailing flags without a task", () => {
  const cases = [
    ["qols new", { verb: "new", flags: [] }],
    [
      "qols new --harness pi --model opus --effort max --surface win --park",
      { verb: "new", flags: ["--tool", "pi", "--model", "opus", "--effort", "max", "--surface", "win", "--park"] },
    ],
    ["QOLS New --park --model opus", { verb: "new", flags: ["--park", "--model", "opus"] }],
    ["qols switchboard", { verb: "switchboard", flags: [] }],
    [
      "qols switchboard --model sonnet --effort high --surface tab",
      { verb: "switchboard", flags: ["--model", "sonnet", "--effort", "high", "--surface", "tab"] },
    ],
  ];
  for (const [prompt, expected] of cases) assert.deepEqual(parsePrompt(prompt), expected, prompt);
});

test("qols new refuses task words and points at the first one", () => {
  for (const prompt of ["qols new fix the bug", "qols new fix it --model opus"]) {
    const { verb, diagnostic } = parsePrompt(prompt);
    assert.equal(verb, "help", prompt);
    assert.equal(diagnostic.title, "`qols new` takes no task", prompt);
    assert.equal(prompt.slice(diagnostic.start, diagnostic.end), "fix", prompt);
    assert.deepEqual(diagnostic.notes, [
      "help: use `qols fork <problem>` to hand over a problem",
      "usage: qols new [--harness H] [--model M] [--effort E] [--surface S] [--park]",
    ]);
  }
});

test("qols switchboard refuses task words without the fork note", () => {
  const prompt = "qols switchboard hello there --effort high";
  const { verb, diagnostic } = parsePrompt(prompt);
  assert.equal(verb, "help");
  assert.equal(diagnostic.title, "`qols switchboard` takes no task");
  assert.equal(prompt.slice(diagnostic.start, diagnostic.end), "hello");
  assert.deepEqual(diagnostic.notes, ["usage: qols switchboard [--model M] [--effort E] [--surface S]"]);
});

test("qols switchboard refuses --harness and --park", () => {
  const cases = [
    ["qols switchboard --harness pi", "--harness", "the switchboard always runs claude"],
    ["qols switchboard --model opus --harness pi", "--harness", "the switchboard always runs claude"],
    ["qols switchboard --park", "--park", "the switchboard does not park"],
    ["qols switchboard --park --model opus", "--park", "the switchboard does not park"],
  ];
  for (const [prompt, token, label] of cases) {
    const { verb, diagnostic } = parsePrompt(prompt);
    assert.equal(verb, "help", prompt);
    assert.equal(diagnostic.title, `\`qols switchboard\` does not take \`${token}\``, prompt);
    assert.equal(diagnostic.label, label, prompt);
    assert.equal(prompt.slice(diagnostic.start, diagnostic.end), token, prompt);
  }
});

test("new and switchboard map onto the qol sessions CLI", () => {
  assert.deepEqual(commandFor({ verb: "new", flags: [] }, "/repo"), ["sessions", "fork", "--cwd", "/repo", "--blank"]);
  assert.deepEqual(commandFor({ verb: "new", flags: ["--tool", "pi", "--park"] }, "/repo"), [
    "sessions", "fork", "--cwd", "/repo", "--blank", "--tool", "pi", "--park",
  ]);
  assert.deepEqual(commandFor({ verb: "switchboard", flags: [] }, "/repo"), ["sessions", "switchboard"]);
  assert.deepEqual(commandFor({ verb: "switchboard", flags: ["--effort", "high"] }, "/repo"), [
    "sessions", "switchboard", "--effort", "high",
  ]);
});

test("the new and switchboard summaries name the session and the resolved launch", () => {
  const forked = { key: "fork-1a2b", tool: "claude", model: "claude-opus-5-5", effort: "high", surface: "tab" };
  assert.equal(summarize("new", forked), "qols new: fork-1a2b (claude claude-opus-5-5 high tab)");
  const launched = { opened: "launched", session: "v1:kitty:k1", tool: "claude", model: "claude-opus-5-5", effort: "low", surface: "tab" };
  assert.equal(summarize("switchboard", launched), "qols switchboard: v1:kitty:k1 (claude claude-opus-5-5 low tab)");
  assert.equal(summarize("switchboard", { opened: "focused", session: "v1:kitty:k1" }), "qols switchboard: focused v1:kitty:k1");
  assert.equal(summarize("switchboard", { opened: "started_kitty", program: "kitty" }), "qols switchboard: started kitty for it");
});
