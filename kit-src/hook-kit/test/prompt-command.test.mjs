import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CLI_TIMEOUT_MS, decidePrompt, hidesPrompt, runCli } from "../prompt-command.mjs";

const MODULE = new URL("../prompt-command.mjs", import.meta.url).href;

function swParse(prompt) {
  const match = /^sw(?:\s+(.*))?$/i.exec(prompt.trim());
  return match === null ? null : ["scan", "--prefix=sw", "--pretty"];
}

test("decidePrompt passes a prompt the parser does not claim", () => {
  const seen = [];
  const parse = (prompt, cwd) => {
    seen.push([prompt, cwd]);
    return null;
  };
  assert.equal(decidePrompt({ prompt: "fix the bug", cwd: "/repo" }, { parse, prefix: "sw" }), null);
  assert.equal(decidePrompt({ prompt: 5, cwd: "" }, { parse, prefix: "sw" }), null);
  assert.deepEqual(seen, [["fix the bug", "/repo"], ["", process.cwd()]]);
});

const answeredBy = (text) => () => ({ kind: "answered", status: 0, text });

test("decidePrompt runs an argv through the handler and blocks with its trimmed text", () => {
  const calls = [];
  const handle = (cli, argv, opts) => {
    calls.push([cli, argv, opts]);
    return { kind: "answered", status: 0, text: "  3 findings\n" };
  };
  assert.equal(
    decidePrompt({ prompt: "sw", cwd: "/repo" }, { parse: swParse, cli: "/plugin/scripts/softwords.mjs", prefix: "sw", handle, answered: [0, 1], env: {} }),
    '{"decision":"block","reason":"3 findings"}',
  );
  assert.deepEqual(calls, [["/plugin/scripts/softwords.mjs", ["scan", "--prefix=sw", "--pretty"], { cwd: "/repo", answered: [0, 1] }]]);
});

test("decidePrompt falls back to the sw-intercept reply when the command prints nothing", () => {
  assert.equal(
    decidePrompt({ prompt: "sw" }, { parse: swParse, cli: "cli", prefix: "sw", handle: answeredBy(""), env: {} }),
    '{"decision":"block","reason":"sw: nothing to do"}',
  );
  assert.equal(
    decidePrompt({ prompt: "sw" }, { parse: swParse, cli: "cli", prefix: "sw", handle: () => undefined, env: {} }),
    '{"decision":"block","reason":"sw: nothing to do"}',
  );
});

test("decidePrompt suppresses the prompt only for an answered run under Claude Code", () => {
  const claude = { CLAUDECODE: "1" };
  const hidden = '{"decision":"block","reason":"out","hookSpecificOutput":{"hookEventName":"UserPromptSubmit","suppressOriginalPrompt":true}}';
  const shown = '{"decision":"block","reason":"out"}';
  const run = (kind, input = { prompt: "sw" }, env = claude) =>
    decidePrompt(input, { parse: swParse, cli: "cli", prefix: "sw", handle: () => ({ kind, status: 0, text: "out" }), env });
  assert.equal(run("answered"), hidden);
  assert.equal(run("usage"), shown);
  assert.equal(run("failed"), shown);
  assert.equal(run("answered", { prompt: "sw", turn_id: "t1" }), shown);
  assert.equal(run("answered", { prompt: "sw" }, {}), shown);
});

test("decidePrompt injects context and blocks with a computed reason", () => {
  assert.equal(
    decidePrompt({ prompt: "vs autoinject setup" }, { parse: () => ({ context: "[autoinject] Run the guided setup" }), prefix: "vs" }),
    '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"[autoinject] Run the guided setup"}}',
  );
  assert.equal(
    decidePrompt({ prompt: "qols" }, { parse: () => ({ reason: "qols fork <problem>" }), prefix: "qols" }),
    '{"decision":"block","reason":"qols fork <problem>"}',
  );
});

test("decidePrompt hides a sent prompt only under Claude Code", () => {
  const claude = { CLAUDECODE: "1" };
  const sent = () => ({ reason: "qols fork: k", sent: true });
  const hidden = '{"decision":"block","reason":"qols fork: k","hookSpecificOutput":{"hookEventName":"UserPromptSubmit","suppressOriginalPrompt":true}}';
  const shown = '{"decision":"block","reason":"qols fork: k"}';
  assert.equal(decidePrompt({ prompt: "qols fork x" }, { parse: sent, prefix: "qols", env: claude }), hidden);
  assert.equal(decidePrompt({ prompt: "qols fork x", turn_id: "t1" }, { parse: sent, prefix: "qols", env: claude }), shown);
  assert.equal(decidePrompt({ prompt: "qols fork x" }, { parse: sent, prefix: "qols", env: {} }), shown);
  assert.equal(decidePrompt({ prompt: "qols x" }, { parse: () => ({ reason: "qols fork: k" }), prefix: "qols", env: claude }), shown);
});

test("hidesPrompt needs the Claude Code env and no Codex turn id", () => {
  assert.equal(hidesPrompt({}, { CLAUDECODE: "1" }), true);
  assert.equal(hidesPrompt({ turn_id: "t1" }, { CLAUDECODE: "1" }), false);
  assert.equal(hidesPrompt({}, {}), false);
});

function scripts() {
  const dir = mkdtempSync(path.join(tmpdir(), "hook-kit-cli-"));
  const make = (name, source) => {
    const file = path.join(dir, name);
    writeFileSync(file, source);
    return file;
  };
  return {
    dir,
    echo: make("echo.mjs", "process.stdout.write(process.argv.slice(2).join(' '));\n"),
    exit: make("exit.mjs", "process.stdout.write('partial\\n'); process.stderr.write('broke\\n'); process.exit(Number(process.argv[2]));\n"),
    usage: make("usage.mjs", "process.stdout.write('usage: tool <verb>\\n');\n"),
    crash: make("crash.mjs", "throw new Error('kaboom');\n"),
    sleep: make("sleep.mjs", "setTimeout(() => {}, 20000);\n"),
  };
}

test("runCli answers with the stdout of a run that exits 0", () => {
  const { dir, echo } = scripts();
  assert.deepEqual(runCli(echo, ["scan", "--pretty"], { cwd: dir }), { kind: "answered", status: 0, text: "scan --pretty" });
});

test("runCli counts only the exits in the answered list as answered", () => {
  const { exit } = scripts();
  assert.deepEqual(runCli(exit, ["1"], { answered: [0, 1] }), { kind: "answered", status: 1, text: "partial\nbroke" });
  assert.deepEqual(runCli(exit, ["1"]), { kind: "failed", status: 1, text: "partial\nbroke" });
  assert.deepEqual(runCli(exit, ["3"], { answered: [0, 1] }), { kind: "failed", status: 3, text: "partial\nbroke" });
});

test("runCli calls exit 2 and a usage line a usage answer, whatever the answered list says", () => {
  const { exit, usage } = scripts();
  assert.deepEqual(runCli(exit, ["2"], { answered: [0, 2] }), { kind: "usage", status: 2, text: "partial\nbroke" });
  assert.deepEqual(runCli(usage, []), { kind: "usage", status: 0, text: "usage: tool <verb>" });
});

test("runCli calls a crash stack failed even when the exit is in the answered list", () => {
  const { crash } = scripts();
  const result = runCli(crash, [], { answered: [0, 1] });
  assert.equal(result.kind, "failed");
  assert.equal(result.status, 1);
  assert.match(result.text, /kaboom/);
});

test("runCli fails a run that outlasts its timeout and says so", () => {
  const { sleep } = scripts();
  const result = runCli(sleep, [], { timeoutMs: 300 });
  assert.equal(result.kind, "failed");
  assert.equal(result.status, null);
  assert.equal(result.text, "timed out after 0.3 s");
});

test("runCli fails a binary that cannot start and a run that a signal killed", () => {
  const missing = runCli("x", [], { bin: path.join(tmpdir(), "no-such-binary-for-hook-kit") });
  assert.equal(missing.kind, "failed");
  assert.match(missing.text, /ENOENT/);
  const killed = runCli("x", [], { exec: () => ({ status: null, signal: "SIGKILL", stdout: "", stderr: "" }) });
  assert.deepEqual(killed, { kind: "failed", status: null, text: "killed by SIGKILL" });
});

test("runCli names the exit when a failed run printed nothing", () => {
  const exec = () => ({ status: 7, stdout: "", stderr: "" });
  assert.deepEqual(runCli("x", [], { exec }), { kind: "failed", status: 7, text: "exited with status 7" });
  assert.deepEqual(runCli("x", [], { exec: () => ({ status: 0, stdout: "", stderr: "" }) }), { kind: "answered", status: 0, text: "" });
});

test("runCli hands the binary, script, argv and limits to the injected exec", () => {
  const calls = [];
  const exec = (bin, args, options) => {
    calls.push([bin, args, options]);
    return { status: 0, stdout: "ok\n", stderr: "" };
  };
  assert.deepEqual(runCli("/p/cli.mjs", ["a", "b"], { cwd: "/repo", exec }), { kind: "answered", status: 0, text: "ok" });
  assert.deepEqual(runCli("sessions", ["status"], { bin: "qol", timeoutMs: 1234, exec }).text, "ok");
  assert.equal(calls[0][0], process.execPath);
  assert.deepEqual(calls[0][1], ["/p/cli.mjs", "a", "b"]);
  assert.equal(calls[0][2].cwd, "/repo");
  assert.equal(calls[0][2].timeout, CLI_TIMEOUT_MS);
  assert.equal(CLI_TIMEOUT_MS, 50000);
  assert.deepEqual(calls[1].slice(0, 2), ["qol", ["sessions", "status"]]);
  assert.equal(calls[1][2].timeout, 1234);
});

test("runCli reports an injected timeout with the output so far", () => {
  const exec = () => ({
    status: null,
    signal: "SIGTERM",
    stdout: "half\n",
    stderr: "",
    error: Object.assign(new Error("spawnSync node ETIMEDOUT"), { code: "ETIMEDOUT" }),
  });
  assert.deepEqual(runCli("x", [], { exec, timeoutMs: 50000 }), { kind: "failed", status: null, text: "half\ntimed out after 50 s" });
});

function runner(parseSource, stdin) {
  const script = `import { runPromptCommand } from ${JSON.stringify(MODULE)};
runPromptCommand({ parse: ${parseSource}, prefix: "t" });
console.log("unreachable");`;
  return spawnSync(process.execPath, ["--input-type=module", "-e", script], { input: stdin, encoding: "utf8" });
}

test("runPromptCommand writes the decision and exits 0", () => {
  const result = runner('() => ({ reason: "hi" })', '{"prompt":"t"}');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, '{"decision":"block","reason":"hi"}\n');
});

test("runPromptCommand fails open on a throwing parser and on a bad payload", () => {
  for (const [parse, stdin] of [['() => { throw new Error("boom"); }', '{"prompt":"t"}'], ['() => ({ reason: "hi" })', "{oops"]]) {
    const result = runner(parse, stdin);
    assert.equal(result.status, 0, parse);
    assert.equal(result.stdout, "", parse);
  }
});

test("runPromptCommand refuses a claimed prompt on Node older than 18 and passes the rest", () => {
  const argv = 'parse: (prompt) => prompt === "t" ? ["scan"] : null, cli: "cli.mjs", prefix: "t", nodeVersion: "16.20.0"';
  const script = (parseOpts) => `import { runPromptCommand } from ${JSON.stringify(MODULE)};
runPromptCommand({ ${parseOpts} });`;
  const run = (stdin, options = argv) => spawnSync(process.execPath, ["--input-type=module", "-e", script(options)], { input: stdin, encoding: "utf8" });
  const refused = run('{"prompt":"t"}');
  assert.equal(refused.status, 0);
  assert.equal(refused.stdout, '{"decision":"block","reason":"t: needs Node 18 or newer, this is Node 16.20.0"}\n');
  assert.equal(run('{"prompt":"other"}').stdout, "");
  const current = run('{"prompt":"t"}', argv.replace('nodeVersion: "16.20.0"', 'nodeVersion: "18.0.0"'));
  assert.doesNotMatch(current.stdout, /needs Node/);
});
