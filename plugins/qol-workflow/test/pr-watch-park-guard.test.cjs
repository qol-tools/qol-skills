'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'pr-watch-park-guard.cjs');
const { decide, unparkedWatcher, misplacedWatcher, settledArmings, subagentTranscript } = require('../bin/pr-watch-park-guard.cjs');

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
function bash(command, ok = true, background = false) {
    ids += 1;
    const id = `toolu_${ids}`;
    const input = background ? { command, run_in_background: true } : { command };
    return [
        JSON.stringify({ type: 'assistant', cwd: '/repo', message: { content: [{ type: 'tool_use', id, name: 'Bash', input }] } }),
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

const READ = { tool_name: 'Read', tool_input: { file_path: '/x' } };
const run = (command) => ({ tool_name: 'Bash', tool_input: { command } });
function pre(lines, tool = READ, exec = () => null, env = {}, extra = {}, settled = new Set()) {
    const transcript = lines.flat().join('\n');
    return decide({ hook_event_name: 'PreToolUse', transcript_path: '/t.jsonl', cwd: '/work/qol-monorepo', ...tool, ...extra }, () => transcript, exec, env, settled);
}

const CREATE = 'gh pr create --title "a: b"';
const armingCases = [
    ['a created pull request blocks a read', [bash(CREATE)], READ, undefined, false],
    ['a created pull request blocks an edit', [bash(CREATE)], { tool_name: 'Edit', tool_input: {} }, undefined, false],
    ['a created pull request blocks unrelated work', [bash(CREATE)], run('git worktree add ../next origin/main'), undefined, false],
    ['the park goes through', [bash(CREATE)], run(PARK), undefined, true],
    ['arming goes through', [bash(CREATE)], run('gh pr merge --auto 7'), undefined, true],
    ['opening another pull request waits for the park', [bash(CREATE)], run(CREATE), undefined, false],
    ['opening and arming another pull request waits too', [bash('gh pr merge 7 --auto')], run(`${CREATE} && gh pr merge --auto 8`), fleet({ pulls: { 7: view(URL) } }), false],
    ['the hold goes through', [bash(CREATE)], run('gh pr merge --disable-auto 7'), undefined, true],
    ['nothing is pending once parked', [bash(CREATE), bash(PARK)], READ, undefined, true],
    ['a failed park attempt releases it', [bash(CREATE), bash(PARK, false)], READ, undefined, true],
    ['a failed create does not count', [bash(CREATE, false)], READ, undefined, true],
    ['held for testing', [bash('gh pr merge --auto 7'), bash('gh pr merge --disable-auto 7')], READ, undefined, true],
    ['a push is left to Stop', [bash('git push')], READ, openPr, true],
    ['a park spelled through variables does not count', [bash(CREATE), bash('$P park -- node $W 7 --pretty')], READ, undefined, false],
    ['arming a pull request a waiting park watches', [bash('gh pr merge 7 --auto')], READ, fleet({ watching: [URL], pulls: { 7: view(URL) } }), true],
    ['arming a pull request nobody watches', [bash('gh pr merge 7 --auto')], READ, fleet({ watching: [OTHER], pulls: { 7: view(URL) } }), false],
    ['a closed pull request needs no watcher', [bash('gh pr merge 7 --auto')], READ, fleet({ pulls: { 7: JSON.stringify({ url: URL, state: 'MERGED' }) } }), true],
];

for (const [name, lines, tool, exec, allowed] of armingCases) {
    test(`PreToolUse: ${name}`, () => {
        const out = pre(lines, tool, exec);
        if (allowed) assert.equal(out, null);
        else {
            assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
            assert.match(out.hookSpecificOutput.permissionDecisionReason, /^A pull request you opened or armed has no watcher/);
            assert.match(out.hookSpecificOutput.permissionDecisionReason, /\n\[pr-watch-park-guard\] run `\S*qol-cli-sessions park -- node \S+pr-watch\.cjs \S+ --pretty`/);
        }
    });
}

test('PreToolUse names the pull request it resolved in the park command', () => {
    const out = pre([bash('gh pr merge 7 --auto')], READ, fleet({ pulls: { 7: view(URL) } }));
    assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(`pr-watch\\.cjs ${URL} --pretty`));
});

test('PreToolUse never blocks the switchboard, outside a qol tree, or without a readable transcript', () => {
    const switchboard = (cmd) => (cmd === 'kitten' ? JSON.stringify([{ tabs: [{ windows: [{ id: 9, user_vars: { qol_session_key: 'switchboard' } }] }] }]) : null);
    assert.equal(pre([bash(CREATE)], READ, switchboard, { KITTY_WINDOW_ID: '9' }), null);
    assert.equal(pre([bash(CREATE)], READ, undefined, {}, { cwd: '/work/other' }), null);
    assert.equal(decide({ hook_event_name: 'PreToolUse', tool_name: 'Read', cwd: '/work/qol-monorepo' }), null);
    assert.equal(decide({ hook_event_name: 'PreToolUse', tool_name: 'Read', cwd: '/work/qol-monorepo', transcript_path: '/missing' }, () => { throw new Error('gone'); }), null);
});

test('PreToolUse asks GitHub once about an arming a waiting park already watches', () => {
    let lookups = 0;
    const watching = fleet({ watching: [URL], pulls: { 7: view(URL) } });
    const counted = (cmd, args, cwd) => {
        if (cmd === 'gh') lookups += 1;
        return watching(cmd, args, cwd);
    };
    const settled = new Set();
    const lines = [bash('gh pr merge 7 --auto')];
    assert.equal(pre(lines, READ, counted, {}, {}, settled), null);
    assert.equal(pre(lines, READ, counted, {}, {}, settled), null);
    assert.equal(lookups, 1);
});

test('PreToolUse still denies an older unwatched arming behind a settled one', () => {
    const exec = fleet({ watching: [URL], pulls: { 7: view(URL), 8: view(OTHER) } });
    const out = pre([bash('gh pr merge 8 --auto'), bash('gh pr merge 7 --auto')], READ, exec);
    assert.match(out.hookSpecificOutput.permissionDecisionReason, new RegExp(`pr-watch\\.cjs ${OTHER} --pretty`));
});

test('settled armings persist as marker files and refuse ids that are not tool use ids', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'park-guard-settled-'));
    try {
        const store = settledArmings(path.join(dir, 'store'));
        assert.equal(store.has('toolu_01A'), false);
        assert.equal(store.add('toolu_01A'), true);
        assert.equal(settledArmings(path.join(dir, 'store')).has('toolu_01A'), true);
        assert.equal(store.add('../escape'), false);
        assert.equal(store.add(undefined), false);
        assert.equal(fs.existsSync(path.join(dir, 'escape')), false);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the hook process reads only the tail of a long transcript', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'park-guard-'));
    const padding = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(5 * 1024 * 1024) } });
    const decideFile = (lines) => {
        const file = path.join(dir, 't.jsonl');
        fs.writeFileSync(file, lines.flat().join('\n'));
        const result = spawnSync(process.execPath, [HOOK], {
            input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {}, transcript_path: file, cwd: '/work/qol-monorepo' }),
            encoding: 'utf8',
            env: { ...process.env, KITTY_WINDOW_ID: '', XDG_CONFIG_HOME: dir, TMPDIR: dir },
        });
        assert.equal(result.status, 0);
        return result.stdout;
    };
    try {
        assert.equal(JSON.parse(decideFile([bash(CREATE)])).hookSpecificOutput.permissionDecision, 'deny');
        assert.equal(decideFile([bash(CREATE), padding]), '');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

const WATCH = `node /p/bin/pr-watch.cjs ${URL} --pretty`;
const AGENT = { agent_id: 'a1b2c3', agent_type: 'project-fork' };
const watcherCalls = [
    ['a foreground watcher', 'node /p/bin/pr-watch.cjs 7', false, true],
    ['a background watcher', 'node /p/bin/pr-watch.cjs 7', true, false],
    ['a parked background watcher', PARK, true, true],
    ['a parked foreground watcher', PARK, false, true],
    ['a background help call', 'node /p/bin/pr-watch.cjs --help', true, false],
    ['a foreground help call', 'node /p/bin/pr-watch.cjs --help', false, false],
    ['a background call that is not the watcher', 'sleep 5', true, false],
    ['the watcher tests', 'node --test test/pr-watch.test.cjs', false, false],
];

for (const [name, command, background, denied] of watcherCalls) {
    test(`misplacedWatcher: ${name}`, () => {
        assert.equal(misplacedWatcher(command, background), denied);
    });
}

function subPre(lines, tool = READ, exec = () => null, extra = {}, settled = new Set()) {
    const transcript = lines.flat().join('\n');
    return decide({ hook_event_name: 'PreToolUse', transcript_path: '/parent.jsonl', cwd: '/work/qol-monorepo', ...AGENT, ...tool, ...extra }, () => transcript, exec, {}, settled, () => '/sub.jsonl');
}

const runBg = (command) => ({ tool_name: 'Bash', tool_input: { command, run_in_background: true } });

test('a subagent foreground watcher is denied with the exact bare background command', () => {
    const out = subPre([], run(`node /p/bin/pr-watch.cjs ${URL} --pretty`));
    const reason = out.hookSpecificOutput.permissionDecisionReason;
    assert.equal(out.hookSpecificOutput.permissionDecision, 'deny');
    assert.equal(reason.split('\n').length, 2);
    assert.match(reason, /\n\[pr-watch-park-guard\] call Bash with run_in_background true and the bare command `node \S+pr-watch\.cjs https:\/\/github\.com\/o\/r\/pull\/7 --pretty`/);
    assert.doesNotMatch(reason, /qol-cli-sessions/);
});

test('a subagent parked watcher is denied and the bare command drops the park', () => {
    const reason = subPre([], runBg(PARK)).hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /`node \S+pr-watch\.cjs https:\/\/github\.com\/o\/r\/pull\/7 --pretty`/);
    assert.doesNotMatch(reason, /park --/);
});

test('a subagent watcher without a pull request argument gets the placeholder', () => {
    const reason = subPre([], run('node /p/bin/pr-watch.cjs --pretty')).hookSpecificOutput.permissionDecisionReason;
    assert.match(reason, /pr-watch\.cjs <pr-url> --pretty`/);
});

test('a subagent background watcher goes through', () => {
    assert.equal(subPre([bash(CREATE)], runBg(WATCH)), null);
});

test('the same watcher call without agent_id keeps the park rule', () => {
    const out = decide({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'node /p/bin/pr-watch.cjs 7', run_in_background: true } });
    assert.match(out.hookSpecificOutput.permissionDecisionReason, /qol-cli-sessions park -- node/);
    assert.equal(decide({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: PARK, run_in_background: true } }), null);
});

const subArmingCases = [
    ['a created pull request blocks a read', [bash(CREATE)], READ, undefined, false],
    ['a created pull request blocks unrelated work', [bash(CREATE)], run('git status'), undefined, false],
    ['a created pull request then a background watcher', [bash(CREATE), bash(WATCH, true, true)], READ, undefined, true],
    ['a foreground watcher does not release it', [bash(CREATE), bash(WATCH)], READ, undefined, false],
    ['a park does not release it', [bash(CREATE), bash(PARK, true, true)], READ, undefined, false],
    ['a failed background watcher start releases it', [bash(CREATE), bash(WATCH, false, true)], READ, undefined, true],
    ['a background help call does not release it', [bash(CREATE), bash('node /p/bin/pr-watch.cjs --help', true, true)], READ, undefined, false],
    ['a background call that is not the watcher does not release it', [bash(CREATE), bash('sleep 60', true, true)], READ, undefined, false],
    ['the hold releases it', [bash(CREATE), bash('gh pr merge --disable-auto 7')], READ, undefined, true],
    ['arming goes through', [bash(CREATE)], run('gh pr merge --auto 7'), undefined, true],
    ['the hold goes through', [bash(CREATE)], run('gh pr merge --disable-auto 7'), undefined, true],
    ['opening another pull request waits for the watcher', [bash(CREATE)], run(CREATE), undefined, false],
    ['a failed create does not count', [bash(CREATE, false)], READ, undefined, true],
    ['an arming a waiting park watches', [bash('gh pr merge 7 --auto')], READ, fleet({ watching: [URL], pulls: { 7: view(URL) } }), true],
    ['an arming nobody watches', [bash('gh pr merge 7 --auto')], READ, fleet({ watching: [OTHER], pulls: { 7: view(URL) } }), false],
];

for (const [name, lines, tool, exec, allowed] of subArmingCases) {
    test(`subagent PreToolUse: ${name}`, () => {
        const out = subPre(lines, tool, exec);
        if (allowed) assert.equal(out, null);
        else {
            const reason = out.hookSpecificOutput.permissionDecisionReason;
            assert.match(reason, /^A pull request you opened or armed has no watcher/);
            assert.match(reason, /\n\[pr-watch-park-guard\] call Bash with run_in_background true and `node \S+pr-watch\.cjs \S+ --pretty`/);
            assert.doesNotMatch(reason, /qol-cli-sessions/);
        }
    });
}

test('a subagent is held even in a switchboard window', () => {
    const switchboard = (cmd) => (cmd === 'kitten' ? JSON.stringify([{ tabs: [{ windows: [{ id: 9, user_vars: { qol_session_key: 'switchboard' } }] }] }]) : null);
    const lines = [bash(CREATE)].flat().join('\n');
    const payload = { hook_event_name: 'PreToolUse', ...READ, cwd: '/work/qol-monorepo', transcript_path: '/parent.jsonl' };
    assert.equal(decide(payload, () => lines, switchboard, { KITTY_WINDOW_ID: '9' }, new Set()), null);
    const held = decide({ ...payload, ...AGENT }, () => lines, switchboard, { KITTY_WINDOW_ID: '9' }, new Set(), () => '/sub.jsonl');
    assert.equal(held.hookSpecificOutput.permissionDecision, 'deny');
});

test('a subagent whose transcript is not found or unreadable is not held', () => {
    const payload = { hook_event_name: 'PreToolUse', ...READ, cwd: '/work/qol-monorepo', transcript_path: '/parent.jsonl', ...AGENT };
    assert.equal(decide(payload, () => { throw new Error('gone'); }, undefined, {}, new Set(), () => '/sub.jsonl'), null);
    assert.equal(decide(payload, () => bash(CREATE).join('\n'), undefined, {}, new Set(), () => null), null);
});

test('a subagent is held from its own transcript, not the parent one', () => {
    const files = { '/parent.jsonl': bash(CREATE).join('\n'), '/sub.jsonl': '' };
    const read = (file) => files[file];
    const payload = { hook_event_name: 'PreToolUse', ...READ, cwd: '/work/qol-monorepo', transcript_path: '/parent.jsonl', ...AGENT };
    assert.equal(decide(payload, read, undefined, {}, new Set(), () => '/sub.jsonl'), null);
    files['/sub.jsonl'] = bash(CREATE).join('\n');
    assert.equal(decide(payload, read, undefined, {}, new Set(), () => '/sub.jsonl').hookSpecificOutput.permissionDecision, 'deny');
});

function subStop(lines, extra = {}, exec = () => null) {
    const transcript = lines.flat().join('\n');
    return decide({ hook_event_name: 'SubagentStop', agent_transcript_path: '/sub.jsonl', transcript_path: '/parent.jsonl', cwd: '/work/qol-monorepo', ...AGENT, ...extra }, (file) => (file === '/sub.jsonl' ? transcript : ''), exec, {});
}

const subStopCases = [
    ['nothing pull-request related', [bash('cargo test')], null, true],
    ['a created pull request left unwatched', [bash(CREATE)], null, false],
    ['a created pull request then a background watcher', [bash(CREATE), bash(WATCH, true, true)], null, true],
    ['a foreground watcher does not count', [bash(CREATE), bash(WATCH)], null, false],
    ['a park does not count', [bash(CREATE), bash(PARK, true, true)], null, false],
    ['a failed background watcher does not count', [bash(CREATE), bash(WATCH, false, true)], null, false],
    ['a failed create does not count', [bash(CREATE, false)], null, true],
    ['watched, woken, then pushed again', [bash(CREATE), bash(WATCH, true, true), bash('git push')], openPr, false],
    ['a push to a branch without an open pull request', [bash('git push')], () => null, true],
    ['held for testing', [bash('gh pr merge --auto 7'), bash('gh pr merge --disable-auto 7')], null, true],
];

for (const [name, lines, exec, allowed] of subStopCases) {
    test(`SubagentStop: ${name}`, () => {
        const out = subStop(lines, {}, exec ?? undefined);
        if (allowed) assert.equal(out, null);
        else {
            assert.equal(out.decision, 'block');
            assert.match(out.reason, /run_in_background true/);
            assert.match(out.reason, /node \S+pr-watch\.cjs/);
            assert.match(out.reason, /\[pr-watch-park-guard\]/);
            assert.doesNotMatch(out.reason, /qol-cli-sessions/);
        }
    });
}

test('SubagentStop names the pull request it resolved', () => {
    const out = subStop([bash('git push')], {}, openPr);
    assert.match(out.reason, new RegExp(`pull request ${URL} is not being watched`));
    assert.match(out.reason, new RegExp(`pr-watch\\.cjs ${URL} --pretty`));
});

test('SubagentStop never blocks twice, without a transcript, or on an unreadable one', () => {
    assert.equal(subStop([bash(CREATE)], { stop_hook_active: true }), null);
    assert.equal(decide({ hook_event_name: 'SubagentStop', ...AGENT, cwd: '/work/qol-monorepo' }), null);
    assert.equal(decide({ hook_event_name: 'SubagentStop', agent_transcript_path: '/missing', ...AGENT, cwd: '/work/qol-monorepo' }, () => { throw new Error('gone'); }), null);
});

test('SubagentStop reads the agent transcript, never the parent one', () => {
    const payload = { hook_event_name: 'SubagentStop', agent_transcript_path: '/sub.jsonl', transcript_path: '/parent.jsonl', cwd: '/work/qol-monorepo', ...AGENT };
    const parentOnly = (file) => (file === '/parent.jsonl' ? bash(CREATE).join('\n') : '');
    assert.equal(decide(payload, parentOnly, undefined, {}), null);
});

test('SubagentStop outside a qol tree is silent', () => {
    assert.equal(subStop([bash(CREATE)], { cwd: '/work/other' }), null);
});

test('subagentTranscript derives the subagent file from the parent transcript path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'park-guard-sub-'));
    try {
        const parent = path.join(dir, 'sess-1.jsonl');
        const direct = path.join(dir, 'sess-1', 'subagents', 'agent-a1.jsonl');
        const nested = path.join(dir, 'sess-1', 'subagents', 'workflows', 'run-9', 'agent-b2.jsonl');
        fs.mkdirSync(path.dirname(nested), { recursive: true });
        fs.writeFileSync(direct, '');
        fs.writeFileSync(nested, '');
        assert.equal(subagentTranscript({ transcript_path: parent, agent_id: 'a1' }), direct);
        assert.equal(subagentTranscript({ transcript_path: parent, agent_id: 'b2' }), nested);
        assert.equal(subagentTranscript({ transcript_path: parent, agent_id: 'c3' }), null);
        assert.equal(subagentTranscript({ transcript_path: parent, agent_id: '../x' }), null);
        assert.equal(subagentTranscript({ transcript_path: parent }), null);
        assert.equal(subagentTranscript({ agent_id: 'a1' }), null);
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('the hook process holds a subagent from the derived transcript path', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'park-guard-proc-'));
    const parent = path.join(dir, 'sess-1.jsonl');
    const sub = path.join(dir, 'sess-1', 'subagents', 'agent-a1b2c3.jsonl');
    fs.mkdirSync(path.dirname(sub), { recursive: true });
    fs.writeFileSync(parent, '');
    fs.writeFileSync(sub, bash(CREATE).join('\n'));
    try {
        const result = spawnSync(process.execPath, [HOOK], {
            input: JSON.stringify({ hook_event_name: 'PreToolUse', ...READ, transcript_path: parent, cwd: '/work/qol-monorepo', ...AGENT }),
            encoding: 'utf8',
            env: { ...process.env, XDG_CONFIG_HOME: dir, TMPDIR: dir },
        });
        assert.equal(result.status, 0);
        assert.match(JSON.parse(result.stdout).hookSpecificOutput.permissionDecisionReason, /run_in_background true/);
        const stopped = spawnSync(process.execPath, [HOOK], {
            input: JSON.stringify({ hook_event_name: 'SubagentStop', agent_transcript_path: sub, cwd: '/work/qol-monorepo', ...AGENT }),
            encoding: 'utf8',
            env: { ...process.env, XDG_CONFIG_HOME: dir, TMPDIR: dir },
        });
        assert.equal(JSON.parse(stopped.stdout).decision, 'block');
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('hooks.json registers the guard for SubagentStop', () => {
    const hooks = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'hooks', 'hooks.json'), 'utf8')).hooks;
    assert.match(hooks.SubagentStop[0].hooks[0].command, /bin\/pr-watch-park-guard\.cjs/);
    assert.equal(hooks.SubagentStop[0].hooks[0].command, hooks.Stop[0].hooks[0].command);
});
