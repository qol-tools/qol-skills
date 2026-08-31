#!/usr/bin/env node
'use strict';

const { existsSync, readFileSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MIN_QUERY = 4;
const CAP = 3;
const BURST_MS = 15000;
const UNANSWERED = new Set(["no-memory", "candidates"]);
const RECEIPT_RE = /^qolmem-gen.*\.receipt\.json$/;

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

function lanesDir() {
  if (process.env.QOL_SESSIONS_LANES_DIR && process.env.QOL_SESSIONS_LANES_DIR.length) {
    return process.env.QOL_SESSIONS_LANES_DIR;
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "qol-tray", "sessions", "lanes");
  }
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length ? xdg : join(homedir(), ".local", "share");
  return join(base, "qol-tray", "sessions", "lanes");
}

function collectReceipts() {
  let names;
  try {
    names = readdirSync(lanesDir());
  } catch {
    return [];
  }
  const candidates = [];
  for (const name of names) {
    if (!RECEIPT_RE.test(name)) continue;
    const full = join(lanesDir(), name);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;
    candidates.push({ full, mtime: stats.mtimeMs });
  }
  candidates.sort((a, b) => a.mtime - b.mtime);
  const out = [];
  for (const candidate of candidates) {
    const seenPath = candidate.full + ".seen";
    if (existsSync(seenPath)) continue;
    let receipt;
    try {
      receipt = JSON.parse(readFileSync(candidate.full, "utf8"));
    } catch {
      continue;
    }
    const report = typeof receipt.report === "string" ? receipt.report : "";
    let summary = "qolmem: answering lane finished, report: " + report;
    try {
      const matches = [...readFileSync(report, "utf8").matchAll(/^qolmem: .*/gm)];
      if (matches.length) summary = matches[matches.length - 1][0];
    } catch {}
    try {
      writeFileSync(seenPath, "");
    } catch {}
    out.push({ summary, report });
  }
  return out;
}

function normalizeQuery(query) {
  return query.toLowerCase().replace(/\s+/g, " ").trim().replace(/\?+$/, "").trim();
}

function firstToken(norm) {
  return norm.split(" ")[0];
}

function claimsFile() {
  const dir = storeDir();
  return dir ? join(dir, "qolmem-claims.json") : null;
}

function readClaims() {
  const file = claimsFile();
  if (!file) return {};
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function claimQueries(queries) {
  const file = claimsFile();
  if (!file) return;
  const claims = readClaims();
  const now = Date.now();
  for (const query of queries) {
    const norm = normalizeQuery(typeof query === "string" ? query : query?.query ?? "");
    if (norm.length < MIN_QUERY) continue;
    claims[norm] = now;
  }
  const cutoff = now - WINDOW_MS;
  for (const [norm, ts] of Object.entries(claims)) {
    if (!Number.isFinite(ts) || ts < cutoff) delete claims[norm];
  }
  try {
    writeFileSync(file, JSON.stringify(claims) + "\n");
  } catch {}
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
  const claims = Object.entries(readClaims());
  const claimed = (e) => claims.some(([norm, ts]) =>
    ts >= e.ts && (norm === e.norm || norm.startsWith(e.norm) || e.norm.startsWith(norm))
  );
  const entries = [...latest.values()].filter((e) => UNANSWERED.has(e.verdict) && !claimed(e));
  const prefixKept = entries.filter((e) => !entries.some((other) => other.norm.length > e.norm.length && other.norm.startsWith(e.norm)));
  const survived = prefixKept.filter((e) => !prefixKept.some((other) =>
    firstToken(other.norm) === firstToken(e.norm) &&
    Math.abs(other.ts - e.ts) <= BURST_MS &&
    (other.norm.length > e.norm.length || (other.norm.length === e.norm.length && other.ts > e.ts))
  ));
  survived.sort((a, b) => b.ts - a.ts);
  return survived.slice(0, CAP).map((e) => ({ query: e.query, ts: e.ts }));
}

module.exports = { storeDir, unansweredQueue, claimQueries, lanesDir, collectReceipts };
