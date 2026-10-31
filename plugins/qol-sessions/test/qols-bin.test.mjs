import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const QOLS = fileURLToPath(new URL("../bin/qols", import.meta.url));

function fakePlugin(loopSource) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qols-bin-"));
  fs.mkdirSync(path.join(root, "bin"));
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(QOLS, path.join(root, "bin", "qols"));
  fs.writeFileSync(path.join(root, "scripts", "loop.mjs"), loopSource);
  return path.join(root, "bin", "qols");
}

test("qols passes the driver exit code through", () => {
  const qols = fakePlugin("process.exitCode = 14;\n");
  assert.equal(spawnSync(process.execPath, [qols, "loop", "run", "k1"], { encoding: "utf8" }).status, 14);
});

test("a driver killed by a signal exits 10, the infrastructure code, not 1", { skip: process.platform === "win32" }, () => {
  const qols = fakePlugin("process.kill(process.pid, 'SIGTERM');\nsetTimeout(() => {}, 10000);\n");
  assert.equal(spawnSync(process.execPath, [qols, "loop", "run", "k1"], { encoding: "utf8" }).status, 10);
});
