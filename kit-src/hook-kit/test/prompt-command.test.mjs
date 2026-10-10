import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { decidePrompt, execCli, hidesPrompt } from "../prompt-command.mjs";

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

test("decidePrompt runs an argv through the handler and blocks with its trimmed output", () => {
  const calls = [];
  const handle = (cli, argv, opts) => {
    calls.push([cli, argv, opts]);
    return "  3 findings\n";
  };
  assert.equal(
    decidePrompt({ prompt: "sw", cwd: "/repo" }, { parse: swParse, cli: "/plugin/scripts/softwords.mjs", prefix: "sw", handle }),
    '{"decision":"block","reason":"3 findings"}',
  );
  assert.deepEqual(calls, [["/plugin/scripts/softwords.mjs", ["scan", "--prefix=sw", "--pretty"], { cwd: "/repo" }]]);
});

test("decidePrompt falls back to the sw-intercept reply when the command prints nothing", () => {
  assert.equal(
    decidePrompt({ prompt: "sw" }, { parse: swParse, cli: "cli", prefix: "sw", handle: () => "" }),
    '{"decision":"block","reason":"sw: nothing to do"}',
  );
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

test("execCli returns the output of the cli, and its stdout and stderr when it fails", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "hook-kit-cli-"));
  const ok = path.join(dir, "ok.mjs");
  const bad = path.join(dir, "bad.mjs");
  writeFileSync(ok, "process.stdout.write(process.argv.slice(2).join(' '));\n");
  writeFileSync(bad, "process.stdout.write('partial\\n'); process.stderr.write('broke\\n'); process.exit(3);\n");
  assert.equal(execCli(ok, ["scan", "--pretty"], { cwd: dir }), "scan --pretty");
  assert.equal(execCli(bad, []), "partial\nbroke");
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
