import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { main } from "../scripts/loop.mjs";

const require = createRequire(import.meta.url);
const { featureLoopState } = require("../bin/guard-session-feature-loop.cjs");

const BASE = "b".repeat(40);

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "guard-receipts-"));
  const repo = path.join(root, "main");
  const common = path.join(repo, ".git");
  fs.mkdirSync(common, { recursive: true });
  const specFile = path.join(root, "spec.md");
  fs.writeFileSync(specFile, "# spec\n");
  const binDir = path.join(root, "bin");
  const isQac = (file) => path.dirname(String(file)) === binDir;
  const exec = (argv) => {
    if (argv[0] === "git" && argv[2] === "--git-common-dir") return { status: 0, stdout: `${common}\n`, stderr: "" };
    if (argv[0] === "git" && argv[2] === "--verify") return { status: 0, stdout: `${BASE}\n`, stderr: "" };
    if (isQac(argv[0]) && argv[1] === "trust") return { status: 0, stdout: "", stderr: "" };
    if (isQac(argv[0]) && argv[1] === "gate") {
      const out = argv[argv.indexOf("--out") + 1];
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, "gate.json"), JSON.stringify({ schema: 1, verdict: "clean", findings: [] }));
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const deps = {
    exec,
    env: { PATH: binDir, QOL_SESSIONS_RETRO: path.join(root, "retro.jsonl") },
    exists: (file) => isQac(file) || (file.startsWith(root) && !file.includes("worktrees") && fs.existsSync(file)),
    now: () => new Date("2026-10-31T12:00:00Z"),
    parseSpec: (text) => ({
      ok: true,
      front: { lane: { tool: "claude", model: "claude-sonnet-5-5" }, owned: ["plugins/x/**"], accept: [{ id: "unit", argv: ["make", "test"] }], implementers: 1 },
      text,
    }),
    validateFront: () => [],
    addWorktree: () => {},
  };
  return { repo, specFile, deps };
}

function transcript(commands) {
  const entries = [];
  let parent = null;
  commands.forEach(({ command, stdout }, index) => {
    const call = { uuid: `call-${index}`, parentUuid: parent, isSidechain: false, type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: `bash-${index}`, name: "Bash", input: { command } }] } };
    const result = { uuid: `result-${index}`, parentUuid: call.uuid, isSidechain: false, type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: `bash-${index}`, is_error: false, content: [{ type: "text", text: stdout }] }] } };
    entries.push(call, result);
    parent = result.uuid;
  });
  return entries;
}

for (const pretty of [false, true]) {
  test(`the real open and close output ${pretty ? "in pretty form " : ""}arms and disarms the stop guard`, async () => {
    const ctx = setup();
    const extra = pretty ? ["--pretty"] : [];
    const opened = await main(["open", "k1", "--spec", ctx.specFile, "--cwd", ctx.repo, ...extra], { loop: ctx.deps });
    assert.equal(opened.exit, 0);
    const armed = featureLoopState(transcript([{ command: `qols loop open k1 --spec ${ctx.specFile}${pretty ? " --pretty" : ""}`, stdout: opened.stdout }]));
    assert.equal(armed.phase, "review");
    assert.equal(armed.driverArmed, true);
    assert.deepEqual(armed.keys, ["k1"]);

    const closed = await main(["close", "k1", "--outcome", "paused", "--cwd", ctx.repo, ...extra], { loop: ctx.deps });
    assert.equal(closed.exit, 0);
    const done = featureLoopState(transcript([
      { command: "qols loop open k1 --spec spec.md", stdout: opened.stdout },
      { command: `qols loop close k1 --outcome paused${pretty ? " --pretty" : ""}`, stdout: closed.stdout },
    ]));
    assert.equal(done.phase, "idle");
    assert.equal(done.closed, true);
    assert.equal(done.driverArmed, false);
  });
}
