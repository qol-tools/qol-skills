#!/usr/bin/env node
'use strict';

const {
  createReadStream,
  createWriteStream,
  existsSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} = require("node:fs");
const { createInterface } = require("node:readline");
const { homedir } = require("node:os");
const { join } = require("node:path");
const { softenRecord } = require("./soften-lib.cjs");

function walk(dir, out = []) {
  let names;
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of names) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function memoryStore() {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length ? xdg : join(homedir(), ".local", "share");
  return join(base, "qol-tray", "plugins", "qol-memory");
}

function targets() {
  const store = memoryStore();
  return [
    { label: "claude", files: () => walk(join(homedir(), ".claude", "projects")) },
    { label: "codex", files: () => walk(join(homedir(), ".codex", "sessions")) },
    { label: "pi", files: () => walk(join(homedir(), ".pi", "agent", "sessions")) },
    {
      label: "qol-memory",
      files: () => ["units.jsonl", "retrievals.jsonl", "candidates.jsonl", "ingest.jsonl"]
        .map((name) => join(store, name))
        .filter((file) => existsSync(file)),
    },
  ];
}

async function softenFile(file, apply) {
  const temp = file + ".softwords";
  const input = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
  const output = apply ? createWriteStream(temp, "utf8") : null;
  let changed = 0;
  for await (const line of input) {
    let next = line;
    if (line.trim()) {
      try {
        const record = JSON.parse(line);
        if (softenRecord(record)) {
          next = JSON.stringify(record);
          changed += 1;
        }
      } catch {}
    }
    if (output) output.write(next + "\n");
  }
  if (output) {
    await new Promise((resolve, reject) => {
      output.on("error", reject);
      output.end(resolve);
    });
    if (changed) renameSync(temp, file);
    else rmSync(temp, { force: true });
  }
  return changed;
}

function clearSeal() {
  const store = memoryStore();
  let cleared = false;
  for (const name of ["units.seal.gz", "units.seal.json"]) {
    const file = join(store, name);
    if (!existsSync(file)) continue;
    rmSync(file, { force: true });
    cleared = true;
  }
  return cleared;
}

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
  let storeTouched = false;

  for (const target of targets()) {
    if (only && only !== target.label) continue;
    const files = target.files();
    let changedLines = 0;
    let changedFiles = 0;
    for (const file of files) {
      let size = 0;
      try {
        size = statSync(file).size;
      } catch {
        continue;
      }
      if (!size) continue;
      const changed = await softenFile(file, apply);
      if (!changed) continue;
      changedLines += changed;
      changedFiles += 1;
      if (target.label === "qol-memory") storeTouched = true;
    }
    process.stdout.write(
      `${target.label}: ${changedFiles}/${files.length} files, ${changedLines} messages`
      + (apply ? " rewritten\n" : " would change\n"),
    );
  }

  if (apply && storeTouched && clearSeal()) {
    process.stdout.write("qol-memory seal dropped, run: qol-memory reindex\n");
  }
  if (!apply) process.stdout.write("dry run, pass --apply to write\n");
}

if (require.main === module) main();

module.exports = { softenFile, targets };
