#!/usr/bin/env node
/*
 * PreToolUse hook: force edits to qol-tray frontend/backend scope through
 * the specialized qol-tray-frontend / qol-tray-backend subagents.
 * Main-Claude edits are blocked with exit 2; the error message tells Claude
 * which agent to route through and how to bypass explicitly if the edit is
 * genuinely trivial.
 *
 * Bypass (Claude-side, deliberate):
 *   touch .claude/bypass-agent-routing          # single Edit pass
 *   echo N > .claude/bypass-agent-routing       # N Edits pass, auto-cleaned
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INSPECTED_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const HOOK_OWNED_SUFFIXES = ['/MEMORY.md', '/.reflect-last.log'];

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function log(msg) {
    process.stderr.write(`[route-to-agent] ${msg}\n`);
}

function classifyAgent(filePath) {
    if (
        filePath.includes('/qol-tray/ui/views/') ||
        filePath.includes('/qol-tray/ui/components/') ||
        filePath.includes('/qol-tray/ui/lib/') ||
        filePath.includes('/qol-tray/ui/app/') ||
        filePath.includes('/qol-tray/ui/palette/') ||
        filePath.includes('/qol-tray/ui/hooks/') ||
        filePath.includes('/qol-tray/ui/styles/')
    ) {
        return 'qol-host:qol-tray-frontend';
    }
    if (filePath.includes('/qol-tray/src/')) {
        return 'qol-host:qol-tray-backend';
    }
    return null;
}

function consumeBypass(marker) {
    if (!fs.existsSync(marker) || !fs.statSync(marker).isFile()) return false;
    try {
        const raw = fs.readFileSync(marker, 'utf8').trim();
        const count = /^\d+$/.test(raw) ? Number(raw) : 1;
        if (count > 1) {
            fs.writeFileSync(marker, String(count - 1));
            log(`bypass consumed (${count - 1} remaining)`);
        } else {
            fs.unlinkSync(marker);
            log('bypass consumed (marker removed)');
        }
    } catch {
        // ignore
    }
    return true;
}

function emitBlockMessage(filePath, agent, marker, cwd) {
    const rel = marker.startsWith(cwd + '/') ? marker.slice(cwd.length + 1) : marker;
    process.stderr.write(`Edit to ${filePath} is blocked: qol-tray frontend/backend scope must route through the specialized agent.

Invoke the agent via:
  Agent(subagent_type="${agent}", prompt="...")

To bypass for this change (Claude-side, deliberate):
  Bash("touch ${rel}")                    # single Edit pass
  Bash("echo 3 > ${rel}")                 # N Edits pass

The marker is auto-consumed per Edit; no cleanup needed.
`);
}

function main() {
    const raw = readStdin().trim();
    if (!raw) return 0;

    let payload;
    try {
        payload = JSON.parse(raw);
    } catch {
        return 0;
    }

    const tool = payload.tool_name || payload.tool || '';
    if (!INSPECTED_TOOLS.has(tool)) return 0;

    if (payload.agent_type) return 0;

    const input = payload.tool_input || {};
    const filePath = input.file_path || input.notebook_path || '';
    if (!filePath) return 0;

    const agent = classifyAgent(filePath);
    if (!agent) return 0;

    if (HOOK_OWNED_SUFFIXES.some(s => filePath.endsWith(s))) return 0;

    const cwd = payload.cwd || process.cwd();
    const marker = path.join(cwd, '.claude', 'bypass-agent-routing');

    if (consumeBypass(marker)) return 0;

    emitBlockMessage(filePath, agent, marker, cwd);
    return 2;
}

module.exports = { classifyAgent, consumeBypass };

if (require.main === module) {
    process.exit(main());
}
