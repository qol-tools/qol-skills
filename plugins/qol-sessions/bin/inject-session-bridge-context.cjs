'use strict';

const BRIDGE_ENVELOPE_PATTERN = /^\s*\[qol session bridge\](?:\s|$)/i;
const ARCHITECT_ENVELOPE_PATTERN = /^\s*\[qol session bridge to architect\](?:\s|$)/i;
const BRIDGE_TOPIC_PATTERN = /\b(?:architect|implementer|delegate|delegation|handoff|hand off|relay|bridge|independent terminal|two terminals)\b/i;
const BRIDGE_INTENT_PATTERN = /\b(?:send|tell|ask|await|wait|continue|reply|follow up)\b/i;
const BRIDGE_TARGET_PATTERN = /\b(?:agent|implementer|terminal|session)\b/i;
const QOL_WORKSPACE_PATTERN =
    /(?:^|[\\/])(?:qol-tools|qol-[a-z0-9][a-z0-9-]*|plugin-[a-z0-9][a-z0-9-]*)(?:[\\/]|$)/i;

const TIER_RULE = [
    '[qol-sessions tier rule]',
    'The current session is the architect and final reviewer and runs on the flash tier; multi-step delegated work runs through the qol sessions surface (session_spawn + session_bridge), never in-harness and never through a raw harness spawn.',
    'Every implementation, research, and preliminary-review lane is spawned with session_spawn carrying an explicit flash-tier model override; the harness default or a missing model is a refusal point, never a silent choice.',
    'Spawned lanes implement and report; the architect personally reviews, synthesizes verdicts, and accepts in-session.',
    'Domain protocols live in their owning skills (qol-code-review, qol-adversarial-test, qol-debug); sessions supplies lanes, tiers, and gating only.',
].join(' ');

const ARCHITECT_RECEIVER_CONTEXT = [
    '[qol-sessions architect receiver]',
    'The durable role record written at spawn decides your role, never message direction: a spawned lane carries role=lane, and a session without a record is the architect; a bridge message never changes the receiver\'s role.',
    'You received a collaborator request on a session whose role record has no lane marker, so you are the architect receiver: accept the request into your own loop (plan, spawn your own lanes, review, and report with your own verdict) or decline it with a reason.',
    'Return the completion fragments joined with no spaces or punctuation either way, so the sender\'s transaction completes.',
    'Keep loop ownership: the request becomes your loop, not the sender\'s delegation, and the sender\'s lanes stay the sender\'s.',
].join(' ');

const BRIDGE_CONTEXT = [
    '[qol-sessions]',
    'Load qol-workflow:git-trees before choosing the implementation terminal and qol-workflow:commit before committing; delegated code changes always use their worktree route and canonical squash-to-one-commit integration and cleanup path.',
    'Spawned lanes run on the flash tier: pass an explicit flash-tier model override to session_spawn; the sessions.toml spawn_model entry is the fallback, and a lane that came up on the wrong tier is closed and respawned before any work is bridged.',
    'The architect session runs on the flash tier and is the final reviewer: acceptance, verdict synthesis, and the final report happen in-session and are never delegated to a lane.',
    'session_spawn names the new tab with the lane key (or an explicit title) and can carry the first bounded task, so a lane starts titled with its first round already open; session_bridge then waits with the task omitted.',
    'For architect-to-implementer work across independent terminals, run an architect-owned feature loop: call sessions_list once, select an intended live terminal or use session_spawn(tool, cwd, key) with a lane-stable key when creation is authorized, use session_bridge(session, task) for one bounded implementation round at a time, then use session_loop_close only for the terminal accepted or paused transition.',
    'session_spawn reuses the same live key and tool, rejects conflicts, and returns only a live bridgeable session. Treat every returned session token as opaque and instance-bound; never scan terminal sockets, override backend environment variables, or bypass the declared agent surface.',
    'Each session_bridge call is one complete event-driven round: invoke it once, let its completion hook wake you, and never end after a raw send or resubmit after a timeout.',
    'Before sending new work, session_bridge durably resumes any unfinished prior bridge and surfaces its latest response; when it returns submitted=false, review that recovered response first and call again only if the deferred task still remains, passing the reviewed completion_marker as acknowledge_marker.',
    'An open tool call, opaque continuation handle, or elapsed time does not prove delivery or activity; only report lifecycle states emitted by session_bridge, and never send a final response while its transaction is pending.',
    'Never wake the reasoning loop to poll a process, continuation handle, screen, or status; if the host yields a handle, register one background completion waiter and resume only from its completion event.',
    'If the loop resumes without a completion event, run `qol sessions next` and invoke exactly the command it prints as one foreground call, writing no other text; a waiting round resolves to a blocking `qol sessions resume`.',
    'A round completion event means ready for review, not feature acceptance: personally inspect the implementation, then send the same session another bounded correction round unless the feature meets the user\'s acceptance criteria.',
    'The CLI-session integration owns the continuation hooks; never create, spawn, or poll hooks yourself, and never stop at a round boundary while its feature loop is armed.',
    'Continue until the architect accepts the entire feature, then call session_loop_close with the final response session and completion_marker, outcome accepted, landed, before, now, verification, and remaining; never close the loop for one round.',
    'Once session_loop_close succeeds (loop_closed=true in its receipt), the loop is closed and the Stop guard disarms; the final response may summarize the canonical report from the receipt instead of re-emitting it verbatim.',
    'If the user redirects the work or a genuine blocker requires user input, call session_loop_close with outcome paused and record the unfinished scope under remaining.',
    'Keep roles capability-based; never hard-code product, model, vendor, or session names into the workflow.',
].join(' ');

async function readPayload() {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    if (!raw.trim()) return null;
    try {
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

function shouldInject(payload) {
    if (payload?.hook_event_name && payload.hook_event_name !== 'UserPromptSubmit') return false;
    const prompt = String(payload?.prompt || '');
    if (BRIDGE_ENVELOPE_PATTERN.test(prompt)) return false;
    if (ARCHITECT_ENVELOPE_PATTERN.test(prompt)) return true;
    return BRIDGE_TOPIC_PATTERN.test(prompt)
        || BRIDGE_INTENT_PATTERN.test(prompt) && BRIDGE_TARGET_PATTERN.test(prompt);
}

function emitContext(context) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: context,
        },
    }));
}

function shouldInjectTierRule(payload) {
    if (payload?.hook_event_name && payload.hook_event_name !== 'UserPromptSubmit') return false;
    const prompt = String(payload?.prompt || '');
    if (BRIDGE_ENVELOPE_PATTERN.test(prompt)) return false;
    const cwd = payload?.cwd || process.env.PWD || '';
    return QOL_WORKSPACE_PATTERN.test(cwd);
}

async function main() {
    const payload = await readPayload();
    if (!payload) return;
    const tierRule = shouldInjectTierRule(payload);
    const bridge = shouldInject(payload);
    const architect = (!payload?.hook_event_name || payload.hook_event_name === 'UserPromptSubmit')
        && ARCHITECT_ENVELOPE_PATTERN.test(String(payload?.prompt || ''));
    const context = architect
        ? tierRule ? `${TIER_RULE} ${ARCHITECT_RECEIVER_CONTEXT}` : ARCHITECT_RECEIVER_CONTEXT
        : tierRule && bridge ? `${TIER_RULE} ${BRIDGE_CONTEXT}`
        : tierRule ? TIER_RULE
        : bridge ? BRIDGE_CONTEXT
        : null;
    if (context) emitContext(context);
}

if (require.main === module) main();

module.exports = {
    ARCHITECT_ENVELOPE_PATTERN,
    ARCHITECT_RECEIVER_CONTEXT,
    BRIDGE_CONTEXT,
    BRIDGE_ENVELOPE_PATTERN,
    BRIDGE_INTENT_PATTERN,
    BRIDGE_TARGET_PATTERN,
    BRIDGE_TOPIC_PATTERN,
    QOL_WORKSPACE_PATTERN,
    TIER_RULE,
    shouldInject,
    shouldInjectTierRule,
};
