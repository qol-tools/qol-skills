#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HEADER = /^\/\/ @generated hook-kit ([\w-]+)\.mjs sha256:([0-9a-f]{64}) /;
const SKIP = new Set(["_kit", "node_modules", ".git"]);

export function header(module, hash) {
  return `// @generated hook-kit ${module}.mjs sha256:${hash} - do not edit; change qol-skills/kit-src/hook-kit, then run vs vendor`;
}

export function sha256(text) {
  return createHash("sha256").update(text.replace(/\r\n/g, "\n")).digest("hex");
}

function kitImports(text) {
  return [...text.matchAll(/from\s+["']\.\/([\w-]+)\.mjs["']/g)].map((match) => match[1]);
}

function pluginImports(text) {
  return [...text.matchAll(/_kit\/([\w-]+)\.mjs["']/g)].map((match) => match[1]);
}

function sourceFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return SKIP.has(entry.name) ? [] : sourceFiles(full);
    return /\.(mjs|cjs|js)$/.test(entry.name) ? [full] : [];
  });
}

function wanted(pluginDir, kit) {
  const queue = sourceFiles(pluginDir).flatMap((file) => pluginImports(readFileSync(file, "utf8")));
  const seen = new Set();
  while (queue.length > 0) {
    const module = queue.pop();
    if (seen.has(module)) continue;
    seen.add(module);
    if (kit.has(module)) queue.push(...kitImports(kit.get(module)));
  }
  return seen;
}

function modules(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".mjs")).map((name) => name.slice(0, -".mjs".length));
}

function label(file, module, want, have, kit) {
  if (!want.has(module)) return "orphan";
  if (!have.has(module)) return "missing";
  const copy = readFileSync(file, "utf8");
  const split = copy.indexOf("\n");
  const match = HEADER.exec(split === -1 ? copy : copy.slice(0, split));
  if (match === null || match[1] !== module || sha256(copy.slice(split + 1)) !== match[2]) return "edited";
  if (!kit.has(module) || sha256(kit.get(module)) !== match[2]) return "stale";
  return "ok";
}

export function vendorState(root) {
  const kitDir = path.join(root, "kit-src", "hook-kit");
  const kit = new Map(modules(kitDir).map((module) => [module, readFileSync(path.join(kitDir, `${module}.mjs`), "utf8")]));
  const consumers = JSON.parse(readFileSync(path.join(kitDir, "consumers.json"), "utf8"));
  const pluginsDir = path.join(root, "plugins");
  const vendored = existsSync(pluginsDir)
    ? readdirSync(pluginsDir).filter((plugin) => existsSync(path.join(pluginsDir, plugin, "hooks", "_kit")))
    : [];
  const entries = [];
  for (const plugin of [...new Set([...consumers, ...vendored])].sort()) {
    const pluginDir = path.join(pluginsDir, plugin);
    const copyDir = path.join(pluginDir, "hooks", "_kit");
    const want = consumers.includes(plugin) ? wanted(pluginDir, kit) : new Set();
    const have = new Set(modules(copyDir));
    for (const module of [...new Set([...want, ...have])].sort()) {
      const file = path.join(copyDir, `${module}.mjs`);
      entries.push({
        module,
        file,
        rel: path.relative(root, file).split(path.sep).join("/"),
        label: label(file, module, want, have, kit),
        source: kit.get(module),
      });
    }
  }
  return entries;
}

function check(root) {
  const entries = vendorState(root);
  const drift = entries.filter((entry) => entry.label !== "ok");
  for (const entry of drift) console.log(`${entry.label} ${entry.rel}`);
  if (drift.length > 0) {
    console.log("hook-kit: run node scripts/vendor-hook-kit.mjs to regenerate the copies");
    return 1;
  }
  console.log(`hook-kit: ${entries.length} vendored copies match kit-src/hook-kit`);
  return 0;
}

function vendor(root) {
  let status = 0;
  let changed = 0;
  for (const entry of vendorState(root)) {
    if (entry.label === "ok") continue;
    changed += 1;
    if (entry.label === "orphan") {
      rmSync(entry.file);
      console.log(`removed ${entry.rel}`);
    } else if (entry.source === undefined) {
      console.error(`hook-kit: kit-src/hook-kit has no ${entry.module}.mjs for ${entry.rel}`);
      status = 1;
    } else {
      mkdirSync(path.dirname(entry.file), { recursive: true });
      writeFileSync(entry.file, `${header(entry.module, sha256(entry.source))}\n${entry.source}`);
      console.log(`wrote ${entry.rel}`);
    }
  }
  if (changed === 0) console.log("hook-kit: vendored copies already match kit-src/hook-kit");
  return status;
}

function main(argv) {
  let root = fileURLToPath(new URL("..", import.meta.url));
  let mode = vendor;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--check") mode = check;
    else if (argv[index] === "--root" && index + 1 < argv.length) root = argv[++index];
    else {
      console.error("usage: node scripts/vendor-hook-kit.mjs [--check] [--root <repo>]");
      return 2;
    }
  }
  return mode(path.resolve(root));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
