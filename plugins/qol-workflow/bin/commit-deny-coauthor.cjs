#!/usr/bin/env node
/*
 * PreToolUse hook (Bash matcher): block any `git commit` whose message
 * contains AI attribution (Co-Authored-By: Claude, "Generated with Claude
 * Code", etc.).
 *
 * Fuzzy patterns are intentionally aggressive — false positives are cheap
 * (re-write the message), false negatives are the real failure mode.
 *
 * Scans:
 *   - the bash command itself (catches -m "..." and HEREDOCs inline)
 *   - the file referenced by -F / --file (if present and readable)
 */

'use strict';

const fs = require('node:fs');

const COMMIT_INVOCATION = /(^|[\s;&|`])git\s+([a-z-]+\s+)*commit(\s|$)/;

const ATTRIBUTION_PATTERNS = [
    /co[\s_-]*authored?[\s_-]*by/i,
    /noreply@anthropic/i,
    /generated\s+with\s+\[?claude/i,
    /\u{1F916}\s*generated/iu, // 🤖 generated
    /claude\s+(opus|sonnet|haiku|code)\s+\d/i,
    /<[^>]*@anthropic\.com>/i,
];

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function extractFileArg(cmd) {
    const match = cmd.match(/(?:^|\s)(?:-F|--file)(?:=|\s)(\S+)/);
    return match ? match[1] : null;
}

function buildHaystack(cmd) {
    const fileArg = extractFileArg(cmd);
    if (fileArg && fs.existsSync(fileArg) && fs.statSync(fileArg).isFile()) {
        try {
            return cmd + '\n' + fs.readFileSync(fileArg, 'utf8');
        } catch {
            // fall through
        }
    }
    return cmd;
}

function findOffendingPattern(haystack) {
    for (const pattern of ATTRIBUTION_PATTERNS) {
        if (pattern.test(haystack)) return pattern;
    }
    return null;
}

function emitBlockMessage() {
    process.stderr.write(
        `git commit BLOCKED by qol-host:commit-deny-coauthor hook.

The commit message contains AI / Claude / Anthropic attribution
(Co-Authored-By, "Generated with Claude Code", noreply@anthropic.com,
\u{1F916} Generated, etc.).

qol-tools rule (plugin:qol-host:commit skill):
  NEVER add Co-Authored-By or any Anthropic attribution to commits.
  This has been stated repeatedly by the author. It is not negotiable.

Re-attempt the commit with a clean message — subject + optional body only.
No trailers. No emoji-attribution footer.
`,
    );
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
    if (tool !== 'Bash') return 0;

    const cmd = (payload.tool_input && payload.tool_input.command) || '';
    if (!cmd) return 0;
    if (!COMMIT_INVOCATION.test(cmd)) return 0;

    const haystack = buildHaystack(cmd);
    if (findOffendingPattern(haystack)) {
        emitBlockMessage();
        return 2;
    }
    return 0;
}

module.exports = {
    COMMIT_INVOCATION,
    ATTRIBUTION_PATTERNS,
    findOffendingPattern,
    extractFileArg,
};

if (require.main === module) {
    process.exit(main());
}
