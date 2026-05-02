#!/usr/bin/env node
/*
 * PreToolUse hook: force edits inside the plugin-lights repo through the
 * specialist subagent. Mirrors qol-host's route-to-agent, but scoped to
 * plugin-lights paths only.
 *
 * Bypass:
 *   touch .claude/bypass-agent-routing
 *   echo N > .claude/bypass-agent-routing
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INSPECTED_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const HOOK_OWNED_SUFFIXES = ['/MEMORY.md', '/.reflect-last.log', '/README.md', '/CHANGELOG.md'];
const SCOPED_TOML_BASENAMES = new Set(['plugin.toml', 'qol-config.toml', 'qol-runtime.toml', 'Cargo.toml']);
const AGENT = 'qol-plugin-lights:plugin-lights';

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function log(msg) {
    process.stderr.write(`[plugin-lights/route-to-agent] ${msg}\n`);
}

function inScope(filePath) {
    if (!filePath.includes('/plugin-lights/')) return false;
    if (filePath.includes('/plugin-lights/src/')) return true;
    if (filePath.includes('/plugin-lights/ui/')) return true;
    if (filePath.includes('/plugin-lights/tests/')) return true;
    return SCOPED_TOML_BASENAMES.has(path.basename(filePath));
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

function emitBlockMessage(filePath, marker, cwd) {
    const rel = marker.startsWith(cwd + '/') ? marker.slice(cwd.length + 1) : marker;
    process.stderr.write(`Edit to ${filePath} is blocked: plugin-lights scope must route through its specialist agent.

Invoke via:
  Agent(subagent_type="${AGENT}", prompt="...")

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
    if (!filePath || !inScope(filePath)) return 0;
    if (HOOK_OWNED_SUFFIXES.some(s => filePath.endsWith(s))) return 0;

    const cwd = payload.cwd || process.cwd();
    const marker = path.join(cwd, '.claude', 'bypass-agent-routing');
    if (consumeBypass(marker)) return 0;

    emitBlockMessage(filePath, marker, cwd);
    return 2;
}

module.exports = { inScope, consumeBypass, AGENT };

if (require.main === module) {
    process.exit(main());
}
