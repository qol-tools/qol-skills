import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const TAG = "[qol-cache-sweep]";
export const OUTDATED = "outdated";

export function stateDir() {
  return path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "qol-cache-sweep");
}

export function workspaceRoot(start, read = (file) => fs.readFileSync(file, "utf8")) {
  if (!start) return null;
  let dir = path.resolve(start);
  for (;;) {
    let manifest = null;
    try {
      manifest = read(path.join(dir, "Cargo.toml"));
    } catch {}
    if (manifest !== null && /^\s*\[\s*workspace\s*[\].]/m.test(manifest)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function keyFor(root) {
  return crypto.createHash("sha1").update(root).digest("hex").slice(0, 16);
}

function file(key, suffix, dir) {
  return path.join(dir, `${key}.${suffix}`);
}

export function readReport(key, dir = stateDir()) {
  try {
    return JSON.parse(fs.readFileSync(file(key, "json", dir), "utf8"));
  } catch {
    return null;
  }
}

export function writeReport(key, report, dir = stateDir()) {
  fs.mkdirSync(dir, { recursive: true });
  const target = file(key, "json", dir);
  fs.writeFileSync(`${target}.tmp`, JSON.stringify(report, null, 2) + "\n");
  fs.renameSync(`${target}.tmp`, target);
}

export function startedWithin(key, windowMs, now, dir = stateDir()) {
  try {
    return now - fs.statSync(file(key, "started", dir)).mtimeMs < windowMs;
  } catch {
    return false;
  }
}

export function markStarted(key, dir = stateDir()) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(file(key, "started", dir), "");
}

export function classifyRun({ status, stdout, stderr, error }) {
  if (error?.code === "ENOENT") return { state: "failed", error: "qol is not installed" };
  const detail = `${stderr ?? ""}`.trim() || error?.message || `qol exited with ${status}`;
  if (status !== 0) {
    if (/does not support --json|unknown flag --prune/.test(detail)) return { state: OUTDATED, error: detail };
    return { state: "failed", error: detail };
  }
  try {
    return { state: "ok", sweep: JSON.parse(stdout) };
  } catch {
    return { state: "failed", error: "qol clean --prune --json printed no JSON" };
  }
}

export function summarize(root, run, { now = Date.now(), dryRun = false } = {}) {
  const report = { root, at: new Date(now).toISOString(), dryRun, state: run.state, freedBytes: 0, dirs: [], problems: [], shown: false };
  if (run.state !== "ok") {
    report.problems.push(run.error);
    return report;
  }
  report.freedBytes = run.sweep.freed_bytes ?? 0;
  for (const entry of run.sweep.dirs ?? []) {
    report.dirs.push({ dir: entry.dir, freedBytes: entry.freed_bytes ?? 0, accessTimes: entry.access_times ?? null });
    if (entry.error) report.problems.push(`${entry.dir}: ${entry.error}`);
    for (const failure of entry.failures ?? []) report.problems.push(failure);
  }
  return report;
}

export function formatBytes(bytes) {
  const gib = 1024 ** 3;
  const mib = 1024 ** 2;
  if (bytes >= gib) return `${(bytes / gib).toFixed(1)} GiB`;
  if (bytes >= mib) return `${Math.floor(bytes / mib)} MiB`;
  return `${Math.floor(bytes / 1024)} KiB`;
}

export function sessionMessage(report) {
  if (!report || report.shown) return null;
  if (report.state === OUTDATED) return `${TAG} the installed qol cannot prune cargo caches yet; run qol setup`;
  if (report.problems.length) return `${TAG} cargo cache sweep of ${path.basename(report.root)} hit ${report.problems.length} problem(s): ${report.problems[0]}`;
  if (report.freedBytes < 1024 ** 3) return null;
  return `${TAG} freed ${formatBytes(report.freedBytes)} of cargo caches no build still uses (${path.basename(report.root)})`;
}

export function render(report) {
  const lines = [`${path.basename(report.root)}${report.dryRun ? " (dry run)" : ""}`];
  for (const dir of report.dirs) lines.push(`  ${report.dryRun ? "prunable" : "freed"}  ${formatBytes(dir.freedBytes)}  ${dir.dir}`);
  for (const problem of report.problems) lines.push(`  problem  ${problem}`);
  if (report.state === OUTDATED) lines.push("  run qol setup to install a qol that has qol clean --prune");
  return lines.join("\n");
}
