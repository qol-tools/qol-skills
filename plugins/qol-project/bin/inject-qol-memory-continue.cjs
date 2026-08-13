#!/usr/bin/env node
'use strict';

const { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, renameSync, statSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");
const { gunzipSync } = require("node:zlib");

const SCHEMA = "qol-memory-continue-v1";
const SEAL_SCHEMA = "qol-memory-seal-v1";
const MIN_TEXT = 40;
const MIN_DELTA = 2;
const K = 3;
const CAPS = { user: 2, compaction: 1 };
const BOILERPLATE_MARKERS = [
  "[qol session bridge]",
  "Base directory for this skill:",
  "continued from a previous conversation",
  "Review this change for security vulnerabilities",
];

function memoryStore() {
  if (process.env.QOL_MEMORY_STORE && process.env.QOL_MEMORY_STORE.length) {
    return process.env.QOL_MEMORY_STORE;
  }
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length ? xdg : join(homedir(), ".local", "share");
  return join(base, "qol-tray", "plugins", "qol-memory");
}

const STORE = memoryStore();
const MARKER_PATH = join(STORE, "continue.marker.json");

function fireLog(entry) {
  try {
    mkdirSync(STORE, { recursive: true });
    appendFileSync(join(STORE, "hook.log"), JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  } catch {}
}

function ok(context) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: context,
    },
  }) + "\n");
  process.exit(0);
}

function bail() {
  process.exit(0);
}

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function readMarker() {
  try {
    const marker = JSON.parse(readFileSync(MARKER_PATH, "utf8"));
    if (marker && typeof marker === "object" && marker.schema === SCHEMA && marker.cwds && typeof marker.cwds === "object") {
      return marker;
    }
  } catch {}
  return { schema: SCHEMA, cwds: {} };
}

function writeMarker(marker, cwd, sessionId, unitsCount) {
  const now = new Date().toISOString();
  marker.cwds[cwd] = { ts: now, session: sessionId, units_count: unitsCount, updated: now };
  const tmp = MARKER_PATH + ".tmp";
  writeFileSync(tmp, JSON.stringify(marker, null, 2) + "\n");
  renameSync(tmp, MARKER_PATH);
}

function lineCount(raw) {
  let n = 0;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === 10) n++;
  }
  if (raw.length && raw[raw.length - 1] !== 10) n++;
  return n;
}

function sealedText(raw, entryTsMs) {
  const sealMarkerPath = join(STORE, "units.seal.json");
  const sealBlobPath = join(STORE, "units.seal.gz");
  try {
    if (!existsSync(sealMarkerPath) || !existsSync(sealBlobPath)) return null;
    const m = JSON.parse(readFileSync(sealMarkerPath, "utf8"));
    if (!m || m.schema !== SEAL_SCHEMA) return null;
    if (!Number.isInteger(m.prefix_len) || m.prefix_len < 0 || m.prefix_len > raw.length) return null;
    if (!Number.isInteger(m.blob_len) || statSync(sealBlobPath).size !== m.blob_len) return null;
    if (Number.isFinite(entryTsMs) && entryTsMs >= Date.parse(m.created)) {
      return raw.subarray(m.prefix_len).toString("utf8");
    }
    const prefix = gunzipSync(readFileSync(sealBlobPath));
    if (prefix.length !== m.prefix_len) return null;
    return Buffer.concat([prefix, raw.subarray(m.prefix_len)]).toString("utf8");
  } catch {
    return null;
  }
}

function parseUnits(text) {
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function isBoilerplate(text) {
  return BOILERPLATE_MARKERS.some((m) => text.includes(m));
}

function pickUnits(units, entryTsMs, sessionId) {
  const candidates = units.filter((u) => {
    if (!u || typeof u !== "object") return false;
    if (u.kind !== "user" && u.kind !== "compaction") return false;
    if (typeof u.text !== "string" || u.text.trim().length < MIN_TEXT) return false;
    if (isBoilerplate(u.text)) return false;
    if (u.session && u.session === sessionId) return false;
    const ts = Date.parse(u.ts);
    if (!Number.isFinite(ts)) return false;
    return Number.isFinite(entryTsMs) ? ts > entryTsMs : true;
  });
  candidates.sort((a, b) => {
    const diff = Date.parse(b.ts) - Date.parse(a.ts);
    if (diff !== 0) return diff;
    return String(a.key || "").localeCompare(String(b.key || ""));
  });
  const counts = new Map();
  const picked = [];
  for (const u of candidates) {
    const s = String(u.session || "");
    const c = counts.get(s) || { user: 0, compaction: 0 };
    if (c[u.kind] >= CAPS[u.kind]) continue;
    c[u.kind]++;
    counts.set(s, c);
    picked.push(u);
    if (picked.length >= K) break;
  }
  return picked;
}

function snippet(text) {
  return text.replace(/\s+/g, " ").trim().slice(0, 140);
}

function anchorTs(entry) {
  if (!entry || !entry.ts) return "1970-01-01T00:00:00Z";
  return String(entry.ts).replace(/\.\d{3}Z$/, "Z");
}

function block(picked, entry) {
  const lines = [
    `[qol-memory continue] ${picked.length} unit(s) landed in the store since your last session here (${anchorTs(entry)}):`,
  ];
  for (const u of picked) {
    lines.push(`  NEW ${u.ts} ${u.kind} ${String(u.session || "").slice(0, 8)} ${String(u.key || "").slice(0, 8)} "${snippet(u.text)}"`);
  }
  return lines.join("\n");
}

const raw = readStdin().trim();
if (!raw) bail();

let payload;
try {
  payload = JSON.parse(raw);
} catch {
  bail();
}

const cwd = typeof payload.cwd === "string" && payload.cwd.length ? payload.cwd : "";
const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
const reason = typeof payload.reason === "string" ? payload.reason : "";

if (!cwd || !sessionId) {
  fireLog({ stage: "abstain", reason: "no-cwd" });
  bail();
}

if (process.env.QOL_MEMORY_CONTINUE_DISABLE === "1") {
  fireLog({ stage: "disabled", reason: "env" });
  bail();
}

if (existsSync(join(STORE, "continue.disabled"))) {
  fireLog({ stage: "disabled", reason: "flag-file" });
  bail();
}

const marker = readMarker();
const entry = marker.cwds[cwd] || null;
const entryTsMs = entry ? Date.parse(entry.ts) : NaN;

let rawUnits;
try {
  rawUnits = readFileSync(join(STORE, "units.jsonl"));
} catch {
  fireLog({ stage: "abstain", reason: "read-error" });
  bail();
}

const totalLines = lineCount(rawUnits);

if (entry && totalLines < entry.units_count) {
  try {
    writeMarker(marker, cwd, sessionId, totalLines);
  } catch {}
  fireLog({ stage: "gate-miss", reason: "store-reset" });
  bail();
}

const text = sealedText(rawUnits, entryTsMs) ?? rawUnits.toString("utf8");
const picked = pickUnits(parseUnits(text), entryTsMs, sessionId);

try {
  writeMarker(marker, cwd, sessionId, totalLines);
} catch {
  fireLog({ stage: "abstain", reason: "marker-write-error" });
  bail();
}

if (picked.length >= MIN_DELTA) {
  fireLog({ stage: "injected", count: picked.length, start: reason });
  ok(block(picked, entry));
}

fireLog({ stage: "gate-miss", reason: "below-min-delta", delta: picked.length, start: reason });
bail();
