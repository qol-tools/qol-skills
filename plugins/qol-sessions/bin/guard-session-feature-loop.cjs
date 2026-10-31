'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BRIDGE_TOOL_PATTERN = /(?:^|__)session_bridge$/;
const LOOP_CLOSE_TOOL_PATTERN = /(?:^|__)session_loop_close$/;
const COMPLETED_TRUE_PATTERN = /"completed"\s*:\s*true/i;
const COMPLETED_FALSE_PATTERN = /"completed"\s*:\s*false/i;
const COMPLETION_MARKER_PATTERN = /"completion_marker"\s*:/i;
const LOOP_CLOSED_TRUE_PATTERN = /loop_closed\\?"?\s*:\s*true/i;
const LOOP_ARMED_TRUE_PATTERN = /loop_armed\\?"?\s*:\s*true/i;
const FINAL_REPORT_PATTERN = /final_report\\?"?\s*:/i;
const BASH_TOOL_PATTERN = /^bash$/i;
const BASH_BACKGROUND_PATTERN = /running in background|moved to the background|keeps running/i;
const TASK_NOTIFICATION_PATTERN = /<task-notification>/i;
const BACKGROUND_PATTERN = /still running|moved to the background|keeps running/i;
const EXIT_PREFIX_PATTERN = /^\s*Exit code (\d+)/;
const PRETTY_ARMED_PATTERN = /^loop\s+(\S+)\s+armed\b/m;
const PRETTY_CLOSED_PATTERN = /^loop\s+(\S+)\s+closed\s+(?:accepted|paused)\b/m;
const RUN_STATE_EXITS = { needs_trust: 11, question: 13, handover: 14, escalation: 12 };
const USER_BOUNDARY_EXITS = new Set([11, 13, 14]);
const ESCALATION_EXIT = 12;

const STORE_DIRS = [
    () => path.join(os.homedir(), 'Library', 'Application Support', 'qol-tray', 'sessions', 'pending-bridge'),
    () => path.join(os.homedir(), '.local', 'share', 'qol-tray', 'sessions', 'pending-bridge'),
    () => path.join(os.homedir(), '.config', 'qol-tray', 'sessions', 'pending-bridge'),
];
const CHECKPOINT_SIZE_CAP = 64 * 1024;

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
        return LOOP_CLOSED_TRUE_PATTERN.test(text) ? { loop_closed: true } : null;
    }
}

function jsonObjects(text) {
    const candidates = [String(text).trim()];
    for (const line of String(text).split(/\r?\n/)) {
        const trimmed = line.trim();
        if (trimmed.startsWith('{')) candidates.push(trimmed);
    }
    const first = String(text).indexOf('{');
    const last = String(text).lastIndexOf('}');
    if (first >= 0 && last > first) candidates.push(String(text).slice(first, last + 1));
    const objects = [];
    for (const candidate of candidates) {
        try {
            const parsed = JSON.parse(candidate);
            if (parsed && typeof parsed === 'object') objects.push(parsed);
        } catch {}
    }
    return objects;
}

function hasReport(report) {
    if (typeof report === 'string') return report.trim().length > 0;
    return report !== null && typeof report === 'object' && Object.keys(report).length > 0;
}

const DRIVER_VERB_PATTERNS = {
    open: /^\s*(?:\w+=\S*\s+)*(?:(?:\S*\/)?qols\s+loop|(?:node\s+)?\S*loop\.mjs)\s+open(?:\s|$)/,
    close: /^\s*(?:\w+=\S*\s+)*(?:(?:\S*\/)?qols\s+loop|(?:node\s+)?\S*loop\.mjs)\s+close(?:\s|$)/,
    run: /^\s*(?:\w+=\S*\s+)*(?:(?:\S*\/)?qols\s+loop|(?:node\s+)?\S*loop\.mjs)\s+run(?:\s|$)/,
};
const DRIVER_KEY_PATTERN = /(?:qols\s+loop|loop\.mjs)\s+(?:open|close|run)\s+([^\s-]\S*)/;

function driverCommandKey(command, verb) {
    if (typeof command !== 'string' || !DRIVER_VERB_PATTERNS[verb]) return null;
    const segment = command.split(/&&|\|\||;|\||\r?\n/).find((part) => DRIVER_VERB_PATTERNS[verb].test(part));
    const match = segment ? DRIVER_KEY_PATTERN.exec(segment) : null;
    return match ? match[1] : null;
}

function bashExit(text) {
    const prefixed = EXIT_PREFIX_PATTERN.exec(String(text));
    if (prefixed) return Number(prefixed[1]);
    for (const object of jsonObjects(text)) {
        const state = object?.state ?? object?.result?.state;
        if (Object.hasOwn(RUN_STATE_EXITS, state)) return RUN_STATE_EXITS[state];
    }
    return null;
}

function runsDriverVerb(command, verb) {
    if (typeof command !== 'string' || !DRIVER_VERB_PATTERNS[verb]) return false;
    return command.split(/&&|\|\||;|\||\r?\n/).some((segment) => DRIVER_VERB_PATTERNS[verb].test(segment));
}

function driverArmReceipt(text) {
    if (jsonObjects(text).some((object) => object.loop_armed === true)) return true;
    return LOOP_ARMED_TRUE_PATTERN.test(text) || PRETTY_ARMED_PATTERN.test(text);
}

function driverCloseReceipt(text) {
    const objects = jsonObjects(text);
    if (objects.some((object) => object.loop_closed === true && hasReport(object.final_report))) return true;
    if (objects.length) return false;
    return (LOOP_CLOSED_TRUE_PATTERN.test(text) && FINAL_REPORT_PATTERN.test(text)) || PRETTY_CLOSED_PATTERN.test(text);
}

function receiptKey(text, command, verb) {
    for (const object of jsonObjects(text)) {
        const key = object?.final_report?.key ?? object?.key;
        if (typeof key === 'string' && key) return key;
    }
    const pretty = (verb === 'open' ? PRETTY_ARMED_PATTERN : PRETTY_CLOSED_PATTERN).exec(text);
    if (pretty) return pretty[1];
    return driverCommandKey(command, verb);
}

function userText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n');
}

function featureLoopState(entries) {
    let phase = 'idle';
    let armed = false;
    let closed = false;
    let escalated = false;
    const driverKeys = new Set();
    const bridgeCalls = new Set();
    const closeCalls = new Set();
    const bashCalls = new Map();
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
                    armed = true;
                    closed = false;
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
                if (
                    block?.type === 'tool_use'
                    && typeof block.name === 'string'
                    && BASH_TOOL_PATTERN.test(block.name)
                    && typeof block.id === 'string'
                ) {
                    bashCalls.set(block.id, block.input && typeof block.input === 'object' ? block.input : {});
                }
            }
            continue;
        }
        if (entryRole(entry) !== 'user') continue;
        if (driverKeys.size > 0 && phase === 'waiting' && TASK_NOTIFICATION_PATTERN.test(userText(content))) {
            phase = 'review';
        }
        for (const block of blocks) {
            if (block?.type !== 'tool_result') continue;
            const text = textFromContent(block.content);
            if (closeCalls.has(block.tool_use_id)) {
                closeCalls.delete(block.tool_use_id);
                if (!block.is_error && closeReceipt(text)) {
                    closed = true;
                    phase = 'idle';
                }
                continue;
            }
            if (bridgeCalls.has(block.tool_use_id)) {
                bridgeCalls.delete(block.tool_use_id);
                armed = true;
                closed = false;
                phase = block.is_error ? 'paused' : bridgeOutcome(text);
                continue;
            }
            if (bashCalls.has(block.tool_use_id)) {
                const input = bashCalls.get(block.tool_use_id);
                bashCalls.delete(block.tool_use_id);
                if (!block.is_error && runsDriverVerb(input.command, 'close') && driverCloseReceipt(text)) {
                    const key = receiptKey(text, input.command, 'close');
                    if (key === null) driverKeys.clear();
                    else driverKeys.delete(key);
                    escalated = false;
                    if (driverKeys.size === 0) {
                        closed = true;
                        phase = 'idle';
                    } else {
                        phase = 'review';
                    }
                    continue;
                }
                if (!block.is_error && runsDriverVerb(input.command, 'open') && driverArmReceipt(text)) {
                    driverKeys.add(receiptKey(text, input.command, 'open') ?? '?');
                    armed = true;
                    closed = false;
                    escalated = false;
                    phase = 'review';
                    continue;
                }
                if (driverKeys.size > 0 && runsDriverVerb(input.command, 'run')) {
                    const exit = bashExit(text);
                    if (!block.is_error && (input.run_in_background === true || BASH_BACKGROUND_PATTERN.test(text))) {
                        phase = 'waiting';
                    } else if (USER_BOUNDARY_EXITS.has(exit)) {
                        phase = 'user';
                        escalated = false;
                    } else {
                        phase = 'review';
                        escalated = exit === ESCALATION_EXIT;
                    }
                    continue;
                }
                if (driverKeys.size > 0 && !block.is_error && (input.run_in_background === true || BASH_BACKGROUND_PATTERN.test(text))) {
                    phase = 'waiting';
                    continue;
                }
            }
            if (
                phase === 'waiting'
                && COMPLETION_MARKER_PATTERN.test(text)
                && (COMPLETED_TRUE_PATTERN.test(text) || COMPLETED_FALSE_PATTERN.test(text))
            ) {
                armed = true;
                closed = false;
                phase = bridgeOutcome(text);
            }
        }
    }
    return { phase, armed, closed, driverArmed: driverKeys.size > 0, escalated, keys: [...driverKeys] };
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

function escalationNote(keys) {
    const key = keys.length === 1 ? keys[0] : '<key>';
    return `\n\nThe last driver run ended in escalation (exit 12): two attempts are red. Read the escalation packet, decide who is at fault, and record it with qols loop verdict ${key} --blame spec|impl|judge --finding ID --hunk PATH:LINE --why TEXT; then run qols loop run ${key} again, or close the loop with qols loop close ${key} --outcome paused.`;
}

function blockReason(options = {}) {
    const base = baseBlockReason();
    return options.escalated ? base + escalationNote(options.keys ?? []) : base;
}

function baseBlockReason() {
    return `[qol-sessions feature loop]\n\nThe architect-owned feature loop is armed but cannot end yet: a delivered round's output is unreviewed, or the loop was left open without a completed review flow. Personally inspect the returned implementation against the user's complete acceptance criteria; if anything remains, send the same session one bounded correction round. The loop ends only when session_loop_close succeeds (or, for a loop opened with qols loop open, when qols loop close prints its loop_closed receipt); prose or a summary cannot close it.\n\nDo not finish at a round boundary. Only after the entire user feature is accepted, call session_loop_close with the final response session and completion_marker, outcome accepted, landed, before, now, verification, and remaining; a driver loop is accepted with qols loop close <key> --outcome accepted instead. If the user redirected the work or a genuine blocker requires user input, call session_loop_close with outcome paused and record the unfinished scope under remaining.`;
}

function checkpointDirs(payload) {
    if (typeof payload?.checkpoint_dir === 'string' && payload.checkpoint_dir) return [payload.checkpoint_dir];
    return STORE_DIRS.map((resolve) => resolve());
}

function ownedCheckpointScan(payload) {
    const initiator = typeof payload?.initiator === 'string' && payload.initiator ? payload.initiator : null;
    let storeDir = null;
    let names = [];
    try {
        for (const candidate of checkpointDirs(payload)) {
            if (!fs.existsSync(candidate)) continue;
            storeDir = candidate;
            names = fs.readdirSync(candidate);
            if (names.length) break;
        }
    } catch {
        return { storeDir: null, pending: false, anyClosed: false, allClosed: false };
    }
    if (!storeDir) return { storeDir: null, pending: false, anyClosed: false, allClosed: false };
    let ownedCount = 0;
    let pending = false;
    let anyClosed = false;
    let allClosed = true;
    for (const name of names) {
        if (!name.endsWith('.json') || name.startsWith('role-')) continue;
        let parsed;
        try {
            const file = path.join(storeDir, name);
            const stat = fs.statSync(file);
            if (stat.size <= 0 || stat.size > CHECKPOINT_SIZE_CAP) continue;
            parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        } catch {
            continue;
        }
        if (initiator && parsed.driver !== initiator) continue;
        ownedCount += 1;
        const isClosed = parsed?.closed === true;
        if (parsed?.completed === false) pending = true;
        if (isClosed) anyClosed = true;
        if (!isClosed) allClosed = false;
    }
    return { storeDir, pending, anyClosed, allClosed: ownedCount > 0 && allClosed };
}

function hasPendingCheckpoint(payload) {
    return ownedCheckpointScan(payload).pending;
}

function loopClosedInStore(payload) {
    const scan = ownedCheckpointScan(payload);
    if (!scan.storeDir) return false;
    return scan.allClosed || (!scan.pending && scan.anyClosed);
}

function main() {
    const payload = readPayload();
    if (payload?.hook_event_name && payload.hook_event_name !== 'Stop') return 0;
    const { phase, armed, closed, driverArmed, escalated, keys } = loopState(payload);
    if (closed) return 0;
    if (!driverArmed && loopClosedInStore(payload)) return 0;
    if (phase === 'waiting' || phase === 'user') return 0;
    if (!armed) return 0;
    if (!driverArmed && hasPendingCheckpoint(payload)) return 0;
    process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: blockReason({ escalated, keys }),
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
    bashExit,
    LOOP_CLOSE_TOOL_PATTERN,
    blockReason,
    checkpointDirs,
    closeReceipt,
    currentBranch,
    driverArmReceipt,
    driverCloseReceipt,
    featureLoopState,
    featureLoopPhase,
    hasPendingCheckpoint,
    loopClosedInStore,
    loopState,
    runsDriverVerb,
    loopPhase,
    readEntries,
    textFromContent,
};
