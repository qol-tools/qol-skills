'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const pathwayPr = require('../bin/pathway-pr.cjs');

const SAMPLE = `<!doctype html><html><body>
<section class="page" id="boot">
  <h2>1. Boot pathway</h2>
  <div class="problem"><h3>Problem</h3>
    <pre class="mermaid">graph LR; A --> B</pre>
    <table><tr><th>ID</th><th>State</th><th>Smell</th></tr>
      <tr><td>BOOT-1</td><td>Broken</td><td>blocks main</td></tr>
    </table>
  </div>
  <div class="proposals"><h3>Proposals</h3>
    <div class="proposal">
      <h4>Proposal A &mdash; lazy <span class="badge medium">medium</span></h4>
      <p>Move work off main.</p>
      <pre class="mermaid">graph LR; A --> C</pre>
      <div class="tradeoffs">
        <div><h5>pros</h5>fast</div>
        <div><h5>cons</h5>complex</div>
      </div>
      <p class="closes"><b>Closes:</b> <code>BOOT-1</code></p>
    </div>
  </div>
</section>
</body></html>`;

function makeWorkspace() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pathway-pr-test-'));
    fs.mkdirSync(path.join(root, 'qol-skills'), { recursive: true });
    fs.mkdirSync(path.join(root, 'qol-tray', '.git'), { recursive: true });
    return root;
}

function withFakeInput(html) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathway-pr-input-'));
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

test('dry-run prints plan with sub-IDs without invoking gh', () => {
    const root = makeWorkspace();
    const file = withFakeInput(SAMPLE);
    const runner = makeRunner([
        {
            match: o => o.cmd === 'git' && o.args[0] === 'symbolic-ref',
            result: { stdout: 'origin/main\n', stderr: '', code: 0 },
        },
    ]);
    const lines = [];
    pathwayPr.run({
        argv: ['boot', 'qol-tray', '--in', file, '--dry-run'],
        env: {}, cwd: root, runner, fs,
        log: s => lines.push(s), error: () => {},
    });
    const out = lines.join('\n');
    assert.match(out, /TRAY-999/);
    assert.match(out, /tray-999-1-boot-pathway/);
    const ghCalls = runner.calls.filter(c => c.cmd === 'gh');
    assert.deepStrictEqual(ghCalls, []);
});

test('full run pipes mint -> extract -> new, ADR seeded with extracted markdown', () => {
    const root = makeWorkspace();
    const file = withFakeInput(SAMPLE);
    const runner = makeRunner([
        {
            match: o => o.cmd === 'git' && o.args[0] === 'symbolic-ref',
            result: { stdout: 'origin/main\n', stderr: '', code: 0 },
        },
        {
            match: o => o.cmd === 'gh' && o.args[0] === 'issue' && o.args[1] === 'create',
            result: { stdout: 'https://github.com/foo/qol-tray/issues/77\n', stderr: '', code: 0 },
        },
        {
            match: o => o.cmd === 'gh' && o.args[0] === 'pr' && o.args[1] === 'create',
            result: { stdout: 'https://github.com/foo/qol-tray/pull/88\n', stderr: '', code: 0 },
        },
    ]);
    const lines = [];
    pathwayPr.run({
        argv: ['boot', 'qol-tray', '--in', file],
        env: {}, cwd: root, runner, fs,
        log: s => lines.push(s), error: () => {},
    });
    const out = lines.join('\n');
    assert.match(out, /TRAY-77/);
    assert.match(out, /pull\/88/);

    const expectedAdr = path.join(root, 'worktrees', 'qol-tray', 'tray-77-1-boot-pathway',
        'docs', 'adr', 'TRAY-77-1-boot-pathway.md');
    assert.ok(fs.existsSync(expectedAdr), `ADR missing at ${expectedAdr}`);
    const adrBody = fs.readFileSync(expectedAdr, 'utf8');
    assert.match(adrBody, /^# TRAY-77 1\. Boot pathway/m);
    assert.match(adrBody, /TRAY-77\.1/);
    assert.match(adrBody, /\*\*Closes:\*\* TRAY-77\.1/);
    assert.match(adrBody, /Proposal A/);
    assert.match(adrBody, /\| Pros \| Cons \|/);

    const issueCreates = runner.calls.filter(c => c.cmd === 'gh' && c.args[0] === 'issue' && c.args[1] === 'create');
    assert.strictEqual(issueCreates.length, 1, 'should mint exactly one issue');
});

test('errors propagate when area not in HTML', () => {
    const root = makeWorkspace();
    const file = withFakeInput(SAMPLE);
    assert.throws(
        () => pathwayPr.run({
            argv: ['nope', 'qol-tray', '--in', file, '--dry-run'],
            env: {}, cwd: root, runner: makeRunner([]), fs,
            log: () => {}, error: () => {},
        }),
        /not found/,
    );
});
