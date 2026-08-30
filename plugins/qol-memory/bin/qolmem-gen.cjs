#!/usr/bin/env node
'use strict';

const { spawnSync } = require("node:child_process");
const { readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const { unansweredQueue } = require("./qolmem-lib.cjs");

const GEN_RE = /^\s*qolmem(\s+gen)?\s*$/i;
const SPAWN_MODEL_RE = /^\s*spawn_model\s*=\s*"([^"]+)"/m;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function block(message) {
  process.stderr.write(message + "\n");
  process.exit(2);
}

function spawnModel() {
  const path = process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "qol-tray", "sessions.toml")
    : join(homedir(), ".config", "qol-tray", "sessions.toml");
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const m = SPAWN_MODEL_RE.exec(text);
  return m ? m[1] : null;
}

const raw = readStdin().trim();
let payload;
try {
  payload = JSON.parse(raw);
} catch {
  process.exit(0);
}
if (!payload || typeof payload !== "object") process.exit(0);

const prompt = typeof payload.prompt === "string" ? payload.prompt : "";
if (!GEN_RE.test(prompt)) process.exit(0);

const queue = unansweredQueue();
if (!queue.length) block("qolmem: no unanswered questions.");

const model = spawnModel();
if (!model) block("qolmem: no spawn_model in sessions.toml.");

const cwd = typeof payload.cwd === "string" && payload.cwd.length ? payload.cwd : process.cwd();

const questions = queue.map((q, i) => `${i + 1}. ${q.query}`).join("\n");
const brief = `You are the answerer for a qol-memory refill run.

For each numbered question below, find the true answer in this repository: read the README first, then docs and skills, then code, verifying every claim in code.

${questions}

For each question, store its answer by running:
qol-memory capture --text '<one self-contained sentence carrying exact paths, commands, or names>' --cwd '${cwd}'
One capture per question. If the repository does not answer a question, capture nothing for it and say so.
Report results in this terminal. Never use the em-dash character.`;

const result = spawnSync("qol", ["sessions", "fork", "--tool", "pi", "--cwd", cwd, "--key", `qolmem-gen-${Date.now()}`, "--model", model, "--title", "qolmem-gen", "--brief", brief], { timeout: 30000 });

if (result.status === 0) {
  block(`qolmem: answering lane launched for ${queue.length} question(s).`);
}

const tail = String(result.stderr || "").trim().slice(-200);
const detail = tail || (result.error && result.error.message) || "";
block(`qolmem: fork failed: ${detail}`);
