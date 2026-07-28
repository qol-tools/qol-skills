#!/usr/bin/env node
/*
 * PreToolUse hook: force edits to the plugin-alt-tab source through the
 * specialist subagent. Mirrors qol-host's route-to-agent, but scoped to the
 * plugin that declares this id.
 *
 * Scope is resolved from the nearest ancestor `plugin.toml` and its declared
 * `[plugin] id`, never from a directory name: manifests own plugin identity
 * independently of the source directory they sit in.
 *
 * Bypass:
 *   touch .claude/bypass-agent-routing          # single Edit pass
 *   echo N > .claude/bypass-agent-routing       # N Edits pass
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INSPECTED_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit']);
const HOOK_OWNED_SUFFIXES = ['/MEMORY.md', '/.reflect-last.log', '/README.md', '/CHANGELOG.md'];
const SCOPED_TOML_BASENAMES = new Set(['plugin.toml', 'Cargo.toml']);
const SCOPED_SUBDIRS = new Set(['src', 'ui', 'tests']);
const MANIFEST = 'plugin.toml';
const PLUGIN_ID = 'plugin-alt-tab';
const AGENT = 'qol-plugin-alt-tab:plugin-alt-tab';

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function log(msg) {
    process.stderr.write(`[plugin-alt-tab/route-to-agent] ${msg}\n`);
}

function manifestDir(filePath) {
    let dir = path.dirname(path.resolve(filePath));
    for (;;) {
        if (fs.existsSync(path.join(dir, MANIFEST))) return dir;
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        dir = parent;
    }
}

function declaredId(manifestPath) {
    let raw;
    try {
        raw = fs.readFileSync(manifestPath, 'utf8');
    } catch {
        return null;
    }
    let inPluginSection = false;
    for (const line of raw.split(/\r?\n/)) {
        const header = line.match(/^\s*\[([^\]]+)\]/);
        if (header) {
            inPluginSection = header[1].trim() === 'plugin';
            continue;
        }
        if (!inPluginSection) continue;
        const declared = line.match(/^\s*id\s*=\s*["']([^"']+)["']/);
        if (declared) return declared[1];
    }
    return null;
}

function inScope(filePath) {
    const root = manifestDir(filePath);
    if (!root) return false;
    if (declaredId(path.join(root, MANIFEST)) !== PLUGIN_ID) return false;
    const rel = path.relative(root, path.resolve(filePath));
    if (!rel || rel.startsWith('..')) return false;
    if (SCOPED_TOML_BASENAMES.has(path.basename(rel))) return true;
    return SCOPED_SUBDIRS.has(rel.split(path.sep)[0]);
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
    process.stderr.write(`Edit to ${filePath} is blocked: plugin-alt-tab scope must route through its specialist agent.

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
    if (!filePath) return 0;
    if (!inScope(filePath)) return 0;
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
