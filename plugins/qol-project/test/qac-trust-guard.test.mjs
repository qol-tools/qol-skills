import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { decide, guards } from "../hooks/qac-trust-guard.mjs";

const HOOK = fileURLToPath(new URL("../hooks/qac-trust-guard.mjs", import.meta.url));

const DENIED = [
  "qac trust approve",
  "qac trust approve --cwd /w --accept /w/accept.json",
  "qac trust --cwd /w approve",
  "qac --pretty trust approve",
  "/home/me/.claude/plugins/qol-project/bin/qac trust approve",
  "node /p/qol-project/scripts/qac.mjs trust approve --cwd .",
  "node --no-warnings /p/scripts/qac.mjs trust approve",
  "node.exe C:\\plugins\\qol-project\\scripts\\qac.mjs trust approve",
  "qac.cmd trust approve",
  "FOO=1 qac trust approve",
  "sudo env X=1 qac trust approve",
  "cd /w && qac trust approve",
  "qac lint; qac trust approve",
  "qac gate | tee out && qac trust approve --cwd /w",
  'bash -c "qac trust approve --cwd /w"',
  "sh -c 'node /p/scripts/qac.mjs trust approve'",
  "QAC=1 bash -c 'cd /w; qac trust approve'",
  `bash -c 'bash -c "qac trust approve"'`,
];

const ALLOWED = [
  "qac trust",
  "qac trust --pretty",
  "qac gate --cwd /w",
  "qac lint && qac traps",
  "qac slip --fingerprint fp --from x",
  'rg "qac trust approve" docs',
  "echo qac trust approve",
  "cat plugins/qol-project/commands/qac.md",
  "node -e 'console.log(1)'",
  "node scripts/other.mjs trust approve",
  "git commit -m 'document qac trust approve'",
  "",
];

test("every spelling of an agent-run qac trust approve is denied", () => {
  for (const command of DENIED) assert.equal(guards(command), true, command);
});

test("other qac verbs and text that only mentions the command pass", () => {
  for (const command of ALLOWED) assert.equal(guards(command), false, command);
});

test("the deny is JSON on stdout in two short lines naming the hook", () => {
  const out = JSON.parse(decide({ tool_name: "Bash", tool_input: { command: "qac trust approve" } }));
  assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  const lines = out.hookSpecificOutput.permissionDecisionReason.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], /qac trust approve/);
  assert.match(lines[1], /^\[qac-trust-guard\] /);
});

test("only Bash tool calls with a command string are judged", () => {
  assert.equal(decide({ tool_name: "Edit", tool_input: { command: "qac trust approve" } }), null);
  assert.equal(decide({ tool_name: "Bash", tool_input: {} }), null);
  assert.equal(decide({ tool_name: "Bash", tool_input: { command: "qac trust" } }), null);
  assert.equal(decide(null), null);
});

test("the hook process denies on stdout with exit 0 and stays silent otherwise", () => {
  const run = command => spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
    encoding: "utf8",
  });
  const denied = run("qac trust approve");
  assert.equal(denied.status, 0);
  assert.equal(JSON.parse(denied.stdout).hookSpecificOutput.permissionDecision, "deny");
  const allowed = run("qac gate");
  assert.equal(allowed.status, 0);
  assert.equal(allowed.stdout, "");
  const garbage = spawnSync(process.execPath, [HOOK], { input: "not json", encoding: "utf8" });
  assert.equal(garbage.status, 0);
  assert.equal(garbage.stdout, "");
});
