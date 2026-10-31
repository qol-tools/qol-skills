import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ANSWERED, CLI, decide, parsePrompt } from "../hooks/qac-intercept.mjs";
import { decidePrompt, runCli } from "../hooks/_kit/prompt-command.mjs";

const HOOK = fileURLToPath(new URL("../hooks/qac-intercept.mjs", import.meta.url));
const CLAUDE = { CLAUDECODE: "1" };
const HIDDEN = '"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","suppressOriginalPrompt":true}';

const result = (kind, status, text) => ({ kind, status, text });

function pipeline(prompt, handle, input = {}, env = CLAUDE) {
  const calls = [];
  const out = decidePrompt(
    { prompt, cwd: "/w", ...input },
    {
      parse: (text, cwd) => decide(text, cwd, (argv, dir) => (calls.push(["fix", argv, dir]), handle(argv))),
      cli: CLI,
      prefix: "qac",
      answered: ANSWERED,
      handle: (cli, argv, options) => (calls.push([cli, argv, options]), handle(argv)),
      env,
    },
  );
  return { out, calls };
}

test("parsePrompt routes every verb and sends a bare path to lint", () => {
  assert.deepEqual(parsePrompt("qac", "/w"), ["help", "--prefix=qac", "--pretty", "--cwd=/w"]);
  assert.deepEqual(parsePrompt("qac lint", ""), ["lint", "--prefix=qac", "--pretty", "--open"]);
  assert.deepEqual(parsePrompt("qac plugins/shot", ""), ["lint", "plugins/shot", "--prefix=qac", "--pretty", "--open"]);
  assert.deepEqual(parsePrompt("qac fix plugins/shot", "/w"), ["fix", "plugins/shot", "--prefix=qac", "--pretty", "--cwd=/w"]);
  assert.deepEqual(parsePrompt("qac slips", ""), ["slips", "--prefix=qac", "--pretty"]);
  assert.deepEqual(parsePrompt('qac slip "dbg! in tests" --from url', "/w"), [
    "slip", "dbg! in tests", "--from", "url", "--prefix=qac", "--pretty", "--cwd=/w",
  ]);
  assert.equal(parsePrompt("qacx lint", ""), null);
  assert.equal(parsePrompt("please run qac gate", ""), null);
  assert.equal(parsePrompt(undefined, ""), null);
});

test("parsePrompt routes gate, trust, traps and init without opening a report", () => {
  assert.deepEqual(parsePrompt("qac gate", "/w"), ["gate", "--prefix=qac", "--pretty", "--cwd=/w"]);
  assert.deepEqual(parsePrompt("QAC Gate --base main --loop k1 --attempt 2", "/w"), [
    "gate", "--base", "main", "--loop", "k1", "--attempt", "2", "--prefix=qac", "--pretty", "--cwd=/w",
  ]);
  assert.deepEqual(parsePrompt("qac trust", "/w"), ["trust", "--prefix=qac", "--pretty", "--cwd=/w"]);
  assert.deepEqual(parsePrompt("qac trust approve", "/w"), ["trust", "approve", "--prefix=qac", "--pretty", "--cwd=/w"]);
  assert.deepEqual(parsePrompt("qac traps --min 3", ""), ["traps", "--min", "3", "--prefix=qac", "--pretty"]);
  assert.deepEqual(parsePrompt("qac init", "/w"), ["init", "--prefix=qac", "--pretty", "--cwd=/w"]);
  assert.deepEqual(parsePrompt("qac init --exclude", "/w"), ["init", "--exclude", "--prefix=qac", "--pretty", "--cwd=/w"]);
});

test("decide hands every verb but fix to the shared runner as an argv", () => {
  for (const prompt of ["qac lint", "qac gate", "qac trust approve", "qac traps", "qac init", "qac slips", "qac"]) {
    assert.deepEqual(decide(prompt, "/w", () => assert.fail(prompt)), parsePrompt(prompt, "/w"), prompt);
  }
  assert.equal(decide("hello", "/w", () => assert.fail("not a qac prompt")), null);
});

test("decide hands a fix brief to the model as context and blocks every other fix result", () => {
  const argv = ["fix", "--prefix=qac", "--pretty", "--cwd=/w"];
  const seen = [];
  const run = (given, cwd) => (seen.push([given, cwd]), result("answered", 1, "brief"));
  assert.deepEqual(decide("qac fix", "/w", run), { context: "brief" });
  assert.deepEqual(seen, [[argv, "/w"]]);
  assert.deepEqual(decide("qac fix", "/w", () => result("answered", 1, "")), { context: "qac fix: nothing to do" });
  assert.deepEqual(decide("qac fix", "/w", () => result("answered", 0, "qac fix: 3 files, nothing to fix")), {
    reason: "qac fix: 3 files, nothing to fix",
    sent: true,
  });
  assert.deepEqual(decide("qac fix", "/w", () => result("answered", 0, "")), { reason: "qac fix: nothing to do", sent: true });
});

test("a fix that crashed, timed out or printed usage is never handed to the model", () => {
  for (const kind of ["failed", "usage"]) {
    assert.deepEqual(decide("qac fix", "/w", () => result(kind, 1, "boom")), { reason: "boom", sent: false }, kind);
  }
  assert.deepEqual(decide("qac fix", "/w", () => result("failed", null, "timed out after 110 s")), {
    reason: "timed out after 110 s",
    sent: false,
  });
});

test("an answered lint, gate, trust or traps run drops the typed line, and exit 1 counts as answered", () => {
  for (const prompt of ["qac lint", "qac gate", "qac trust", "qac traps", "qac init"]) {
    for (const status of [0, 1]) {
      const { out } = pipeline(prompt, () => result("answered", status, "report\n"));
      assert.equal(out, `{"decision":"block","reason":"report",${HIDDEN}}`, `${prompt} ${status}`);
    }
  }
});

test("a gate that could not judge or found only flaky judges is an answered run", () => {
  for (const status of [5, 6]) {
    const run = runCli(CLI, ["gate"], { answered: ANSWERED, exec: () => ({ status, stdout: "qac gate: could_not_judge\n", stderr: "" }) });
    assert.deepEqual(run, { kind: "answered", status, text: "qac gate: could_not_judge" });
  }
  const crashed = runCli(CLI, ["gate"], { answered: ANSWERED, exec: () => ({ status: 4, stdout: "", stderr: "" }) });
  assert.equal(crashed.kind, "failed");
});

test("a usage, failed or timed-out run keeps the typed line in the box", () => {
  for (const kind of ["usage", "failed"]) {
    const { out } = pipeline("qac gate", () => result(kind, 2, "usage: qac gate [--cwd DIR]"));
    assert.equal(out, '{"decision":"block","reason":"usage: qac gate [--cwd DIR]"}', kind);
  }
  const timeout = pipeline("qac gate", () => result("failed", null, "timed out after 110 s"));
  assert.equal(timeout.out, '{"decision":"block","reason":"timed out after 110 s"}');
});

test("the shared runner is told the answered exits and the cwd for every verb", () => {
  const { calls } = pipeline("qac gate --base main", () => result("answered", 0, "ok"));
  assert.equal(calls.length, 1);
  const [cli, argv, options] = calls[0];
  assert.equal(cli, CLI);
  assert.deepEqual(argv, ["gate", "--base", "main", "--prefix=qac", "--pretty", "--cwd=/w"]);
  assert.deepEqual(options, { cwd: "/w", answered: [0, 1, 5, 6] });
});

test("the prompt stays visible outside Claude Code and for a Codex turn", () => {
  const shown = '{"decision":"block","reason":"report"}';
  assert.equal(pipeline("qac lint", () => result("answered", 0, "report"), {}, {}).out, shown);
  assert.equal(pipeline("qac lint", () => result("answered", 0, "report"), { turn_id: "t1" }).out, shown);
});

test("a fix with findings reaches the model as additional context through the shared decision", () => {
  const { out } = pipeline("qac fix plugins/shot", () => result("answered", 1, "fix these files"));
  assert.equal(out, '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"fix these files"}}');
});

test("a fix that found nothing answers and drops the typed line", () => {
  const { out } = pipeline("qac fix", () => result("answered", 0, "qac fix: nothing to fix"));
  assert.equal(out, `{"decision":"block","reason":"qac fix: nothing to fix",${HIDDEN}}`);
});

test("the hook process answers qac help through the real CLI and ignores other prompts", () => {
  const run = (prompt) =>
    spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({ prompt, cwd: process.cwd() }),
      encoding: "utf8",
      env: { ...process.env, CLAUDECODE: "1" },
    });
  const help = run("qac");
  assert.equal(help.status, 0);
  const output = JSON.parse(help.stdout);
  assert.equal(output.decision, "block");
  assert.match(output.reason, /qac lint/);
  assert.equal(output.hookSpecificOutput.suppressOriginalPrompt, true);
  const other = run("fix the bug");
  assert.equal(other.status, 0);
  assert.equal(other.stdout, "");
});
