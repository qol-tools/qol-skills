#!/usr/bin/env node
const { readFileSync } = require("node:fs");

const QOL_PATH_COMPONENT = /(^|[\\/])qol-[^\\/]+([\\/]|$)/;
const TRIGGERS = /\b(feature|scope|design|issue|should qol-tray|follow-up|out of scope|roadmap|rfc|adr)\b/i;
const MIN_LEN = 8;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

function ok(extra) {
  if (extra) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: extra,
      },
    }));
  }
  process.exit(0);
}

const raw = readStdin().trim();
if (!raw) ok();

let payload;
try { payload = JSON.parse(raw); } catch { ok(); }

const cwd = payload.cwd || process.cwd();
if (!QOL_PATH_COMPONENT.test(cwd)) ok();

const prompt = (payload.prompt || "").trim();
if (prompt.length < MIN_LEN) ok();
if (!TRIGGERS.test(prompt)) ok();

ok("[qol-mission reminder] This prompt mentions design/scope/issue terms in a qol-tools repo. Invoke the qol-project:qol-mission skill BEFORE answering. Mission invariants (vision: portable cross-OS injection; non-negotiables: user never configures host OS, qol-tray owns its surface, host left as found, plug-in to working in seconds, self-contained, failures visible) override convenience. If you're scoping a feature, check it against these.");
