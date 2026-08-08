'use strict';

const BRIDGE_ENVELOPE_PATTERN = /^\s*\[qol session bridge\](?:\s|$)/i;
const BRIDGE_TOPIC_PATTERN = /\b(?:architect|implementer|delegate|delegation|handoff|hand off|relay|bridge|independent terminal|two terminals)\b/i;
const BRIDGE_INTENT_PATTERN = /\b(?:send|tell|ask|await|wait|continue|reply|follow up)\b/i;
const BRIDGE_TARGET_PATTERN = /\b(?:agent|implementer|terminal|session)\b/i;

const BRIDGE_CONTEXT = [
    '[qol-sessions]',
    'For architect-to-implementer work across independent terminals, call sessions_list once and then session_bridge(session, task).',
    'session_bridge is the complete submit-and-wait transaction: keep that call open, never end after a raw send, and never resubmit after a timeout.',
    'The caller remains responsible for inspecting the implementation and reviewing it before replying.',
    'Keep roles capability-based; never hard-code product, model, vendor, or session names into the workflow.',
].join(' ');

async function readPayload() {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    try {
        return JSON.parse(raw || '{}');
    } catch {
        return {};
    }
}

function shouldInject(payload) {
    if (payload?.hook_event_name && payload.hook_event_name !== 'UserPromptSubmit') return false;
    const prompt = String(payload?.prompt || '');
    if (BRIDGE_ENVELOPE_PATTERN.test(prompt)) return false;
    return BRIDGE_TOPIC_PATTERN.test(prompt)
        || BRIDGE_INTENT_PATTERN.test(prompt) && BRIDGE_TARGET_PATTERN.test(prompt);
}

function emitContext() {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: BRIDGE_CONTEXT,
        },
    }));
}

async function main() {
    const payload = await readPayload();
    if (shouldInject(payload)) emitContext();
}

if (require.main === module) main();

module.exports = {
    BRIDGE_CONTEXT,
    BRIDGE_ENVELOPE_PATTERN,
    BRIDGE_INTENT_PATTERN,
    BRIDGE_TARGET_PATTERN,
    BRIDGE_TOPIC_PATTERN,
    shouldInject,
};
