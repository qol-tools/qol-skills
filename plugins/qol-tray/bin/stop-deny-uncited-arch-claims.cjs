#!/usr/bin/env node
/*
 * Stop hook: block when the assistant's last message makes an
 * architectural verdict about testability or "needs a refactor" but does
 * not cite path:line evidence for the claim.
 *
 * Encodes the qol-apps-testing skill rule "Before claiming a seam is
 * missing" so that future sessions cannot ship a vibes-based "this
 * isn't testable" verdict without doing the survey first.
 *
 * Filters to cwds under qol-tools/ so unrelated projects are unaffected.
 *
 * Bypass when the verdict is intentional and prose-only:
 *   touch .claude/bypass-seam-claim
 *   echo 3 > .claude/bypass-seam-claim   # next 3 stops pass
 *
 * Silent on errors. A failing hook must never wedge a session.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const QOL_TOOLS_RE = /[\\/]qol-tools[\\/]/;

const TRIGGER_PATTERNS = [
    /\btestability\s+wall\b/i,
    /\bisn'?t\s+(?:e2e[-\s]+)?testable\b/i,
    /\b(?:is|are)\s+not\s+(?:e2e[-\s]+)?testable\b/i,
    /\buntestable\b/i,
    /\bseam\s+(?:doesn'?t|does\s+not|isn'?t|is\s+not)\s+(?:exist|there|present)\b/i,
    /\bno\s+(?:test[-\s]+)?seam\b/i,
    /\bneeds?\s+(?:a\s+|the\s+)?refactor\s+(?:before|first)\b/i,
    /\bneeds?\s+(?:a\s+)?config[_\s-]?root\s+(?:refactor|injection)\b/i,
    /\bwould\s+need\s+to\s+inject\b/i,
    /\bcoupled\s+to\s+(?:the\s+)?global\s+paths?\b/i,
];

const CITATION_RE = /\b[\w./-]+\.(?:rs|ts|tsx|js|jsx|py|go|md|cjs|mjs|json|toml|yaml|yml|sh|h|c|cpp|hpp|rb|java|kt|swift|html|css|sql|lua)\s*:\s*\d+/i;

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function readLastAssistantMessage(transcriptPath) {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
    let raw;
    try {
        raw = fs.readFileSync(transcriptPath, 'utf8');
    } catch {
        return '';
    }
    const lines = raw.trim().split(/\n+/);
    for (let i = lines.length - 1; i >= 0; i--) {
        let parsed;
        try {
            parsed = JSON.parse(lines[i]);
        } catch {
            continue;
        }
        const role = parsed?.message?.role || parsed?.role;
        if (role !== 'assistant') continue;
        const content = parsed?.message?.content ?? parsed?.content;
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) {
            return content
                .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
                .map((block) => block.text)
                .join('\n');
        }
    }
    return '';
}

function textFromContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
}

function lastAssistantText(payload) {
    const direct = textFromContent(payload?.last_assistant_message);
    if (direct) return direct;
    return readLastAssistantMessage(payload?.transcript_path);
}

function findTriggers(text) {
    if (typeof text !== 'string' || text.length === 0) return [];
    return TRIGGER_PATTERNS.filter((re) => re.test(text));
}

function hasCitation(text) {
    if (typeof text !== 'string' || text.length === 0) return false;
    return CITATION_RE.test(text);
}

function consumeBypass(cwd) {
    const marker = path.join(cwd, '.claude', 'bypass-seam-claim');
    if (!fs.existsSync(marker)) return false;
    try {
        if (!fs.statSync(marker).isFile()) return false;
    } catch {
        return false;
    }
    try {
        const raw = fs.readFileSync(marker, 'utf8').trim();
        const count = /^\d+$/.test(raw) ? Number(raw) : 1;
        if (count > 1) {
            fs.writeFileSync(marker, String(count - 1));
        } else {
            fs.unlinkSync(marker);
        }
    } catch {
        // never block on bypass IO failure
    }
    return true;
}

function blockReason(triggers) {
    const list = triggers.map((re) => `  ${re.source}`).join('\n');
    return `Stop blocked by qol-tray:stop-deny-uncited-arch-claims.

Your message contains an architectural verdict about testability or
refactoring, but cites no path:line evidence.

Triggers matched:
${list}

The qol-apps-testing skill section "Before claiming a seam is missing"
requires path:line citations for verdicts like "untestable", "needs
refactor", "the seam doesn't exist". Without a citation, the verdict is
a guess.

Re-survey first:

  grep -rn "test_path_root\\|push_test_path_root\\|TEST_.*ENV\\|cfg(test)" src/
  grep -rn "QOL_.*TEST\\|_TEST_PATH" src/

Read paths.rs (or the equivalent path-resolution module) end-to-end.
Functions with no path parameter often resolve through a cfg-gated
override and look hardcoded only at first glance.

If a seam genuinely is missing, quote path:line in your reply. If you
find one, retract the verdict.

Bypass when the verdict is intentional and prose-only:
  touch .claude/bypass-seam-claim`;
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

    const cwd = payload.cwd || payload.project_dir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
    if (!QOL_TOOLS_RE.test(cwd)) return 0;

    if (payload.stop_hook_active) return 0;

    if (consumeBypass(cwd)) return 0;

    const text = lastAssistantText(payload);
    if (!text) return 0;

    const triggers = findTriggers(text);
    if (triggers.length === 0) return 0;

    if (hasCitation(text)) return 0;

    process.stdout.write(
        JSON.stringify({
            decision: 'block',
            reason: blockReason(triggers),
        }),
    );
    return 0;
}

if (require.main === module) {
    try {
        process.exit(main());
    } catch {
        process.exit(0);
    }
}

module.exports = {
    TRIGGER_PATTERNS,
    CITATION_RE,
    findTriggers,
    hasCitation,
    consumeBypass,
    blockReason,
    readLastAssistantMessage,
    textFromContent,
    lastAssistantText,
};
