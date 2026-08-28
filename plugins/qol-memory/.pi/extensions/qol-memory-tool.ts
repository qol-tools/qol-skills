import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { join, basename, dirname } from "node:path";
import { appendFileSync, readFileSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { postJson } = require("../../bin/qol-tray-http.cjs");

function memoryStore(): string {
  if (process.env.QOL_MEMORY_STORE && process.env.QOL_MEMORY_STORE.length) return process.env.QOL_MEMORY_STORE;
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length ? xdg : join(process.env.HOME || "", ".local", "share");
  return join(base, "qol-tray", "plugins", "qol-memory");
}

const UNITS_PATH = join(memoryStore(), "units.jsonl");
const CAPTURE_DISABLED = process.env.QOL_MEMORY_LIVE_CAPTURE_DISABLE === "1";
const DISTILL_DEBOUNCE_MS = 15 * 60 * 1000;
const DISTILL_LOG = "/tmp/qol-memory-distill.log";
const distillDebounce = new Map<string, number>();

function distillPath(): string {
  const store = memoryStore();
  const manifest = join(store, "manifest.json");
  try {
    const m = JSON.parse(readFileSync(manifest, "utf8"));
    if (m && m.ask_mjs) return join(dirname(m.ask_mjs), "decisions.mjs");
  } catch {}
  if (process.env.QOL_MEMORY_DISTILL && process.env.QOL_MEMORY_DISTILL.length) return process.env.QOL_MEMORY_DISTILL;
  return "";
}

function spawnDistill(args: string[]) {
  const dp = distillPath();
  const stamp = new Date().toISOString();
  if (!dp) {
    try { appendFileSync(DISTILL_LOG, stamp + " SKIP no distillPath (" + args.join(" ") + ")\n"); } catch {}
    return;
  }
  try { appendFileSync(DISTILL_LOG, stamp + " SPAWN " + args.join(" ") + "\n"); } catch {}
  const child = spawn("node", [dp, ...args], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, QOL_MEMORY_LIVE_CAPTURE_DISABLE: "1" },
  });
  child.unref();
}

function unitKey(source: string, file: string, ts: string, text: string): string {
  return createHash("sha256").update([source, file, ts, text].join("|")).digest("hex").slice(0, 16);
}

function textOf(content: any): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => b && b.type === "text" && typeof b.text === "string")
    .map((b) => b.text)
    .join("\n");
}

function redact(text: string): string {
  if (typeof text !== "string" || !text) return text;
  return text
    .replace(/\b[A-Za-z0-9_\-]{32,}\b/g, "[REDACTED]")
    .replace(/(?:Bearer|Token|api[_-]?key|password|passwd|secret|private[_-]?key)\s*[:=]\s*[\S]+/gi, "$1=[REDACTED]")
    .replace(/sk-[A-Za-z0-9]{20,}/g, "[REDACTED-KEY]")
    .replace(/-----BEGIN[\s\S]*?END [A-Z ]*-----/g, "[REDACTED-PEM]")
    .replace(/([\w.+-]+@[\w.-]+\.\w{2,})/g, "[EMAIL]")
    .replace(/\.env[\s\S]*/g, ".env [REDACTED]");
}

async function appendUnit(ctx: any, kind: "user" | "compaction", ts: string, text: string, files?: string[]) {
  if (CAPTURE_DISABLED) return;
  const sessionFile = ctx.sessionManager.getSessionFile() ?? null;
  const file = sessionFile ? basename(sessionFile) : null;
  const key = unitKey("pi", file ?? "", ts, text);
  const unit: any = { key, source: "pi", file, session: ctx.sessionManager.getSessionId(), cwd: ctx.sessionManager.getCwd(), kind, ts, text };
  if (files) {
    unit.filesRead = files;
    unit.filesModified = files;
  }
  try {
    const result = await postJson("/api/plugins/qol-memory/actions/capture", { unit }, 2000);
    if (result && result.status >= 200 && result.status < 300) return;
  } catch {}
  try {
    mkdirSync(memoryStore(), { recursive: true });
    appendFileSync(UNITS_PATH, JSON.stringify(unit) + "\n");
  } catch {}
}

export default function (pi: ExtensionAPI) {
  pi.on("message_end", async (event: any, ctx: any) => {
    const msg = event.message;
    if (!msg || msg.role !== "user") return;
    const text = redact(textOf(msg.content));
    if (!text.trim()) return;
    const ts = typeof msg.timestamp === "number" ? new Date(msg.timestamp).toISOString() : new Date().toISOString();
    appendUnit(ctx, "user", ts, text);
  });

  pi.on("session_compact", async (event: any, ctx: any) => {
    const e = event.compactionEntry;
    if (!e) return;
    appendUnit(ctx, "compaction", new Date(e.timestamp).toISOString(), redact(e.summary || ""), []);
    const sid = ctx.sessionManager.getSessionId() as string;
    const now = Date.now();
    if (sid && now - (distillDebounce.get(sid) || 0) > DISTILL_DEBOUNCE_MS) {
      distillDebounce.set(sid, now);
      setImmediate(() => spawnDistill(["--session", sid, "--live"]));
    }
  });

  const catchallMarker = join(memoryStore(), ".distill-catchall.ts");
  try {
    const prev = existsSync(catchallMarker) ? readFileSync(catchallMarker, "utf8") : "";
    const prevTs = Date.parse(prev) || 0;
    if (Date.now() - prevTs > 12 * 60 * 60 * 1000) {
      writeFileSync(catchallMarker, new Date().toISOString());
      setImmediate(() => spawnDistill(["--live"]));
    }
  } catch {}
}
