#!/usr/bin/env node
import { rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

async function readSessionId() {
    let raw = "";
    for await (const chunk of process.stdin) raw += chunk;
    try {
        const j = JSON.parse(raw || "{}");
        return j.session_id || j.sessionId || "";
    } catch {
        return "";
    }
}

const sid = await readSessionId();
if (!sid) process.exit(0);

rmSync(join(homedir(), ".claude", "state", `workflow-nodes-${sid}`), { force: true });
