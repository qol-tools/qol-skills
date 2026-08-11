#!/usr/bin/env node
const { spawnSync, execFileSync } = require("node:child_process");
const { readFileSync } = require("node:fs");

const RELEVANCE = /\b(flag|config|count|version|status|snapshot|dedupe|schema|note|unit|session|path|memory|decide|retention|keep|trigger|embed|model|command|store|corpus|skill|plugin|bridge|draft|cls|layer|stale|recall|resume|continu|what did|remember|last week|we decided|we agreed|we settled|what was)/i;
const MIN_LEN = 8;

let MEMORY_ROOT;
try {
  const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8", timeout: 1500, windowsHide: true,
  }).trim();
  MEMORY_ROOT = top + "/docs/research/qol-memory/ask.mjs";
} catch {
  MEMORY_ROOT = "";
}

function readStdin() {
  try { return readFileSync(0, "utf8"); } catch { return ""; }
}

function ok(extra) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext: extra,
    },
  }));
  process.exit(0);
}

function bail() { process.exit(0); }

if (process.env.QOL_MEMORY_HOOK_DISABLE === "1") bail();

const raw = readStdin().trim();
if (!raw) bail();
let payload;
try { payload = JSON.parse(raw); } catch { bail(); }
const cwd = payload.cwd || process.cwd();
const prompt = (payload.prompt || "").trim();
if (prompt.length < MIN_LEN) bail();
if (!RELEVANCE.test(prompt)) bail();
if (!MEMORY_ROOT) bail();

const ask = spawnSync("node", [MEMORY_ROOT, prompt, "--brief"], {
  encoding: "utf8", timeout: 4000, windowsHide: true,
});
if (ask.status !== 0 || !ask.stdout) bail();

let result;
try { result = JSON.parse(ask.stdout); } catch { bail(); }
const verdict = result.verdict;
const conf = result.confidence || "none";
if (!verdict) bail();

const sig = result.signals ? ` top_note=${Number(result.signals.top_note_score || 0).toFixed(1)}` : "";
let context = `[qol-memory recall] This prompt matches past-work vocabulary. Memory verdict=${verdict} confidence=${conf}${sig}.`;

if (verdict === "answered" && result.answer) {
  const a = result.answer;
  const receipt = `key ${a.key}, ${a.source_kind || "?"}, ${a.source_ts || "?"}`;
  context += ` Recalled: "${a.text}". Receipt: ${receipt}.`;
  if (a.superseded && a.superseded.length) {
    context += ` Note: this supersedes an older fact (${a.superseded.map((s) => `"${s.text}" ${s.source_ts || ""}`).join("; ")}).`;
  }
} else if (verdict === "candidates" && result.recalled && result.recalled[0]) {
  const c = result.recalled[0];
  context += ` Closest memory (not decisive): key ${c.key}, ${c.source_kind || "?"}, ${c.source_ts || "?"}. Treat as a hint, never as fact.`;
} else if (verdict === "no-memory") {
  return;
}

if (result.non_default_gates) {
  context += " WARNING: non-default MEM_* gates were applied (memory-quality thresholds were externally overridden).";
}

context += " Anchor your reply on the recall when it answers; otherwise proceed normally.";

ok(context);
