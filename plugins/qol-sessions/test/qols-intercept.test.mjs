import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import {
  boardReply,
  cliSessionsBinary,
  commandFor,
  forkedBySwitchboard,
  isSwitchboard,
  launch,
  loopCommand,
  loopReply,
  park,
  parsePrompt,
  renderDiagnostic,
  status,
  summarize,
  summarizePark,
  switchboardContext,
  wake,
} from "../hooks/qols-intercept.mjs";

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

test("qols new carries a prompt and its trailing flags", () => {
  const cases = [
    ["qols new fix the bug", { verb: "new", message: "fix the bug", flags: [] }],
    ["qols new fix it --model opus --park", { verb: "new", message: "fix it", flags: ["--model", "opus", "--park"] }],
  ];
  for (const [prompt, expected] of cases) assert.deepEqual(parsePrompt(prompt), expected, prompt);
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
  assert.deepEqual(commandFor({ verb: "new", message: "fix it", flags: ["--model", "opus"] }, "/repo"), [
    "sessions", "fork", "--cwd", "/repo", "--brief", "fix it", "--no-chat", "--model", "opus",
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

test("the switchboard is the kitty window whose qol_session_key user var is switchboard", () => {
  const listing = (vars) => JSON.stringify([{ tabs: [{ windows: [{ id: 7, user_vars: vars }] }] }]);
  const calls = [];
  const ls = (output) => (argv) => {
    calls.push(argv);
    return output;
  };
  assert.equal(isSwitchboard({ KITTY_WINDOW_ID: "7" }, ls(listing({ qol_session_key: "switchboard" }))), true);
  assert.deepEqual(calls, [["@", "ls", "--match", "id:7"]]);
  assert.equal(isSwitchboard({ KITTY_WINDOW_ID: "7" }, ls(listing({ qol_session_key: "lane-1" }))), false);
  assert.equal(isSwitchboard({ KITTY_WINDOW_ID: "7" }, ls(listing({}))), false);
  assert.equal(isSwitchboard({ KITTY_WINDOW_ID: "8" }, ls(listing({ qol_session_key: "switchboard" }))), false);
  assert.equal(isSwitchboard({ KITTY_WINDOW_ID: "7" }, ls("not json")), false);
  const missing = () => {
    throw Object.assign(new Error("spawnSync kitten ENOENT"), { code: "ENOENT" });
  };
  assert.equal(isSwitchboard({ KITTY_WINDOW_ID: "7" }, missing), false);
  calls.length = 0;
  assert.equal(isSwitchboard({}, ls(listing({ qol_session_key: "switchboard" }))), false);
  assert.deepEqual(calls, [], "kitten runs only inside a kitty window");
});

test("in the switchboard only fork, bridge and new reach the model", () => {
  for (const prompt of ["qols fork x", "qols bridge x", "qols new x", "qols new", "qols fork x --harness codex"]) {
    assert.equal(forkedBySwitchboard(parsePrompt(prompt), () => true), true, prompt);
    assert.equal(forkedBySwitchboard(parsePrompt(prompt), () => false), false, prompt);
  }
  for (const prompt of ["qols test x", "qols switchboard", "qols park", "qols status", "qols wake key", "qols help"]) {
    assert.equal(forkedBySwitchboard(parsePrompt(prompt), () => assert.fail(prompt)), false, prompt);
  }
});

test("the switchboard note names what to start and sends terminal flags to session_fork", () => {
  assert.equal(
    switchboardContext(parsePrompt("qols fork fix the flaky test")),
    "[qols] `qols fork` reached you because the switchboard starts sessions as forks, not terminals: treat it as the user asking for a fork that owns the problem in their words, and start it as your role describes.",
  );
  const cases = [
    ["qols bridge look into it", "a fork that does the task in their words and reports back to you"],
    ["qols new fix it", "a new session for their words"],
    ["qols new", "a new empty session"],
  ];
  for (const [prompt, ask] of cases) {
    const note = switchboardContext(parsePrompt(prompt));
    assert.ok(note.includes(`asking for ${ask}, and start it`), prompt);
    assert.ok(!note.includes("session_fork"), prompt);
  }
  assert.match(
    switchboardContext(parsePrompt("qols new --harness codex")),
    /as your role describes\. `--model` and `--effort` set the fork's model and effort; `--harness` naming another tool than claude, `--surface` or `--park` ask for a terminal, so call session_fork with them\.$/,
  );
});

test("qols board toggles the switchboard's board and takes nothing else", () => {
  assert.deepEqual(parsePrompt("qols board"), { verb: "board" });
  assert.deepEqual(parsePrompt("QOLS Board"), { verb: "board" });
  assert.match(renderDiagnostic(parsePrompt("qols board now").diagnostic), /qols board only toggles/);
});

test("qols board reaching the hook points outside the switchboard there, and inside it to an update", () => {
  assert.match(boardReply(() => false).reason, /the fork board is the switchboard's/);
  assert.match(boardReply(() => true).reason, /update qol and restart the switchboard, or use \/board/);
});

test("qols status takes nothing else", () => {
  assert.deepEqual(parsePrompt("qols status"), { verb: "status" });
  assert.deepEqual(parsePrompt("QOLS Status"), { verb: "status" });
  for (const prompt of ["qols status now", "qols status --model opus"]) {
    const { verb, diagnostic } = parsePrompt(prompt);
    assert.equal(verb, "help", prompt);
    assert.match(diagnostic.title, /^`qols status` does not take/, prompt);
    assert.match(renderDiagnostic(diagnostic), /usage: qols status$/, prompt);
  }
});

const answered = (text) => ({ kind: "answered", status: 0, text });
const failedRun = (text, kind = "failed") => ({ kind, status: 1, text });

test("qols status answers with the qol sessions status output and drops the prompt", () => {
  let argv;
  const lines = "sb-engine  working  rc  #212  pushed the fix";
  assert.deepEqual(status((args) => ((argv = args), answered(lines))), { reason: lines, sent: true });
  assert.deepEqual(argv, ["sessions", "status"]);
  assert.deepEqual(status(() => answered("")), { reason: "qols status: no lanes", sent: true });
});

test("qols status names an outdated qol in one line and passes other failures through", () => {
  for (const kind of ["failed", "usage"]) {
    const stale = status(() => failedRun("unknown qol sessions subcommand `status`\n\nqol sessions\n...usage...", kind));
    assert.equal(stale.reason, "qols status: this qol has no `qol sessions status`; update qol");
    assert.equal(stale.sent, undefined);
  }
  assert.deepEqual(status(() => failedRun("sessions data directory is unavailable")), {
    reason: "qols status: sessions data directory is unavailable",
  });
  assert.deepEqual(status(() => failedRun("timed out after 100 s")), { reason: "qols status: timed out after 100 s" });
});

test("qols wake takes exactly one spawn key", () => {
  assert.deepEqual(parsePrompt("qols wake ci-speed-2min"), { verb: "wake", key: "ci-speed-2min" });
  for (const prompt of ["qols wake", "qols wake one two"]) {
    const { verb, diagnostic } = parsePrompt(prompt);
    assert.equal(verb, "help", prompt);
    assert.match(renderDiagnostic(diagnostic), /usage: qols wake <key>$/, prompt);
  }
});

test("qols wake runs the CLI Sessions wake command and reports its line or error", () => {
  const calls = [];
  const woke = wake("lane", "/bin/qcs", (bin, argv) => {
    calls.push([bin, ...argv]);
    return answered("woke lane in v1:kitty:1:2");
  });
  assert.deepEqual(calls, [["/bin/qcs", "wake", "lane"]]);
  assert.deepEqual(woke, { reason: "qols wake: woke lane in v1:kitty:1:2", sent: true });
  const busy = wake("lane", "/bin/qcs", () => failedRun("`lane` is mid-turn"));
  assert.deepEqual(busy, { reason: "qols wake: `lane` is mid-turn" });
  assert.deepEqual(wake("lane", "/bin/qcs", () => failedRun("usage: wake <key>", "usage")), { reason: "qols wake: usage: wake <key>" });
  assert.match(wake("lane", null).reason, /not installed/);
});

test("qols park toggles through the CLI Sessions binary and reports the new state", () => {
  const calls = [];
  const run = (bin, argv) => {
    calls.push([bin, ...argv]);
    return answered("parking on");
  };
  assert.deepEqual(park("/bin/qcs", run), { reason: summarizePark("parking on"), sent: true });
  assert.deepEqual(calls, [["/bin/qcs", "parking", "toggle"]]);
  assert.deepEqual(park("/bin/qcs", () => failedRun("no socket")), { reason: "qols park: no socket" });
  assert.match(park(null).reason, /not installed/);
});

test("fork, test, new and bridge launches answer with the summary and drop the prompt", () => {
  const calls = [];
  const outcome = { key: "fork-1a2b", tool: "claude", model: "claude-opus-5-5", effort: "high", surface: "tab" };
  const run = (bin, argv) => {
    calls.push([bin, argv]);
    return answered(JSON.stringify(outcome));
  };
  const reply = launch(parsePrompt("qols fork fix it --model opus"), "/repo", run);
  assert.deepEqual(reply, { reason: "qols fork: fork-1a2b (claude claude-opus-5-5 high tab)", sent: true });
  assert.deepEqual(calls, [["qol", ["sessions", "fork", "--cwd", "/repo", "--brief", "fix it", "--model", "opus"]]]);
});

test("a bridge launch starts the watcher on the new session", () => {
  const watched = [];
  const run = () => answered(JSON.stringify({ key: "lane-1", session: "v1:kitty:1:2", tool: "claude", model: "m", effort: "e", surface: "tab" }));
  const reply = launch(parsePrompt("qols bridge look into it"), "/repo", run, (session) => watched.push(session));
  assert.equal(reply.sent, true);
  assert.match(reply.reason, /^qols bridge: lane-1 /);
  assert.deepEqual(watched, ["v1:kitty:1:2"]);
  launch(parsePrompt("qols fork x"), "/repo", run, () => assert.fail("only a bridge watches"));
});

test("a launch that fails, times out, prints a usage line or prints no JSON leaves the line in the box", () => {
  const parsed = parsePrompt("qols fork fix it");
  for (const kind of ["failed", "usage"]) {
    assert.deepEqual(launch(parsed, "/repo", () => failedRun("no such model", kind)), { reason: "qols fork: no such model" });
  }
  assert.deepEqual(launch(parsed, "/repo", () => failedRun("timed out after 100 s")), { reason: "qols fork: timed out after 100 s" });
  const garbled = launch(parsed, "/repo", () => answered("not json"));
  assert.equal(garbled.sent, undefined);
  assert.match(garbled.reason, /^qols fork: /);
  const noWatch = launch(parsePrompt("qols bridge x"), "/repo", () => failedRun("boom"), () => assert.fail("no watcher on a failed launch"));
  assert.equal(noWatch.sent, undefined);
});

test("qols loop with nothing, a key, or doctor maps onto the loop driver", () => {
  assert.deepEqual(parsePrompt("qols loop"), { verb: "loop", args: ["status"] });
  assert.deepEqual(parsePrompt("QOLS Loop"), { verb: "loop", args: ["status"] });
  assert.deepEqual(parsePrompt("qols loop fix-cache"), { verb: "loop", args: ["status", "fix-cache"] });
  assert.deepEqual(parsePrompt("qols loop Fix-Cache"), { verb: "loop", args: ["status", "Fix-Cache"] });
  assert.deepEqual(parsePrompt("qols loop doctor"), { verb: "loop", args: ["doctor"] });
  assert.deepEqual(parsePrompt("qols loop DOCTOR"), { verb: "loop", args: ["doctor"] });
});

test("qols loop status is the bare form, qols loop status KEY is the keyed form, and doctor passes --prune", () => {
  assert.deepEqual(parsePrompt("qols loop status"), { verb: "loop", args: ["status"] });
  assert.deepEqual(parsePrompt("qols loop STATUS"), { verb: "loop", args: ["status"] });
  assert.deepEqual(parsePrompt("qols loop status fix-cache"), { verb: "loop", args: ["status", "fix-cache"] });
  assert.deepEqual(parsePrompt("qols loop doctor --prune"), { verb: "loop", args: ["doctor", "--prune"] });
  assert.deepEqual(loopCommand(parsePrompt("qols loop doctor --prune"), "/repo", "/plugin")[1], ["doctor", "--prune", "--pretty", "--cwd", "/repo"]);
});

test("qols loop open, run, verdict and close answer with a usage line that sends them to the architect's Bash", () => {
  for (const verb of ["open", "run", "verdict", "close", "RUN"]) {
    for (const prompt of [`qols loop ${verb}`, `qols loop ${verb} k --spec s.md`]) {
      const { usage, args } = parsePrompt(prompt);
      assert.equal(args, undefined, prompt);
      assert.match(usage, /^usage: qols loop \[status \[key\] \| key \| doctor \[--prune\]\]; open, run, verdict, close run from the architect's Bash: qols loop /, prompt);
      assert.ok(usage.endsWith(`${verb.toLowerCase()} ...`), prompt);
    }
  }
  assert.deepEqual(loopReply(parsePrompt("qols loop run k"), "/repo", () => assert.fail("never runs")), {
    reason: parsePrompt("qols loop run k").usage,
  });
});

test("qols loop refuses extra words and flags with a diagnostic", () => {
  const cases = [
    ["qols loop key more", "more", "loop takes one key or doctor"],
    ["qols loop doctor --bogus", "--bogus", "doctor takes only --prune"],
    ["qols loop doctor --prune --prune", "--prune", "doctor takes only --prune"],
    ["qols loop status a b", "b", "loop takes one key or doctor"],
    ["qols loop status --x", "--x", "a loop key is a name, not a flag"],
    ["qols loop --help", "--help", "a loop key is a name, not a flag"],
  ];
  for (const [prompt, token, label] of cases) {
    const { verb, diagnostic } = parsePrompt(prompt);
    assert.equal(verb, "help", prompt);
    assert.equal(diagnostic.title, `\`qols loop\` does not take \`${token}\``, prompt);
    assert.equal(diagnostic.label, label, prompt);
    assert.equal(prompt.slice(diagnostic.start, diagnostic.end), token, prompt);
    assert.match(renderDiagnostic(diagnostic), /usage: qols loop \[status \[key\] \| key \| doctor \[--prune\]\]$/, prompt);
  }
});

test("qols loop runs loop.mjs from the plugin root with --pretty and the input cwd", () => {
  assert.deepEqual(loopCommand({ args: ["status"] }, "/repo", "/plugin"), [join("/plugin", "scripts", "loop.mjs"), ["status", "--pretty", "--cwd", "/repo"]]);
  assert.deepEqual(loopCommand({ args: ["status", "k1"] }, "/repo", "/plugin")[1], ["status", "k1", "--pretty", "--cwd", "/repo"]);
  assert.deepEqual(loopCommand({ args: ["doctor"] }, "/repo", "/plugin")[1], ["doctor", "--pretty", "--cwd", "/repo"]);
  const calls = [];
  const reply = loopReply({ verb: "loop", args: ["status", "k1"] }, "/repo", (cli, argv, options) => {
    calls.push([cli, argv, options]);
    return answered("k1  green  attempt 1");
  }, "/plugin");
  assert.deepEqual(reply, { reason: "k1  green  attempt 1", sent: true });
  assert.deepEqual(calls, [[join("/plugin", "scripts", "loop.mjs"), ["status", "k1", "--pretty", "--cwd", "/repo"], { cwd: "/repo", timeoutMs: 100000 }]]);
});

test("qols loop with no output, a failure or a usage error leaves the box alone", () => {
  const parsed = { verb: "loop", args: ["status"] };
  assert.deepEqual(loopReply(parsed, "/repo", () => answered("")), { reason: "qols loop: nothing to report", sent: true });
  assert.deepEqual(loopReply(parsed, "/repo", () => failedRun("loop.mjs: infra: no git repository")), {
    reason: "qols loop: loop.mjs: infra: no git repository",
  });
  assert.deepEqual(loopReply(parsed, "/repo", () => failedRun("usage: loop.mjs <verb>", "usage")), {
    reason: "qols loop: usage: loop.mjs <verb>",
  });
});

test("an unknown command lists loop among the commands", () => {
  const reason = renderDiagnostic(parsePrompt("qols brige x").diagnostic);
  assert.match(reason, /commands are fork, bridge, test, new, switchboard, park, wake, status, board, loop/);
});

