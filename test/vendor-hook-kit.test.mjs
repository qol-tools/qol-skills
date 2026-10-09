import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { header, sha256 } from "../scripts/vendor-hook-kit.mjs";

const SCRIPT = fileURLToPath(new URL("../scripts/vendor-hook-kit.mjs", import.meta.url));

function write(root, rel, text) {
  const file = path.join(root, ...rel.split("/"));
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, text);
}

function run(root, ...args) {
  return spawnSync(process.execPath, [SCRIPT, "--root", root, ...args], { encoding: "utf8" });
}

function fresh() {
  const root = mkdtempSync(path.join(tmpdir(), "hook-kit-vendor-"));
  write(root, "kit-src/hook-kit/a.mjs", 'import { b } from "./b.mjs";\nexport const a = () => b();\n');
  write(root, "kit-src/hook-kit/b.mjs", "export const b = () => 1;\n");
  write(root, "kit-src/hook-kit/c.mjs", "export const c = () => 2;\n");
  write(root, "kit-src/hook-kit/consumers.json", '["p"]\n');
  write(root, "plugins/p/hooks/h.mjs", 'import { a } from "./_kit/a.mjs";\na();\n');
  write(root, "plugins/q/hooks/h.mjs", "export {};\n");
  assert.equal(run(root).status, 0);
  return root;
}

function copy(root, plugin, module) {
  return path.join(root, "plugins", plugin, "hooks", "_kit", `${module}.mjs`);
}

test("a fresh vendor copies the imported modules and their kit imports, then passes the check", () => {
  const root = fresh();
  assert.ok(existsSync(copy(root, "p", "a")));
  assert.ok(existsSync(copy(root, "p", "b")));
  assert.ok(!existsSync(copy(root, "p", "c")));
  const source = readFileSync(path.join(root, "kit-src", "hook-kit", "b.mjs"), "utf8");
  assert.equal(readFileSync(copy(root, "p", "b"), "utf8"), `${header("b", sha256(source))}\n${source}`);
  assert.match(header("b", sha256(source)), /^\/\/ @generated hook-kit b\.mjs sha256:[0-9a-f]{64} - do not edit; /);
  const check = run(root, "--check");
  assert.equal(check.status, 0, check.stdout);
  assert.match(check.stdout, /2 vendored copies match/);
});

test("the check names each kind of drift and a vendor run repairs it", () => {
  const cases = [
    ["missing", "plugins/p/hooks/_kit/b.mjs", (root) => rmSync(copy(root, "p", "b"))],
    ["edited", "plugins/p/hooks/_kit/a.mjs", (root) => appendFileSync(copy(root, "p", "a"), "export const x = 1;\n")],
    ["stale", "plugins/p/hooks/_kit/b.mjs", (root) => write(root, "kit-src/hook-kit/b.mjs", "export const b = () => 3;\n")],
    ["orphan", "plugins/q/hooks/_kit/c.mjs", (root) => write(root, "plugins/q/hooks/_kit/c.mjs", readFileSync(copy(root, "p", "b"), "utf8"))],
    ["orphan", "plugins/p/hooks/_kit/b.mjs", (root) => write(root, "kit-src/hook-kit/a.mjs", "export const a = () => 0;\n")],
  ];
  for (const [label, rel, drift] of cases) {
    const root = fresh();
    drift(root);
    const check = run(root, "--check");
    assert.equal(check.status, 1, `${label} ${rel}`);
    assert.match(check.stdout, new RegExp(`^${label} ${rel}$`, "m"), check.stdout);
    assert.equal(run(root).status, 0, `${label} ${rel}`);
    assert.equal(run(root, "--check").status, 0, `${label} ${rel} after vendor`);
  }
});

test("a header that a CRLF checkout rewrote still matches", () => {
  const root = fresh();
  const file = copy(root, "p", "a");
  writeFileSync(file, readFileSync(file, "utf8").replace(/\n/g, "\r\n"));
  assert.equal(run(root, "--check").status, 0);
});
