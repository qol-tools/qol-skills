import test from "node:test";
import assert from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { onSessionStart } from "../hooks/cache-sweep-session-start.mjs";
import { EXIT, sweep } from "../scripts/cache-sweep.mjs";
import { OUTDATED, classifyRun, keyFor, readReport, sessionMessage, summarize, workspaceRoot, writeReport } from "../src/cache-sweep.mjs";

const GIB = 1024 ** 3;
const CLI = fileURLToPath(new URL("../scripts/cache-sweep.mjs", import.meta.url));

function workspace() {
  const root = mkdtempSync(path.join(tmpdir(), "cache-sweep-"));
  writeFileSync(path.join(root, "Cargo.toml"), "[workspace]\nmembers = [\"crates/*\"]\n");
  const member = path.join(root, "crates", "app", "src");
  mkdirSync(member, { recursive: true });
  writeFileSync(path.join(root, "crates", "app", "Cargo.toml"), "[package]\nname = \"app\"\n");
  return { root, member };
}

function sweepJson(dirs) {
  return { status: 0, stdout: JSON.stringify({ dry_run: false, freed_bytes: dirs.reduce((sum, dir) => sum + (dir.freed_bytes ?? 0), 0), dirs }), stderr: "" };
}

test("workspaceRoot climbs to the manifest that declares the workspace", () => {
  const { root, member } = workspace();
  assert.equal(workspaceRoot(member), root);
  assert.equal(workspaceRoot(path.join(root, "crates", "app")), root);
  assert.equal(workspaceRoot(mkdtempSync(path.join(tmpdir(), "no-workspace-"))), null);
  assert.equal(workspaceRoot(undefined), null);
  const tables = mkdtempSync(path.join(tmpdir(), "workspace-tables-"));
  writeFileSync(path.join(tables, "Cargo.toml"), "[package]\nname = \"solo\"\n\n[workspace.dependencies]\nserde = \"1\"\n");
  assert.equal(workspaceRoot(tables), tables, "a [workspace.*] table declares a workspace too");
  writeFileSync(path.join(tables, "Cargo.toml"), "[package]\nname = \"solo\"\n");
  assert.equal(workspaceRoot(tables), null, "a plain package is not a workspace");
});

test("classifyRun tells a missing, an outdated, a failed and a working qol apart", () => {
  assert.deepEqual(classifyRun({ status: null, error: { code: "ENOENT" } }), { state: "failed", error: "qol is not installed" });
  assert.equal(classifyRun({ status: 64, stdout: "", stderr: "Command `clean` does not support --json.\n" }).state, OUTDATED);
  assert.deepEqual(classifyRun({ status: 1, stdout: "", stderr: "not inside a workspace\n" }), { state: "failed", error: "not inside a workspace" });
  assert.equal(classifyRun({ status: 0, stdout: "garbage", stderr: "" }).state, "failed");
  assert.equal(classifyRun(sweepJson([{ dir: "/t", freed_bytes: 5 }])).sweep.freed_bytes, 5);
});

test("summarize carries per-directory errors and failures into the report", () => {
  const run = classifyRun(sweepJson([
    { dir: "/repo/target", freed_bytes: 2 * GIB, access_times: true, failures: ["/repo/target/x (Permission denied)"] },
    { dir: "/build", error: "failed to read cargo cache dir /build" },
  ]));
  const report = summarize("/repo", run, { now: 0 });
  assert.equal(report.freedBytes, 2 * GIB);
  assert.deepEqual(report.dirs.map((dir) => dir.dir), ["/repo/target", "/build"]);
  assert.deepEqual(report.problems, ["/repo/target/x (Permission denied)", "/build: failed to read cargo cache dir /build"]);
});

test("sessionMessage speaks only about something worth a line, and only once", () => {
  const base = { root: "/git/qol-monorepo", state: "ok", freedBytes: 0, dirs: [], problems: [], shown: false };
  assert.equal(sessionMessage(null), null);
  assert.equal(sessionMessage({ ...base, freedBytes: 200 * 1024 ** 2 }), null);
  assert.match(sessionMessage({ ...base, freedBytes: 12.5 * GIB }), /^\[qol-cache-sweep\] freed 12\.5 GiB .*\(qol-monorepo\)$/);
  assert.equal(sessionMessage({ ...base, freedBytes: 12.5 * GIB, shown: true }), null);
  assert.match(sessionMessage({ ...base, state: OUTDATED, problems: ["old"] }), /run qol setup/);
  assert.match(sessionMessage({ ...base, problems: ["cargo is busy"] }), /1 problem\(s\): cargo is busy/);
});

test("sweep records the report, except on a dry run", () => {
  const { root, member } = workspace();
  const cache = mkdtempSync(path.join(tmpdir(), "cache-sweep-state-"));
  const calls = [];
  const run = (dir, dryRun) => {
    calls.push([dir, dryRun]);
    return sweepJson([{ dir: path.join(dir, "target"), freed_bytes: 3 * GIB }]);
  };

  const dry = sweep(member, { dryRun: true, run, cache, now: 0 });
  assert.equal(dry.exit, EXIT.ok);
  assert.equal(readReport(keyFor(root), cache), null, "a dry run records nothing");

  const applied = sweep(member, { run, cache, now: 0 });
  assert.equal(applied.exit, EXIT.ok);
  assert.deepEqual(calls, [[root, true], [root, false]], "qol runs at the workspace root");
  assert.equal(readReport(keyFor(root), cache).freedBytes, 3 * GIB);

  const outdated = sweep(member, { run: () => ({ status: 64, stdout: "", stderr: "Command `clean` does not support --json." }), cache });
  assert.equal(outdated.exit, EXIT.qolFailed);
  assert.equal(readReport(keyFor(root), cache).state, OUTDATED);

  assert.equal(sweep(mkdtempSync(path.join(tmpdir(), "no-workspace-")), { run, cache }).exit, EXIT.notWorkspace);
});

test("the session-start hook shows the last report once and launches at most hourly", () => {
  const { root, member } = workspace();
  const cache = mkdtempSync(path.join(tmpdir(), "cache-sweep-state-"));
  const launched = [];
  const launch = (dir) => launched.push(dir);
  writeReport(keyFor(root), { root, state: "ok", freedBytes: 4 * GIB, dirs: [], problems: [], shown: false }, cache);
  const now = Date.now();

  const first = onSessionStart({ cwd: member }, { now, cache, launch });
  const second = onSessionStart({ cwd: member }, { now: now + 60 * 1000, cache, launch });
  const later = onSessionStart({ cwd: member }, { now: now + 2 * 60 * 60 * 1000, cache, launch });

  assert.match(first, /freed 4\.0 GiB/);
  assert.equal(second, null, "a shown report stays quiet");
  assert.equal(later, null);
  assert.deepEqual(launched, [root, root], "one launch now, the next after the hour");
  assert.equal(onSessionStart({ cwd: mkdtempSync(path.join(tmpdir(), "no-workspace-")) }, { now, cache, launch }), null);
  assert.equal(launched.length, 2, "no sweep outside a cargo workspace");
});

test("the CLI rejects flags it does not know", () => {
  const result = spawnSync(process.execPath, [CLI, "--force"], { encoding: "utf8" });
  assert.equal(result.status, EXIT.usage);
  assert.match(result.stderr, /usage: cache-sweep\.mjs/);
});

test("the hook prints nothing outside a cargo workspace", () => {
  const hook = fileURLToPath(new URL("../hooks/cache-sweep-session-start.mjs", import.meta.url));
  const output = execFileSync(process.execPath, [hook], { input: JSON.stringify({ cwd: mkdtempSync(path.join(tmpdir(), "no-workspace-")) }), encoding: "utf8" });
  assert.equal(output, "");
});
