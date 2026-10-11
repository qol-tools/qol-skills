#!/usr/bin/env node
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { keyFor, markStarted, readReport, sessionMessage, startedWithin, stateDir, workspaceRoot, writeReport } from "../src/cache-sweep.mjs";

const SWEEP_EVERY_MS = 60 * 60 * 1000;
const SWEEP = fileURLToPath(new URL("../scripts/cache-sweep.mjs", import.meta.url));

export function onSessionStart(input, { now = Date.now(), cache = stateDir(), launch = launchSweep } = {}) {
  const root = workspaceRoot(input?.cwd);
  if (!root) return null;
  const key = keyFor(root);
  const report = readReport(key, cache);
  const message = sessionMessage(report);
  if (report && !report.shown) writeReport(key, { ...report, shown: true }, cache);
  if (!startedWithin(key, SWEEP_EVERY_MS, now, cache)) {
    markStarted(key, cache);
    launch(root);
  }
  return message;
}

function launchSweep(root) {
  const child = spawn(process.execPath, [SWEEP, root], { cwd: path.dirname(SWEEP), detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
}

function main() {
  let input = null;
  try {
    input = JSON.parse(fs.readFileSync(0, "utf8"));
  } catch {}
  const message = onSessionStart(input);
  if (!message) return;
  process.stdout.write(JSON.stringify({
    systemMessage: message,
    hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: message },
  }) + "\n");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
