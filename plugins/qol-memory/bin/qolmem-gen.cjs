#!/usr/bin/env node
'use strict';

const { spawnSync } = require("node:child_process");
const { readFileSync, readdirSync, existsSync } = require("node:fs");
const { homedir } = require("node:os");
const { join, dirname } = require("node:path");
const { collectReceipts, unansweredQueue } = require("./qolmem-lib.cjs");

const GEN_RE = /^\s*qolmem(\s+gen)?\s*$/i;

// A launcher question names any project on the machine, so the answerer needs
// every checkout it could be about: the parent of the current repo plus the
// usual homedir roots. Only directories holding at least one git checkout
// qualify, so a stray path never sends the lane wandering the filesystem.
function repoRoots(cwd) {
  const roots = [];
  const add = (dir) => {
    if (!dir || roots.includes(dir)) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const holdsRepo = entries.some(
      (entry) => entry.isDirectory() && existsSync(join(dir, entry.name, ".git"))
    );
    if (holdsRepo) roots.push(dir);
  };
  add(dirname(cwd));
  add(join(homedir(), "Git"));
  add(join(homedir(), "src"));
  add(join(homedir(), "projects"));
  return roots.length ? roots : [cwd];
}
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
const receipts = collectReceipts();
const receiptText = receipts.map((r) => r.summary).join("\n");
if (receipts.length && !GEN_RE.test(prompt)) {
  process.stdout.write(JSON.stringify({
    systemMessage: receiptText,
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: receiptText,
    },
  }) + "\n");
  process.exit(0);
}
if (!GEN_RE.test(prompt)) process.exit(0);

const receiptPrefix = receipts.length ? receiptText + "\n" : "";
const queue = unansweredQueue();
if (!queue.length) block(receiptPrefix + "qolmem: no unanswered questions.");

const model = spawnModel();
if (!model) block(receiptPrefix + "qolmem: no spawn_model in sessions.toml.");

const cwd = typeof payload.cwd === "string" && payload.cwd.length ? payload.cwd : process.cwd();

const roots = repoRoots(cwd).join("', '");
const questions = queue.map((q, i) => `${i + 1}. ${q.query}`).join("\n");
const brief = `You are the answerer for a qol-memory refill run.

Rules:
1. Treat every numbered question independently; never let one answer or one failure color another.
2. A launcher question carries no project context, so never assume it is about the repo you start in. First locate the subject: match the question's distinctive nouns against the directory names, README titles and CLAUDE.md files under '${roots}', and work in whichever repo matches. Say which repo you picked.
3. Then answer from the strongest evidence available, in this order: run the tool itself ("<tool> --help", "-h", or read its argument parsing) when the question asks how to run or invoke something, then read its code, then README.md, docs/ and skills. Docs go stale and often list one spelling of a flag while the code accepts several; when the tool and the docs disagree, the tool wins and the answer names every accepted form. Every claim must be verified in a file you opened or a command you ran, and the report must cite that path or command per question.
4. A question is only unanswerable after you have searched every repo root above, not just the first one. Fragments that name no subject are unanswerable immediately; do not read anything for them.
5. Store each found answer with the qol-memory capture MCP tool (capture), cwd = '${cwd}'. text = exactly two sentences: sentence one is the bare answer alone, 48 characters or fewer (a name, a path, a number, a short phrase; never a restating of the question); sentence two restates the question's own key words and carries the exact paths, commands, or names that prove the answer. Both parts matter: retrieval requires every question word to appear, and the launcher shows sentence one as the bold lead. Do not use a qol-memory shell command; only the MCP tool exists.
6. If, and only if, no repository answers a question, capture nothing for it and write one line naming the files you checked and why they do not answer it.
7. End the report with exactly one line: qolmem: N captured, M unanswerable (N and M are counts). Never use the em-dash character.

Questions:
${questions}`;

const result = spawnSync("qol", ["sessions", "spawn", "--tool", "pi", "--cwd", cwd, "--key", `qolmem-gen-${Date.now()}`, "--model", model, "--title", "qolmem-gen", "--task", brief, "--background", "--silent-wake"], { timeout: 30000 });

if (result.status === 0) {
  block(receiptPrefix + `qolmem: answering lane launched for ${queue.length} question(s); results arrive silently on a later prompt.`);
}

const tail = String(result.stderr || "").trim().slice(-200);
const detail = tail || (result.error && result.error.message) || "";
block(receiptPrefix + `qolmem: spawn failed: ${detail}`);
