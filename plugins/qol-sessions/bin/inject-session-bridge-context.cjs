'use strict';

const BRIDGE_ENVELOPE_PATTERN = /^\s*\[qol session bridge\](?:\s|$)/i;
const BRIDGE_TOPIC_PATTERN = /\b(?:architect|implementer|delegate|delegation|handoff|hand off|relay|bridge|independent terminal|two terminals)\b/i;
const BRIDGE_INTENT_PATTERN = /\b(?:send|tell|ask|await|wait|continue|reply|follow up)\b/i;
const BRIDGE_TARGET_PATTERN = /\b(?:agent|implementer|terminal|session)\b/i;

const BRIDGE_CONTEXT = [
    '[qol-sessions]',
    'For architect-to-implementer work across independent terminals, run an architect-owned feature loop: call sessions_list once, then use session_bridge(session, task) for one bounded implementation round at a time.',
    'Treat the returned session token as opaque and instance-bound; never scan terminal sockets, override backend environment variables, or bypass the two-action surface.',
    'Each session_bridge call is one complete event-driven round: invoke it once, let its completion hook wake you, and never end after a raw send or resubmit after a timeout.',
    'An open tool call, opaque continuation handle, or elapsed time does not prove delivery or activity; only report lifecycle states emitted by session_bridge, and never send a final response while its transaction is pending.',
    'Never wake the reasoning loop to poll a process, continuation handle, screen, or status; if the host yields a handle, register one background completion waiter and resume only from its completion event.',
    'A round completion event means ready for review, not feature acceptance: personally inspect the implementation, then send the same session another bounded correction round unless the feature meets the user\'s acceptance criteria.',
    'Continue until the architect accepts the feature, the user redirects the work, or a genuine blocker requires the user.',
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
