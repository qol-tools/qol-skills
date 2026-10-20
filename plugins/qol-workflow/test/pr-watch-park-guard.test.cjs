'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'pr-watch-park-guard.cjs');
const { decide, unparkedWatcher } = require('../bin/pr-watch-park-guard.cjs');

const URL = 'https://github.com/o/r/pull/7';
const PARK = `qol-cli-sessions park -- node /p/bin/pr-watch.cjs ${URL} --pretty`;

const watcherCases = [
    ['bare watcher', `node /p/bin/pr-watch.cjs ${URL} --pretty`, true],
    ['watcher after cd', `cd /wt && node /p/bin/pr-watch.cjs 7`, true],
    ['parked watcher', PARK, false],
    ['parked watcher with flags', `qol-cli-sessions park --model m -- node /p/bin/pr-watch.cjs 7`, false],
    ['park on another command then a bare watcher', `qol-cli-sessions park -- sleep 1; node /p/bin/pr-watch.cjs 7`, true],
    ['parked watcher by plugin path', `/h/.config/qol-tray/plugins/qol-cli-sessions/qol-cli-sessions park -- node /p/bin/pr-watch.cjs 7`, false],
    ['the removed qol sessions park form', `qol sessions park -- node /p/bin/pr-watch.cjs 7`, true],
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
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /\[pr-watch-park-guard\] run `\S*qol-cli-sessions park -- node/);
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

function stop(lines, extra = {}, exec = () => null, env = {}) {
    const transcript = lines.flat().join('\n');
    return decide({ hook_event_name: 'Stop', transcript_path: '/t.jsonl', cwd: '/work/qol-monorepo', ...extra }, () => transcript, exec, env);
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
            assert.match(out.reason, /qol-cli-sessions park -- node/);
            assert.match(out.reason, /\[pr-watch-park-guard\]/);
        }
    });
}

const OTHER = 'https://github.com/o/r/pull/8';
const view = (url) => JSON.stringify({ url, state: 'OPEN' });
const parked = (url) => `park-1\twaiting\tclaude\t/repo\tnode /p/bin/pr-watch.cjs ${url} --pretty\t-`;
function fleet({ watching = [], branch = null, pulls = {} } = {}) {
    return (cmd, args) => {
        if (cmd === 'git') return branch;
        if (cmd === 'gh') return pulls[args[2]] ?? (branch ? view(URL) : null);
        if (cmd === 'kitten') return null;
        return watching.map(parked).join('\n');
    };
}

const ownershipCases = [
    ['arming a pull request its owner is watching', [bash('gh pr merge 7 --auto')], fleet({ watching: [URL], pulls: { 7: view(URL) } }), true],
    ['readying a pull request its owner is watching', [bash('gh pr ready 7 -R o/r')], fleet({ watching: [URL], pulls: { 7: view(URL) } }), true],
    ['arming a pull request nobody watches', [bash('gh pr merge 7 --auto')], fleet({ watching: [OTHER], pulls: { 7: view(URL) } }), false],
    ['an own unwatched push before arming a watched one', [bash('git push'), bash('gh pr merge 8 --auto')], fleet({ watching: [OTHER], branch: 'feat', pulls: { 8: view(OTHER) } }), false],
];

for (const [name, lines, exec, allowed] of ownershipCases) {
    test(`Stop: ${name}`, () => {
        const out = stop(lines, {}, exec);
        if (allowed) assert.equal(out, null);
        else assert.equal(out.decision, 'block');
    });
}

test('Stop never blocks the switchboard, which park refuses', () => {
    const lines = [bash('for n in 230 231; do gh pr ready $n -R o/r; gh pr merge $n -R o/r --auto; done')];
    const exec = (cmd) => (cmd === 'kitten' ? JSON.stringify([{ tabs: [{ windows: [{ id: 9, user_vars: { qol_session_key: 'switchboard' } }] }] }]) : null);
    assert.equal(stop(lines, { cwd: '/h/.local/share/qol-tray/sessions/switchboard' }, exec, { KITTY_WINDOW_ID: '9' }), null);
    assert.equal(stop(lines, { cwd: '/h/.local/share/qol-tray/sessions/switchboard' }, exec, { KITTY_WINDOW_ID: '10' }).decision, 'block');
});

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
