'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const pidMint = require('../bin/pid-mint.cjs');

const SAMPLE = `<!doctype html><html><body>
<section class="page" id="boot">
  <h2>1. Boot pathway</h2>
  <div class="problem"><h3>Problem</h3>
    <table><tr><th>ID</th><th>State</th><th>Smell</th></tr>
      <tr><td>BOOT-1</td><td>Broken</td><td>blocks main</td></tr>
    </table>
  </div>
  <div class="proposals"><h3>Proposals</h3></div>
</section>
</body></html>`;

function makeWorkspace() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pid-mint-test-'));
    fs.mkdirSync(path.join(root, 'qol-skills'), { recursive: true });
    fs.mkdirSync(path.join(root, 'qol-tray', '.git'), { recursive: true });
    return root;
}

function withFakeInput(html) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pid-mint-input-'));
    const file = path.join(dir, 'survey.html');
    fs.writeFileSync(file, html);
    return file;
}

function makeRunner(responses) {
    const calls = [];
    function runner(opts) {
        calls.push({ cmd: opts.cmd, args: opts.args.slice(), cwd: opts.cwd });
        for (const r of responses) {
            if (r.match(opts)) return r.result;
        }
        return { stdout: '', stderr: '', code: 0 };
    }
    runner.calls = calls;
    return runner;
}

test('cleanAreaTitle strips numeric prefix and Title-Cases', () => {
    const cases = [
        ['1. Boot pathway', 'Boot Pathway'],
        ['2. Path resolution', 'Path Resolution'],
        ['3) Sync conflicts', 'Sync Conflicts'],
        ['Plugin lifecycle', 'Plugin Lifecycle'],
        ['  4.  Dev/Prod separation  ', 'Dev/prod Separation'],
        ['boot', 'Boot'],
    ];
    for (const [input, expected] of cases) {
        assert.strictEqual(pidMint.cleanAreaTitle(input), expected, `input: ${JSON.stringify(input)}`);
    }
});

test('run --dry-run prints PID without invoking gh', () => {
    const root = makeWorkspace();
    const file = withFakeInput(SAMPLE);
    const runner = makeRunner([]);
    const out = [], err = [];
    pidMint.run({
        argv: ['boot', 'qol-tray', '--in', file, '--dry-run'],
        env: {}, cwd: root, runner, fs,
        log: s => out.push(s), error: s => err.push(s),
    });
    assert.deepStrictEqual(out, ['TRAY-999']);
    assert.deepStrictEqual(runner.calls, []);
});

test('run --dry-run --json emits structured output', () => {
    const root = makeWorkspace();
    const file = withFakeInput(SAMPLE);
    const runner = makeRunner([]);
    const out = [];
    pidMint.run({
        argv: ['boot', 'qol-tray', '--in', file, '--dry-run', '--json'],
        env: {}, cwd: root, runner, fs,
        log: s => out.push(s), error: () => {},
    });
    const parsed = JSON.parse(out[0]);
    assert.strictEqual(parsed.pid, 'TRAY-999');
    assert.strictEqual(parsed.issue, 999);
    assert.strictEqual(parsed.repo, 'qol-tray');
    assert.strictEqual(parsed.area, 'boot');
    assert.match(parsed.title, /Boot/);
});

test('run mints issue via gh and prints PID', () => {
    const root = makeWorkspace();
    const file = withFakeInput(SAMPLE);
    const runner = makeRunner([
        {
            match: o => o.cmd === 'gh' && o.args[0] === 'issue' && o.args[1] === 'create',
            result: { stdout: 'https://github.com/foo/qol-tray/issues/123\n', stderr: '', code: 0 },
        },
    ]);
    const out = [], err = [];
    pidMint.run({
        argv: ['boot', 'qol-tray', '--in', file],
        env: {}, cwd: root, runner, fs,
        log: s => out.push(s), error: s => err.push(s),
    });
    assert.deepStrictEqual(out, ['TRAY-123']);
    const ghCall = runner.calls.find(c => c.cmd === 'gh');
    assert.ok(ghCall, 'should call gh');
    const titleIdx = ghCall.args.indexOf('--title');
    assert.match(ghCall.args[titleIdx + 1], /Boot/);
});

test('run errors on unknown area', () => {
    const root = makeWorkspace();
    const file = withFakeInput(SAMPLE);
    assert.throws(
        () => pidMint.run({
            argv: ['nope', 'qol-tray', '--in', file, '--dry-run'],
            env: {}, cwd: root, runner: makeRunner([]), fs,
            log: () => {}, error: () => {},
        }),
        /not found/,
    );
});

test('run errors on unknown repo', () => {
    const root = makeWorkspace();
    const file = withFakeInput(SAMPLE);
    assert.throws(
        () => pidMint.run({
            argv: ['boot', 'unknown-repo', '--in', file, '--dry-run'],
            env: {}, cwd: root, runner: makeRunner([]), fs,
            log: () => {}, error: () => {},
        }),
        /unknown repo/,
    );
});
