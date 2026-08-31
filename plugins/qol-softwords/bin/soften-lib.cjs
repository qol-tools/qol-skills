'use strict';

const { existsSync, readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const DEFAULT_WORDS = join(__dirname, "words.json");

function wordsFile() {
  const override = process.env.QOL_SOFTWORDS_FILE;
  if (override && existsSync(override)) return override;
  const user = join(homedir(), ".config", "qol-softwords", "words.json");
  return existsSync(user) ? user : DEFAULT_WORDS;
}

function loadWords() {
  try {
    const parsed = JSON.parse(readFileSync(wordsFile(), "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function matchCase(source, replacement) {
  if (source === source.toUpperCase() && source !== source.toLowerCase()) {
    return replacement.toUpperCase();
  }
  if (source[0] === source[0].toUpperCase()) {
    return replacement[0].toUpperCase() + replacement.slice(1);
  }
  return replacement;
}

function buildMatcher(words) {
  const keys = Object.keys(words).sort((a, b) => b.length - a.length);
  if (!keys.length) return null;
  const escaped = keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp("\\b(" + escaped.join("|") + ")\\b", "gi");
}

let cached = null;

function matcher() {
  if (!cached) {
    const words = loadWords();
    cached = { words, re: buildMatcher(words) };
  }
  return cached;
}

function soften(text) {
  if (typeof text !== "string" || !text.length) return text;
  const { words, re } = matcher();
  if (!re) return text;
  re.lastIndex = 0;
  return text.replace(re, (found) => {
    const replacement = words[found.toLowerCase()];
    return replacement === undefined ? found : matchCase(found, replacement);
  });
}

function isUserText(item) {
  return item && typeof item === "object"
    && (item.type === "text" || item.type === "input_text")
    && typeof item.text === "string";
}

function softenUserContent(node) {
  let changed = false;
  if (typeof node.content === "string") {
    const next = soften(node.content);
    if (next !== node.content) {
      node.content = next;
      changed = true;
    }
    return changed;
  }
  if (!Array.isArray(node.content)) return false;
  for (const item of node.content) {
    if (!isUserText(item)) continue;
    const next = soften(item.text);
    if (next !== item.text) {
      item.text = next;
      changed = true;
    }
  }
  return changed;
}

function softenRecord(node) {
  if (!node || typeof node !== "object") return false;
  let changed = false;
  if (Array.isArray(node)) {
    for (const item of node) changed = softenRecord(item) || changed;
    return changed;
  }
  if (node.role === "user") changed = softenUserContent(node) || changed;
  if (node.kind === "user" && typeof node.text === "string") {
    const next = soften(node.text);
    if (next !== node.text) {
      node.text = next;
      changed = true;
    }
  }
  if (node.source === "launcher" && typeof node.query === "string") {
    const next = soften(node.query);
    if (next !== node.query) {
      node.query = next;
      changed = true;
    }
  }
  for (const value of Object.values(node)) {
    if (value && typeof value === "object") changed = softenRecord(value) || changed;
  }
  return changed;
}

function softenJsonl(text) {
  const lines = text.split("\n");
  let changed = 0;
  const out = lines.map((line) => {
    if (!line.trim()) return line;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return line;
    }
    if (!softenRecord(record)) return line;
    changed += 1;
    return JSON.stringify(record);
  });
  return { text: out.join("\n"), changed };
}

module.exports = { soften, softenRecord, softenJsonl, wordsFile };
