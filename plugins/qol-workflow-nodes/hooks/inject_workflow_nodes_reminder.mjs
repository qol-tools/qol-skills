#!/usr/bin/env node
import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const REMINDER = [
    "[workflow-nodes - this session]",
    "When work repeats or spans fragile steps, look for an input -> output workflow node before doing manual tool chains.",
    "Prefer one human command, argv-safe Node orchestration, domain leaf scripts, and report.json artifacts that another script or agent can consume.",
    "Do not pause useful work just to abstract. Extract the workflow when it removes repeated human or AI effort.",
].join(" ");

async function readPayload() {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    try {
        return JSON.parse(raw || "{}");
    } catch {
        return {};
    }
}

function emitReminder() {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext: REMINDER,
        },
    }));
}

const payload = await readPayload();
if (payload?.hook_event_name && payload.hook_event_name !== "UserPromptSubmit") {
    process.exit(0);
}

const sid = payload.session_id || payload.sessionId || "";
if (!sid) {
    emitReminder();
    process.exit(0);
}

const stateDir = join(homedir(), ".claude", "state");
const sentinel = join(stateDir, "workflow-nodes-" + sid);
if (existsSync(sentinel)) process.exit(0);

mkdirSync(stateDir, { recursive: true });
writeFileSync(sentinel, "");
emitReminder();

export { REMINDER, emitReminder };
