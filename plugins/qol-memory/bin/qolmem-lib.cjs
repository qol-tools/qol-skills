#!/usr/bin/env node
'use strict';

const { existsSync, readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MIN_QUERY = 4;
const CAP = 3;
const BURST_MS = 15000;
const UNANSWERED = new Set(["no-memory", "candidates"]);

function storeDir() {
  if (process.env.QOL_MEMORY_STORE && process.env.QOL_MEMORY_STORE.length) {
    return process.env.QOL_MEMORY_STORE;
  }
  const candidates = [];
  if (process.platform === "darwin") {
    candidates.push(join(homedir(), "Library", "Application Support", "qol-tray", "plugins", "qol-memory"));
  }
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length ? xdg : join(homedir(), ".local", "share");
  candidates.push(join(base, "qol-tray", "plugins", "qol-memory"));
  for (const dir of candidates) {
    if (existsSync(join(dir, "retrievals.jsonl"))) return dir;
  }
  return null;
}

function normalizeQuery(query) {
  return query.toLowerCase().replace(/\s+/g, " ").trim().replace(/\?+$/, "").trim();
}

function firstToken(norm) {
  return norm.split(" ")[0];
}

function unansweredQueue() {
  const dir = storeDir();
  if (!dir) return [];
  let text;
  try {
    text = readFileSync(join(dir, "retrievals.jsonl"), "utf8");
  } catch {
    return [];
  }
  const cutoff = Date.now() - WINDOW_MS;
  const latest = new Map();
  for (const line of text.split("\n")) {
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (!event || typeof event !== "object") continue;
    if (event.source !== "launcher") continue;
    if (typeof event.query !== "string" || !event.query.length) continue;
    const ts = Date.parse(event.ts);
    if (!Number.isFinite(ts) || ts < cutoff) continue;
    const norm = normalizeQuery(event.query);
    if (norm.length < MIN_QUERY) continue;
    const prev = latest.get(norm);
    if (prev && prev.ts > ts) continue;
    latest.set(norm, { norm, query: event.query, ts, verdict: event.verdict });
  }
  const entries = [...latest.values()].filter((e) => UNANSWERED.has(e.verdict));
  const prefixKept = entries.filter((e) => !entries.some((other) => other.norm.length > e.norm.length && other.norm.startsWith(e.norm)));
  const survived = prefixKept.filter((e) => !prefixKept.some((other) =>
    firstToken(other.norm) === firstToken(e.norm) &&
    Math.abs(other.ts - e.ts) <= BURST_MS &&
    (other.norm.length > e.norm.length || (other.norm.length === e.norm.length && other.ts > e.ts))
  ));
  survived.sort((a, b) => b.ts - a.ts);
  return survived.slice(0, CAP).map((e) => ({ query: e.query, ts: e.ts }));
}

module.exports = { storeDir, unansweredQueue };
