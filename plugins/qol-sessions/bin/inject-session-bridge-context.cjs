'use strict';

const BRIDGE_ENVELOPE_PATTERN = /^\s*\[qol session bridge\](?:\s|$)/i;
const BRIDGE_TOPIC_PATTERN = /\b(?:architect|implementer|delegate|delegation|handoff|hand off|relay|bridge|independent terminal|two terminals)\b/i;
const BRIDGE_INTENT_PATTERN = /\b(?:send|tell|ask|await|wait|continue|reply|follow up)\b/i;
const BRIDGE_TARGET_PATTERN = /\b(?:agent|implementer|terminal|session)\b/i;

const BRIDGE_CONTEXT = [
    '[qol-sessions]',
    'Load qol-workflow:git-trees before choosing the implementation terminal and qol-workflow:commit before committing; delegated code changes always use their worktree route and canonical squash-to-one-commit integration and cleanup path.',
    'For architect-to-implementer work across independent terminals, run an architect-owned feature loop: call sessions_list once, use session_bridge(session, task) for one bounded implementation round at a time, then use session_loop_close only for the terminal accepted or paused transition.',
    'Treat the returned session token as opaque and instance-bound; never scan terminal sockets, override backend environment variables, or bypass the declared agent surface.',
    'Each session_bridge call is one complete event-driven round: invoke it once, let its completion hook wake you, and never end after a raw send or resubmit after a timeout.',
    'Before sending new work, session_bridge durably resumes any unfinished prior bridge and surfaces its latest response; when it returns submitted=false, review that recovered response first and call again only if the deferred task still remains, passing the reviewed completion_marker as acknowledge_marker.',
    'An open tool call, opaque continuation handle, or elapsed time does not prove delivery or activity; only report lifecycle states emitted by session_bridge, and never send a final response while its transaction is pending.',
    'Never wake the reasoning loop to poll a process, continuation handle, screen, or status; if the host yields a handle, register one background completion waiter and resume only from its completion event.',
    'If the loop resumes without a completion event, run `qol sessions next` and invoke exactly the command it prints as one foreground call, writing no other text; a waiting round resolves to a blocking `qol sessions resume`.',
    'A round completion event means ready for review, not feature acceptance: personally inspect the implementation, then send the same session another bounded correction round unless the feature meets the user\'s acceptance criteria.',
    'The CLI-session integration owns the continuation hooks; never create, spawn, or poll hooks yourself, and never stop at a round boundary while its feature loop is armed.',
    'Continue until the architect accepts the entire feature, then call session_loop_close with the final response session and completion_marker, outcome accepted, landed, before, now, verification, and remaining; never close the loop for one round.',
    'Return the canonical final report from session_loop_close exactly; the loop remains armed until that report appears in the architect final response.',
    'If the user redirects the work or a genuine blocker requires user input, call session_loop_close with outcome paused and record the unfinished scope under remaining.',
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
