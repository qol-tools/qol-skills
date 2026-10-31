import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ensureSetup, setupMarker } from "../src/gate/setup.mjs";

function scratch() {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "qac-gate-setup-")));
  const cwd = path.join(root, "work");
  const commonDir = path.join(root, "common");
  mkdirSync(cwd);
  mkdirSync(commonDir);
  return { root, cwd, commonDir };
}

function recorder(results = []) {
  const calls = [];
  const spawn = (command, args, options) => {
    calls.push({ command, args, options });
    return results.shift() ?? { status: 0, stdout: "", stderr: "" };
  };
  return { calls, spawn };
}

const CONFIG = { setup: [["npm", "ci"], ["uv", "sync"]], defaults: { timeout_s: 30 } };

test("runs each setup argv once in order, then skips on the marker", () => {
  const { cwd, commonDir } = scratch();
  const { calls, spawn } = recorder();
  const first = ensureSetup({ cwd, config: CONFIG, commonDir }, { spawn, now: () => "2026-10-31T00:00:00.000Z" });
  assert.equal(first.ran, true);
  assert.equal(first.ok, true);
  assert.equal(first.error, null);
  assert.deepEqual(calls.map(call => [call.command, ...call.args]), [["npm", "ci"], ["uv", "sync"]]);
  assert.equal(calls[0].options.cwd, cwd);
  assert.equal(calls[0].options.timeout, 30000);
  assert.ok(existsSync(first.marker));
  assert.deepEqual(JSON.parse(readFileSync(first.marker, "utf8")), { at: "2026-10-31T00:00:00.000Z", setup: CONFIG.setup });
  const second = ensureSetup({ cwd, config: CONFIG, commonDir }, { spawn });
  assert.deepEqual(second, { ran: false, ok: true, marker: first.marker, error: null });
  assert.equal(calls.length, 2);
});

test("the marker lives under qac/setup and changes with the worktree and the lockfile hashes", () => {
  const one = scratch();
  const two = scratch();
  const marker = setupMarker({ cwd: one.cwd, commonDir: one.commonDir });
  assert.match(path.relative(one.commonDir, marker), /^qac[\\/]setup[\\/][0-9a-f]{16}\.done$/);
  assert.equal(path.basename(setupMarker({ cwd: two.cwd, commonDir: one.commonDir })).length, 21);
  assert.notEqual(setupMarker({ cwd: two.cwd, commonDir: one.commonDir }), marker);
  writeFileSync(path.join(one.cwd, "package-lock.json"), "{}");
  const withLock = setupMarker({ cwd: one.cwd, commonDir: one.commonDir });
  assert.notEqual(withLock, marker);
  writeFileSync(path.join(one.cwd, "package-lock.json"), '{"changed":true}');
  assert.notEqual(setupMarker({ cwd: one.cwd, commonDir: one.commonDir }), withLock);
  writeFileSync(path.join(one.cwd, "notes.txt"), "not a lockfile");
  writeFileSync(path.join(one.cwd, "package-lock.json"), "{}");
  assert.equal(setupMarker({ cwd: one.cwd, commonDir: one.commonDir }), withLock);
});

test("every considered lockfile contributes to the marker", () => {
  const { cwd, commonDir } = scratch();
  let previous = setupMarker({ cwd, commonDir });
  for (const name of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "uv.lock", "poetry.lock", "go.sum"]) {
    writeFileSync(path.join(cwd, name), name);
    const next = setupMarker({ cwd, commonDir });
    assert.notEqual(next, previous, name);
    previous = next;
  }
});

test("a changed lockfile reruns setup", () => {
  const { cwd, commonDir } = scratch();
  const { calls, spawn } = recorder();
  writeFileSync(path.join(cwd, "Cargo.lock"), "one");
  ensureSetup({ cwd, config: CONFIG, commonDir }, { spawn });
  writeFileSync(path.join(cwd, "Cargo.lock"), "two");
  const result = ensureSetup({ cwd, config: CONFIG, commonDir }, { spawn });
  assert.equal(result.ran, true);
  assert.equal(calls.length, 4);
});

test("a failing argv stops setup, reports the cause and leaves no marker so it retries", () => {
  const { cwd, commonDir } = scratch();
  const { calls, spawn } = recorder([{ status: 1, stdout: "", stderr: "registry unreachable\n" }]);
  const result = ensureSetup({ cwd, config: CONFIG, commonDir }, { spawn });
  assert.equal(result.ran, true);
  assert.equal(result.ok, false);
  assert.match(result.error, /npm ci exited 1: registry unreachable/);
  assert.equal(calls.length, 1);
  assert.equal(existsSync(result.marker), false);
  const retry = ensureSetup({ cwd, config: CONFIG, commonDir }, { spawn });
  assert.equal(retry.ok, true);
  assert.equal(calls.length, 3);
});

test("a spawn error and a signal are failures", () => {
  const { cwd, commonDir } = scratch();
  const missing = ensureSetup({ cwd, config: CONFIG, commonDir }, { spawn: () => ({ status: null, error: new Error("spawn npm ENOENT") }) });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /spawn npm ENOENT/);
  const killed = ensureSetup({ cwd, config: CONFIG, commonDir }, { spawn: () => ({ status: null, signal: "SIGTERM", stderr: "" }) });
  assert.equal(killed.ok, false);
  assert.match(killed.error, /exited SIGTERM/);
});

test("an invalid setup entry is a failure", () => {
  const { cwd, commonDir } = scratch();
  const { calls, spawn } = recorder();
  const result = ensureSetup({ cwd, config: { setup: ["npm ci"] }, commonDir }, { spawn });
  assert.equal(result.ok, false);
  assert.match(result.error, /not an argv array/);
  assert.equal(calls.length, 0);
});

test("no setup commands runs nothing and writes nothing", () => {
  const { cwd, commonDir } = scratch();
  const { calls, spawn } = recorder();
  for (const config of [{}, { setup: [] }, undefined]) {
    const result = ensureSetup({ cwd, config, commonDir }, { spawn });
    assert.equal(result.ran, false);
    assert.equal(result.ok, true);
    assert.equal(existsSync(result.marker), false);
  }
  assert.equal(calls.length, 0);
});

test("the timeout defaults to 600 seconds", () => {
  const { cwd, commonDir } = scratch();
  const { calls, spawn } = recorder();
  ensureSetup({ cwd, config: { setup: [["make", "deps"]] }, commonDir }, { spawn });
  assert.equal(calls[0].options.timeout, 600000);
});
