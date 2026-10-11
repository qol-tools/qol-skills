#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { classifyRun, keyFor, render, stateDir, summarize, workspaceRoot, writeReport } from "../src/cache-sweep.mjs";

export const EXIT = { ok: 0, usage: 2, notWorkspace: 3, qolFailed: 4 };
const SWEEP_TIMEOUT_MS = 30 * 60 * 1000;

function runQol(root, dryRun) {
  const args = ["clean", "--prune", "--json", ...(dryRun ? ["--dry-run"] : [])];
  return spawnSync("qol", args, { cwd: root, encoding: "utf8", timeout: SWEEP_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true });
}

export function sweep(dir, { dryRun = false, run = runQol, now = Date.now(), cache = stateDir() } = {}) {
  const root = workspaceRoot(dir);
  if (!root) return { exit: EXIT.notWorkspace, error: `not inside a cargo workspace: ${dir}` };
  const report = summarize(root, classifyRun(run(root, dryRun)), { now, dryRun });
  if (!dryRun) writeReport(keyFor(root), report, cache);
  return { exit: report.state === "ok" ? EXIT.ok : EXIT.qolFailed, report };
}

function main(argv) {
  const flags = new Set(argv.filter((arg) => arg.startsWith("--")));
  const positional = argv.filter((arg) => !arg.startsWith("--"));
  const unknown = [...flags].filter((flag) => !["--dry-run", "--pretty"].includes(flag));
  if (unknown.length || positional.length > 1) {
    process.stderr.write("usage: cache-sweep.mjs [dir] [--dry-run] [--pretty]\n");
    return EXIT.usage;
  }
  const result = sweep(path.resolve(positional[0] ?? process.cwd()), { dryRun: flags.has("--dry-run") });
  if (result.error) {
    process.stderr.write(`${result.error}\n`);
    return result.exit;
  }
  process.stdout.write((flags.has("--pretty") ? render(result.report) : JSON.stringify(result.report)) + "\n");
  return result.exit;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
