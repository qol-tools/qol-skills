import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const KIT = fileURLToPath(new URL("..", import.meta.url));

test("every kit module loads through require(), so a .cjs hook can use it", () => {
  const modules = readdirSync(KIT).filter((name) => name.endsWith(".mjs"));
  assert.ok(modules.length > 0);
  for (const name of modules) {
    const exports = require(`../${name}`);
    const functions = Object.values(exports).filter((value) => typeof value === "function");
    assert.ok(functions.length > 0, name);
  }
});
