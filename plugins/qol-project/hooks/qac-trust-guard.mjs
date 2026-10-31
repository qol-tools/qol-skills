#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { parseArgs } from "../scripts/qac.mjs";
import { readHookInput } from "./_kit/input.mjs";
import { denyJson } from "./_kit/output.mjs";

const SEPARATORS = new Set([";", "&", "|", "\n", "(", ")"]);
const WRAPPERS = new Set(["sudo", "env", "command", "exec", "nohup", "time", "nice"]);
const NODES = new Set(["node", "nodejs"]);
const SHELLS = new Set(["sh", "bash", "zsh", "dash", "ksh"]);
const QAC_NAMES = new Set(["qac", "qac.mjs"]);
const MAX_DEPTH = 3;

function baseName(token) {
  return token.split(/[\\/]/).pop().replace(/\.(exe|cmd|bat)$/i, "").toLowerCase();
}

export function segmentsOf(command) {
  const segments = [];
  let tokens = [];
  let word = null;
  let quote = null;
  const endWord = () => {
    if (word !== null) tokens.push(word);
    word = null;
  };
  const endSegment = () => {
    endWord();
    if (tokens.length > 0) segments.push(tokens);
    tokens = [];
  };
  for (const char of String(command)) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      word ??= "";
    } else if (SEPARATORS.has(char)) {
      endSegment();
    } else if (/\s/.test(char)) {
      endWord();
    } else {
      word = (word ?? "") + char;
    }
  }
  endSegment();
  return segments;
}

function commandStart(tokens) {
  let at = 0;
  while (at < tokens.length && (/^[A-Za-z_]\w*=/.test(tokens[at]) || WRAPPERS.has(baseName(tokens[at])))) at += 1;
  return at;
}

function approvesTrust(tokens, depth) {
  const at = commandStart(tokens);
  const name = tokens[at] === undefined ? "" : baseName(tokens[at]);
  if (SHELLS.has(name)) {
    const script = tokens.indexOf("-c", at);
    return depth < MAX_DEPTH && script >= 0 && tokens[script + 1] !== undefined && guards(tokens[script + 1], depth + 1);
  }
  let rest = tokens.slice(at + 1);
  let program = name;
  if (NODES.has(name)) {
    const script = rest.findIndex(token => !token.startsWith("-"));
    if (script < 0) return false;
    program = baseName(rest[script]);
    rest = rest.slice(script + 1);
  }
  if (!QAC_NAMES.has(program)) return false;
  const args = parseArgs(rest);
  return args.verb === "trust" && args.paths[0] === "approve";
}

export function guards(command, depth = 0) {
  return segmentsOf(command).some(tokens => approvesTrust(tokens, depth));
}

export function decide(input) {
  if (input?.tool_name !== "Bash") return null;
  const command = input.tool_input?.command;
  if (typeof command !== "string" || !guards(command)) return null;
  return denyJson({
    hook: "qac-trust-guard",
    why: "An agent may not run qac trust approve: it widens which commands qac gate runs, and only the user decides that.",
    hint: "Ask the user to type `qac trust approve` as their own prompt; the typed verb is not blocked.",
  });
}

function main() {
  const out = decide(readHookInput());
  if (out !== null) process.stdout.write(`${out}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
