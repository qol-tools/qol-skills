'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'pr-watch-context.cjs');
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const { trigger, render, reminderText, silenced, pushDir } = require('../bin/pr-watch-context.cjs');

const URL = 'https://github.com/o/r/pull/7';

function fakeExec(branch, pr) {
    return (cmd) => {
        if (cmd === 'git') return branch;
        if (cmd === 'gh') return pr ? JSON.stringify(pr) : null;
        return null;
    };
}

const triggers = [
    ['gh pr create', 'gh pr create --title "feat(x): y" --body z', fakeExec(null), { url: null }],
    ['gh pr ready', 'gh pr ready 7', fakeExec(null), { url: null }],
    ['gh pr merge --auto', 'gh pr merge --auto 7', fakeExec(null), { url: null }],
    ['gh pr merge 7 --squash --auto', 'gh pr merge 7 --squash --auto', fakeExec(null), { url: null }],
    ['chained after cd', 'cd wt && gh pr create --title "a: b"', fakeExec(null), { url: null }],
    ['push with an open pull request', 'git push --force-with-lease', fakeExec('feat', { url: URL, state: 'OPEN' }), { url: URL }],
    ['push with a merged pull request', 'git push', fakeExec('feat', { url: URL, state: 'MERGED' }), null],
    ['push without a pull request', 'git push -u origin feat', fakeExec('feat', null), null],
    ['push from main', 'git push', fakeExec('main', { url: URL, state: 'OPEN' }), null],
    ['merge without --auto', 'gh pr merge 7 --squash', fakeExec(null), null],
    ['disable auto', 'gh pr merge --disable-auto 7', fakeExec(null), null],
    ['pr view', 'gh pr view 7', fakeExec(null), null],
    ['the watcher itself', 'node /x/bin/pr-watch.cjs 7 --pretty', fakeExec(null), null],
    ['plain git commit', 'git commit -m x', fakeExec(null), null],
];

for (const [name, command, exec, expected] of triggers) {
    test(`trigger: ${name}`, () => {
        assert.deepEqual(trigger(command, '/repo', exec), expected);
    });
}

test('pushDir follows git -C and a leading cd', () => {
    assert.equal(pushDir('git -C /wt push', '/repo'), '/wt');
    assert.equal(pushDir('cd ../wt && git push', '/repo/a'), '/repo/wt');
    assert.equal(pushDir('git push', '/repo'), '/repo');
});

test('the reminder is read from the qol-monorepo-rules skill block', () => {
    const text = reminderText(PLUGIN_ROOT);
    assert.match(text, /^\[qol-pr-watch\]/);
    assert.match(text, /<qol-workflow>\/bin\/pr-watch\.cjs <pr-url> --pretty/);
    assert.doesNotMatch(text, /inject:pr-watch/);
});

test('render fills the plugin path and a known URL', () => {
    const text = reminderText(PLUGIN_ROOT);
    assert.match(render(text, '/plug', URL), /node \/plug\/bin\/pr-watch\.cjs https:\/\/github\.com\/o\/r\/pull\/7 --pretty/);
    assert.match(render(text, '/plug', null), /node \/plug\/bin\/pr-watch\.cjs <pr-url> --pretty/);
});

test('the reader flag silences the reminder', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-watch-flag-'));
    assert.equal(silenced({}, home), false);
    fs.mkdirSync(path.join(home, '.claude'));
    fs.writeFileSync(path.join(home, '.claude', '.qol-pr-watch-reminder-off'), '');
    assert.equal(silenced({}, home), true);
});

function runHook(command, env = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-watch-home-'));
    return spawnSync('node', [HOOK], {
        input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: home }),
        encoding: 'utf8',
        env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: '', CLAUDE_PLUGIN_ROOT: PLUGIN_ROOT, ...env },
    });
}

test('the hook emits PreToolUse additionalContext before gh pr create', () => {
    const result = runHook('gh pr create --title "feat(x): y"');
    assert.equal(result.status, 0);
    const out = JSON.parse(result.stdout);
    assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.match(out.hookSpecificOutput.additionalContext, new RegExp(`node ${PLUGIN_ROOT}/bin/pr-watch\\.cjs`));
});

test('the hook stays silent on unrelated commands and bad input', () => {
    assert.equal(runHook('ls').stdout, '');
    const bad = spawnSync('node', [HOOK], { input: 'not json', encoding: 'utf8' });
    assert.equal(bad.status, 0);
    assert.equal(bad.stdout, '');
});
