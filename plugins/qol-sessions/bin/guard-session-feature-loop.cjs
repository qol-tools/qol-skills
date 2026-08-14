'use strict';

const fs = require('node:fs');

const BRIDGE_TOOL_PATTERN = /(?:^|__)session_bridge$/;
const LOOP_CLOSE_TOOL_PATTERN = /(?:^|__)session_loop_close$/;
const COMPLETED_TRUE_PATTERN = /"completed"\s*:\s*true/i;
const COMPLETED_FALSE_PATTERN = /"completed"\s*:\s*false/i;
const COMPLETION_MARKER_PATTERN = /"completion_marker"\s*:/i;
const BACKGROUND_PATTERN = /still running|moved to the background|keeps running/i;

function readPayload() {
    try {
        return JSON.parse(fs.readFileSync(0, 'utf8') || '{}');
    } catch {
        return {};
    }
}

function readEntries(transcriptPath) {
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
    let raw;
    try {
        raw = fs.readFileSync(transcriptPath, 'utf8');
    } catch {
        return [];
    }
    const entries = [];
    for (const line of raw.split(/\r?\n/)) {
        if (!line.trim()) continue;
        try {
            entries.push(JSON.parse(line));
        } catch {}
    }
    return entries;
}

function currentBranch(entries) {
    const nodes = entries.filter(
        (entry) => typeof entry?.uuid === 'string' && entry.uuid && entry.isSidechain !== true,
    );
    const leaf = nodes.at(-1);
    if (!leaf) return [];
    const byId = new Map(nodes.map((entry) => [entry.uuid, entry]));
    const branch = [];
    const seen = new Set();
    let cursor = leaf;
    while (cursor && !seen.has(cursor.uuid)) {
        branch.push(cursor);
        seen.add(cursor.uuid);
        cursor = typeof cursor.parentUuid === 'string' ? byId.get(cursor.parentUuid) : undefined;
    }
    return branch.reverse();
}

function textFromContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((block) => {
            if (!block || typeof block !== 'object') return '';
            if (typeof block.text === 'string') return block.text;
            return textFromContent(block.content);
        })
        .filter(Boolean)
        .join('\n');
}

function entryContent(entry) {
    return entry?.message?.content ?? entry?.content;
}

function entryRole(entry) {
    return entry?.message?.role ?? entry?.role;
}

function bridgeOutcome(text) {
    if (COMPLETED_FALSE_PATTERN.test(text)) return 'paused';
    if (COMPLETED_TRUE_PATTERN.test(text)) return 'review';
    if (BACKGROUND_PATTERN.test(text)) return 'waiting';
    return 'waiting';
}

function closeReceipt(text) {
    try {
        const receipt = JSON.parse(text);
        if (receipt?.loop_closed !== true) return null;
        if (typeof receipt.final_report !== 'string' || !receipt.final_report.trim()) return null;
        return receipt;
    } catch {
        return null;
    }
}

function featureLoopState(entries) {
    let phase = 'idle';
    const bridgeCalls = new Set();
    const closeCalls = new Set();
    for (const entry of currentBranch(entries)) {
        const content = entryContent(entry);
        const blocks = Array.isArray(content) ? content : [];
        if (entryRole(entry) === 'assistant') {
            for (const block of blocks) {
                if (
                    block?.type === 'tool_use'
                    && typeof block.name === 'string'
                    && BRIDGE_TOOL_PATTERN.test(block.name)
                ) {
                    if (typeof block.id === 'string') bridgeCalls.add(block.id);
                    phase = 'waiting';
                }
                if (
                    block?.type === 'tool_use'
                    && typeof block.name === 'string'
                    && LOOP_CLOSE_TOOL_PATTERN.test(block.name)
                    && typeof block.id === 'string'
                ) {
                    closeCalls.add(block.id);
                }
            }
            continue;
        }
        if (entryRole(entry) !== 'user') continue;
        for (const block of blocks) {
            if (block?.type !== 'tool_result') continue;
            const text = textFromContent(block.content);
            if (closeCalls.has(block.tool_use_id)) {
                closeCalls.delete(block.tool_use_id);
                if (!block.is_error && closeReceipt(text)) phase = 'idle';
                continue;
            }
            if (bridgeCalls.has(block.tool_use_id)) {
                bridgeCalls.delete(block.tool_use_id);
                phase = block.is_error ? 'paused' : bridgeOutcome(text);
                continue;
            }
            if (
                phase === 'waiting'
                && COMPLETION_MARKER_PATTERN.test(text)
                && (COMPLETED_TRUE_PATTERN.test(text) || COMPLETED_FALSE_PATTERN.test(text))
            ) {
                phase = bridgeOutcome(text);
            }
        }
    }
    return { phase };
}

function featureLoopPhase(entries) {
    return featureLoopState(entries).phase;
}

function loopState(payload) {
    return featureLoopState(readEntries(payload?.transcript_path));
}

function loopPhase(payload) {
    return loopState(payload).phase;
}

function blockReason(phase) {
    const next = phase === 'waiting'
        ? 'Run `qol sessions next` and invoke exactly the command it prints as one foreground call through the host\'s single blocking continuation. Write no other text. Do not resubmit the task and do not poll.'
        : 'Personally inspect the returned implementation against the user\'s complete acceptance criteria. If anything remains, send the same session one bounded correction round; `qol sessions next` prints the exact command template. The loop ends only when session_loop_close succeeds; prose or a summary cannot close it.';
    return `[qol-sessions feature loop]\n\nThe architect-owned feature loop is still open. ${next}\n\nDo not finish at a round boundary. Only after the entire user feature is accepted, call session_loop_close with the final response session and completion_marker, outcome accepted, landed, before, now, verification, and remaining. If the user redirected the work or a genuine blocker requires user input, call session_loop_close with outcome paused and record the unfinished scope under remaining.`;
}

function main() {
    const payload = readPayload();
    if (payload?.hook_event_name && payload.hook_event_name !== 'Stop') return 0;
    const state = loopState(payload);
    if (!['waiting', 'review'].includes(state.phase)) return 0;
    process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: blockReason(state.phase),
    }));
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
    BRIDGE_TOOL_PATTERN,
    LOOP_CLOSE_TOOL_PATTERN,
    blockReason,
    closeReceipt,
    currentBranch,
    featureLoopState,
    featureLoopPhase,
    loopState,
    loopPhase,
    readEntries,
    textFromContent,
};
