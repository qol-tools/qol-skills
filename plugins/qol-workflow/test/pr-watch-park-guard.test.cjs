'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'pr-watch-park-guard.cjs');
const { decide, unparkedWatcher } = require('../bin/pr-watch-park-guard.cjs');

const URL = 'https://github.com/o/r/pull/7';
const PARK = `qol sessions park -- node /p/bin/pr-watch.cjs ${URL} --pretty`;

const watcherCases = [
    ['bare watcher', `node /p/bin/pr-watch.cjs ${URL} --pretty`, true],
    ['watcher after cd', `cd /wt && node /p/bin/pr-watch.cjs 7`, true],
    ['parked watcher', PARK, false],
    ['parked watcher with flags', `qol sessions park --model m -- node /p/bin/pr-watch.cjs 7`, false],
    ['park on another command then a bare watcher', `qol sessions park -- sleep 1; node /p/bin/pr-watch.cjs 7`, true],
    ['watcher help', 'node /p/bin/pr-watch.cjs --help', false],
    ['watcher tests', 'node --test test/pr-watch.test.cjs', false],
    ['reading the file', 'cat /p/bin/pr-watch.cjs', false],
    ['unrelated', 'git status', false],
];

for (const [name, command, expected] of watcherCases) {
    test(`unparkedWatcher: ${name}`, () => {
        assert.equal(unparkedWatcher(command), expected);
    });
}

test('PreToolUse denies an unparked watcher with the hook name and the park command', () => {
    const out = decide({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'node /p/bin/pr-watch.cjs 7' } });
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /\[pr-watch-park-guard\] run `qol sessions park -- node/);
    assert.equal(decide({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: PARK } }), null);
    assert.equal(decide({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { command: 'node /p/bin/pr-watch.cjs 7' } }), null);
});

let ids = 0;
function bash(command, ok = true) {
    ids += 1;
    const id = `toolu_${ids}`;
    return [
        JSON.stringify({ type: 'assistant', cwd: '/repo', message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } }),
        JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'out', is_error: !ok }] } }),
    ];
}

function stop(lines, extra = {}, exec = () => null) {
    const transcript = lines.flat().join('\n');
    return decide({ hook_event_name: 'Stop', transcript_path: '/t.jsonl', cwd: '/repo', ...extra }, () => transcript, exec);
}

const openPr = (cmd) => (cmd === 'git' ? 'feat' : JSON.stringify({ url: URL, state: 'OPEN' }));

const stopCases = [
    ['nothing pull-request related', [bash('cargo test')], null, true],
    ['a created pull request left unwatched', [bash('gh pr create --title "a: b"')], null, false],
    ['a created pull request then parked', [bash('gh pr create --title "a: b"'), bash(PARK)], null, true],
    ['a failed park does not count', [bash('gh pr create --title "a: b"'), bash(PARK, false)], null, false],
    ['a failed create does not count', [bash('gh pr create --title "a: b"', false)], null, true],
    ['parked, resumed, then pushed again', [bash('gh pr create --title "a: b"'), bash(PARK), bash('git push')], openPr, false],
    ['a push to a branch without an open pull request', [bash('git push')], () => null, true],
    ['held for testing', [bash('gh pr merge --auto 7'), bash('gh pr merge --disable-auto 7')], null, true],
    ['a bare background watcher does not count', [bash('gh pr create --title "a: b"'), bash('node /p/bin/pr-watch.cjs 7')], null, false],
];

for (const [name, lines, exec, allowed] of stopCases) {
    test(`Stop: ${name}`, () => {
        const out = stop(lines, {}, exec ?? undefined);
        if (allowed) assert.equal(out, null);
        else {
            assert.equal(out.decision, 'block');
            assert.match(out.reason, /qol sessions park -- node/);
            assert.match(out.reason, /\[pr-watch-park-guard\]/);
        }
    });
}

test('Stop never blocks twice in a row or without a transcript', () => {
    assert.equal(stop([bash('gh pr create --title "a: b"')], { stop_hook_active: true }), null);
    assert.equal(decide({ hook_event_name: 'Stop' }), null);
    assert.equal(decide({ hook_event_name: 'Stop', transcript_path: '/missing' }, () => { throw new Error('gone'); }), null);
});

test('the hook process prints the deny and exits 0', () => {
    const result = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'node /p/bin/pr-watch.cjs 7' } }),
        encoding: 'utf8',
    });
    assert.equal(result.status, 0);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
    const silent = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
    assert.equal(silent.status, 0);
    assert.equal(silent.stdout, '');
});
