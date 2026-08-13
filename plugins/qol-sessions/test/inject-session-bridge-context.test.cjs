'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'inject-session-bridge-context.cjs');
const MCP_CONFIG = path.join(__dirname, '..', '.mcp.json');
const SKILL = path.join(__dirname, '..', 'skills', 'qol-sessions', 'SKILL.md');
const BRIDGE_MAX_TIMEOUT_SECONDS = 86_400;
const {
    BRIDGE_CONTEXT,
    BRIDGE_TOPIC_PATTERN,
    QOL_WORKSPACE_PATTERN,
    TIER_RULE,
    shouldInject,
    shouldInjectTierRule,
} = require('../bin/inject-session-bridge-context.cjs');

function run(payload) {
    return spawnSync('node', [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
    });
}

test('bridge topics are role-based and model-invariant', () => {
    assert.ok(BRIDGE_TOPIC_PATTERN.test('delegate this to an implementation agent'));
    assert.ok(BRIDGE_TOPIC_PATTERN.test('bridge two terminals'));
    assert.ok(BRIDGE_TOPIC_PATTERN.test('the architect should review the handoff'));
    assert.doesNotMatch(BRIDGE_CONTEXT, /gpt|claude|codex|kimi|deepseek|fable/i);
});

test('unrelated prompts stay silent outside a qol workspace', () => {
    assert.ok(!shouldInject({ prompt: 'fix the settings panel padding' }));
    const result = run({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'fix padding',
        cwd: '/tmp/elsewhere',
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
});

test('the tier rule fires unconditionally inside a qol workspace', () => {
    const qolCwd = '/media/kmrh47/WD_SN850X/Git/qol-skills';
    assert.ok(QOL_WORKSPACE_PATTERN.test(qolCwd));
    assert.ok(!QOL_WORKSPACE_PATTERN.test('/tmp/elsewhere'));
    assert.ok(shouldInjectTierRule({ hook_event_name: 'UserPromptSubmit', prompt: 'fix padding', cwd: qolCwd }));
    assert.ok(!shouldInjectTierRule({ hook_event_name: 'PreToolUse', prompt: 'fix padding', cwd: qolCwd }));
    assert.ok(!shouldInjectTierRule({ prompt: '[qol session bridge]\nact as the implementer', cwd: qolCwd }));
    assert.doesNotMatch(TIER_RULE, /gpt|claude|codex|kimi|deepseek|fable/i);
    assert.match(TIER_RULE, /frontier tier/);
    assert.match(TIER_RULE, /flash-tier model override/);
    assert.match(TIER_RULE, /session_spawn/);
    const result = run({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'fix padding',
        cwd: qolCwd,
    });
    assert.equal(result.status, 0);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /\[qol-sessions tier rule\]/);
    assert.match(context, /never through a raw harness spawn/);
    assert.doesNotMatch(context, /sessions_list/);
});

test('a qol workspace topic prompt receives the tier rule plus the full bridge context', () => {
    const qolCwd = '/media/kmrh47/WD_SN850X/Git/qol-skills';
    const result = run({
        hook_event_name: 'UserPromptSubmit',
        prompt: 'hand off implementation to another agent terminal',
        cwd: qolCwd,
    });
    assert.equal(result.status, 0);
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
    assert.match(context, /\[qol-sessions tier rule\]/);
    assert.match(context, /sessions_list/);
});

test('matching prompts receive the event-driven feature loop', () => {
    for (const prompt of [
        'hand off implementation to another agent terminal',
        'send it to the agent',
        'await the agent response',
    ]) {
        const result = run({ hook_event_name: 'UserPromptSubmit', prompt, cwd: '/tmp/elsewhere' });
        assert.equal(result.status, 0);
        const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext;
        assert.match(context, /sessions_list/);
        assert.match(context, /session_spawn/);
        assert.match(context, /lane-stable key/);
        assert.match(context, /returns only a live bridgeable session/);
        assert.match(context, /session_bridge/);
        assert.match(context, /session_loop_close/);
        assert.match(context, /flash-tier model override/);
        assert.match(context, /Spawned lanes run on the flash tier/);
        assert.match(context, /verdict synthesis, and the final report happen in-session/);
        assert.match(context, /qol-workflow:git-trees/);
        assert.match(context, /qol-workflow:commit/);
        assert.match(context, /worktree route and canonical squash-to-one-commit/);
        assert.match(context, /session token as opaque and instance-bound/);
        assert.match(context, /never scan terminal sockets, override backend environment variables/);
        assert.match(context, /one bounded implementation round at a time/);
        assert.match(context, /completion hook wake you/);
        assert.match(context, /resumes any unfinished prior bridge and surfaces its latest response/);
        assert.match(context, /submitted=false/);
        assert.match(context, /completion_marker as acknowledge_marker/);
        assert.match(context, /does not prove delivery or activity/);
        assert.match(context, /only report lifecycle states emitted by session_bridge/);
        assert.match(context, /never send a final response while its transaction is pending/);
        assert.match(context, /Never wake the reasoning loop to poll/);
        assert.match(context, /background completion waiter/);
        assert.match(context, /ready for review, not feature acceptance/);
        assert.match(context, /another bounded correction round unless the feature meets/);
        assert.match(context, /integration owns the continuation hooks/);
        assert.match(context, /never create, spawn, or poll hooks yourself/);
        assert.match(context, /never stop at a round boundary/);
        assert.match(context, /Continue until the architect accepts the entire feature/);
        assert.match(context, /final response session and completion_marker, outcome accepted/);
        assert.match(context, /canonical final report from session_loop_close exactly/);
        assert.match(context, /outcome paused and record the unfinished scope under remaining/);
    }
});

test('the skill requires an event-driven review loop through feature acceptance', () => {
    const skill = fs.readFileSync(SKILL, 'utf8');
    assert.match(skill, /one event-driven transaction per implementation round/);
    assert.match(skill, /Invoke `session_bridge` exactly once for the current round/);
    assert.match(skill, /register that handle exactly once/);
    assert.match(skill, /proves neither delivery nor implementation activity/);
    assert.match(skill, /Never announce that the target is connected, resumed, active, or complete unless `session_bridge` reports that lifecycle state/);
    assert.match(skill, /never send a final response merely because the host yielded control/);
    assert.match(skill, /Never poll a process, continuation handle, screen, session, status, or clock/);
    assert.match(skill, /A round-complete event means ready for architect review; it never means the feature is accepted/);
    assert.match(skill, /durably resumes any unfinished prior bridge/);
    assert.match(skill, /returns `submitted=false`/);
    assert.match(skill, /`completion_marker` as `acknowledge_marker`/);
    assert.match(skill, /No new prompt may be submitted until this explicit acknowledgement matches/);
    assert.match(skill, /`session_spawn` is keyed, not heuristic/);
    assert.match(skill, /immediately usable by `session_bridge`/);
    assert.match(skill, /Treat every token returned by `sessions_list` or `session_spawn` as an opaque, instance-bound capability/);
    assert.match(skill, /Never inspect terminal sockets, override backend environment variables/);
    assert.match(skill, /return to step 3 with the same session/);
    assert.match(skill, /call `session_loop_close` with the final response's `session` and `completion_marker`/);
    assert.match(skill, /CLI-session integration installs the continuation hooks/);
    assert.match(skill, /Agents never create, spawn, or poll hooks themselves/);
    assert.match(skill, /queues another architect turn after the agent settles/);
    assert.match(skill, /Stop-capable host blocks the round-boundary response/);
    assert.match(skill, /`session_loop_close` is the only termination path/);
    assert.match(skill, /Never call it to accept one implementation round/);
    assert.match(skill, /Load `qol-workflow:git-trees`/);
    assert.match(skill, /`qol-workflow:commit` before committing/);
    assert.match(skill, /worktree route/);
    assert.match(skill, /squash-to-one-commit integration/);
    assert.match(skill, /What landed \/ Before \/ Now \/ Verification \/ Remaining/);
    assert.match(skill, /Do not use `read`, `send`, `wait`, or `focus` as an agent fallback/);
    assert.match(skill, /outer MCP tool deadline longer than the CLI bridge's maximum round timeout/);
});

test('the Codex MCP host outlives the longest bridge round', () => {
    const config = JSON.parse(fs.readFileSync(MCP_CONFIG, 'utf8'));
    const server = config.mcpServers['qol-sessions'];
    assert.ok(Number.isInteger(server.tool_timeout_sec));
    assert.ok(server.tool_timeout_sec > BRIDGE_MAX_TIMEOUT_SECONDS);
});

test('the implementation bridge envelope does not receive architect instructions', () => {
    const result = run({
        hook_event_name: 'UserPromptSubmit',
        prompt: '[qol session bridge]\nAct as the implementation agent. Do not delegate it.',
        cwd: '/media/kmrh47/WD_SN850X/Git/qol-skills',
    });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '');
});

test('other hook events and malformed input stay silent', () => {
    const wrongEvent = run({ hook_event_name: 'PreToolUse', prompt: 'bridge agents' });
    assert.equal(wrongEvent.status, 0);
    assert.equal(wrongEvent.stdout, '');

    const malformed = spawnSync('node', [HOOK], { input: 'not-json', encoding: 'utf8' });
    assert.equal(malformed.status, 0);
    assert.equal(malformed.stdout, '');
});
