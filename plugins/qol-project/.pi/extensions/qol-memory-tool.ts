import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { spawnSync } from "node:child_process";
import { join, basename } from "node:path";
import { appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";

function memoryStore(): string {
  if (process.env.QOL_MEMORY_STORE && process.env.QOL_MEMORY_STORE.length) return process.env.QOL_MEMORY_STORE;
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.length ? xdg : join(process.env.HOME || "", ".local", "share");
  return join(base, "qol-tray", "plugins", "qol-memory");
}

const UNITS_PATH = join(memoryStore(), "units.jsonl");
const CAPTURE_DISABLED = process.env.QOL_MEMORY_LIVE_CAPTURE_DISABLE === "1";

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

function appendUnit(ctx: any, kind: "user" | "compaction", ts: string, text: string, files?: string[]) {
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
  });

  pi.registerTool({
    name: "qol_memory_retrieve",
    label: "QoL Memory Retrieve",
    description:
      "Retrieve past-work memory: what we decided, how we fixed things, corpus facts. Ask when the user references past sessions, decisions, or fixes you don't remember. Returns a verdict (answered/candidates/no-memory) with provenance. This is a recall tool - the answer is a fact from past transcripts, not a suggestion.",
    parameters: Type.Object({
      query: Type.String({ description: "What to recall, e.g. 'how did we fix the m4a1 anchoring'" }),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const store = memoryStore();
      const manifest = join(store, "manifest.json");
      let askPath = "";
      try {
        const m = JSON.parse(readFileSync(manifest, "utf8"));
        if (m && m.ask_mjs) askPath = m.ask_mjs;
      } catch {}
      if (!askPath && process.env.QOL_MEMORY_ASK) askPath = process.env.QOL_MEMORY_ASK;
      if (!askPath) {
        return { content: [{ type: "text", text: "memory unavailable: no qol-memory manifest at " + manifest }], details: {} };
      }
      const args = [askPath, String(params.query || ""), "--brief"];
      const sid = ctx.sessionManager.getSessionId();
      if (sid) args.push("--exclude-session", sid);
      try { appendFileSync("/tmp/qol-memory-tool-calls.log", new Date().toISOString() + " TOOL " + JSON.stringify(args) + "\n"); } catch {}
      const r = spawnSync("node", args, {
        encoding: "utf8", timeout: 6000,
      });
      if (r.status !== 0 || !r.stdout) {
        return { content: [{ type: "text", text: "memory error: ask.mjs failed" }], details: {} };
      }
      let d;
      try { d = JSON.parse(r.stdout); } catch {
        return { content: [{ type: "text", text: "memory error: bad ask.mjs output" }], details: {} };
      }
      const lines: string[] = [];
      if (d.verdict === "answered" && d.answer) {
        const a = d.answer;
        const text = a.text || "";
        const cap = a.source_kind === "decision" ? 280 : 240;
        const truncated = text.length >= cap && !/[.!?\u2026"]\s*$/.test(text.trim());
        lines.push(`VERDICT: answered (${d.confidence})${truncated ? " - FACT IS TRUNCATED, retrieve again for the full note" : ""}`);
        lines.push(`FACT: ${text}${truncated ? " [truncated]" : ""}`);
        lines.push(`PROVENANCE: key ${a.key}, ${a.source_kind}, ${a.source_ts || "?"}`);
        if (a.superseded && a.superseded.length) {
          lines.push(`SUPERSEDES: ${a.superseded.map((s: any) => s.text).join(" | ")}`);
        }
      } else if (d.verdict === "candidates") {
        lines.push(`VERDICT: candidates (${d.confidence}) - no decisive fact, hints only`);
        for (const c of (d.recalled || []).slice(0, 3)) {
          lines.push(`HINT: key ${c.key}, ${c.source_kind}, ${c.source_ts || "?"}`);
        }
      } else {
        lines.push(`VERDICT: no-memory - nothing in the corpus answers this. Be honest about not knowing.`);
      }
      if (d.non_default_gates) lines.push("WARNING: non-default gates applied");
      return { content: [{ type: "text", text: lines.join("\n") }], details: {} };
    },
  });
}
