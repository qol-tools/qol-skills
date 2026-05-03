'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');

const pathwayExtract = require('../bin/pathway-extract.cjs');

const SAMPLE = `<!doctype html><html><body>
<section class="page" id="boot">
  <h2>1. Boot</h2>
  <div class="problem">
    <h3>Problem</h3>
    <p>Boot is slow.</p>
    <pre class="mermaid">graph LR; A --> B</pre>
    <table>
      <tr><th>ID</th><th>State</th><th>Smell</th></tr>
      <tr><td>BOOT-1</td><td>Broken</td><td>blocks main</td></tr>
      <tr><td>BOOT-2</td><td>Leaky</td><td>races startup</td></tr>
    </table>
  </div>
  <div class="proposals">
    <h3>Proposals</h3>
    <div class="proposal">
      <h4>Proposal A &mdash; lazy <span class="badge medium">medium</span></h4>
      <p>Move work off main.</p>
      <pre class="mermaid">graph LR; A --> C</pre>
      <div class="tradeoffs">
        <div><h5>pros</h5>fast<br/>simple</div>
        <div><h5>cons</h5>requires events</div>
      </div>
      <p class="closes"><b>Closes:</b> <code>BOOT-1</code>, <code>BOOT-2</code></p>
    </div>
  </div>
</section>
</body></html>`;

function withFakeInput(html) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pathway-extract-test-'));
    const file = path.join(dir, 'survey.html');
    fs.writeFileSync(file, html);
    return file;
}

test('parseArgs reads positional + flags', () => {
    const cases = [
        [['boot'], { positional: ['boot'] }],
        [['boot', '--pid', 'TRAY-42'], { positional: ['boot'], pid: 'TRAY-42' }],
        [['boot', '--in', '/x.html'], { positional: ['boot'], input: '/x.html' }],
        [['boot', '--issue', '42'], { positional: ['boot'], issue: 42 }],
        [['boot', '--status', 'Accepted'], { positional: ['boot'], status: 'Accepted' }],
        [['boot', '--title', 'Custom'], { positional: ['boot'], title: 'Custom' }],
        [['--help'], { positional: [], help: true }],
    ];
    for (const [argv, expected] of cases) {
        assert.deepStrictEqual(pathwayExtract.parseArgs(argv), expected, `argv: ${argv.join(' ')}`);
    }
});

test('today returns YYYY-MM-DD', () => {
    assert.match(pathwayExtract.today(), /^\d{4}-\d{2}-\d{2}$/);
});

test('smellRowsToMarkdown formats rows with optional PID rewriting', () => {
    const rows = [
        ['BOOT-1', 'Broken', 'data loss'],
        ['BOOT-2', 'Leaky', 'race window'],
    ];
    const map = new Map([['BOOT-1', 'TRAY-42.1'], ['BOOT-2', 'TRAY-42.2']]);
    const out = pathwayExtract.smellRowsToMarkdown(rows, map);
    assert.match(out, /\| ID \| State \| Smell \|/);
    assert.match(out, /\| TRAY-42\.1 \| Broken \| data loss \|/);
    assert.match(out, /\| TRAY-42\.2 \| Leaky \| race window \|/);
});

test('tradeoffsToMarkdown renders 2-column table padding shorter side', () => {
    const out = pathwayExtract.tradeoffsToMarkdown(['a', 'b', 'c'], ['x']);
    const lines = out.split('\n');
    assert.strictEqual(lines[0], '| Pros | Cons |');
    assert.strictEqual(lines[2], '| a | x |');
    assert.strictEqual(lines[3], '| b |  |');
    assert.strictEqual(lines[4], '| c |  |');
});

test('proposalToMarkdown emits headline + cost + diagrams + tradeoffs + closes', () => {
    const card = {
        title: 'Proposal A — lazy',
        cost: 'medium',
        description: 'Move work off main.',
        mermaid: ['graph LR; A --> C'],
        pros: ['fast'],
        cons: ['needs events'],
        closes: ['BOOT-1'],
    };
    const map = new Map([['BOOT-1', 'TRAY-42.1']]);
    const out = pathwayExtract.proposalToMarkdown(card, map);
    assert.match(out, /^### Proposal A — lazy `\[medium\]`/);
    assert.match(out, /Move work off main\./);
    assert.match(out, /```mermaid/);
    assert.match(out, /\| Pros \| Cons \|/);
    assert.match(out, /\*\*Closes:\*\* TRAY-42\.1/);
});

test('run extracts area as markdown ADR', () => {
    const file = withFakeInput(SAMPLE);
    const lines = [];
    pathwayExtract.run({
        argv: ['boot', '--in', file, '--pid', 'TRAY-42'],
        fs,
        log: s => lines.push(s),
    });
    const out = lines.join('\n');
    assert.match(out, /^# TRAY-42 1\. Boot/m);
    assert.match(out, /\*\*Status:\*\* Proposed/);
    assert.match(out, /\*\*Closes:\*\* #42/);
    assert.match(out, /^## Problem/m);
    assert.match(out, /^## Proposals/m);
    assert.match(out, /TRAY-42\.1/);
    assert.match(out, /TRAY-42\.2/);
    assert.match(out, /\*\*Closes:\*\* TRAY-42\.1, TRAY-42\.2/);
});

test('run errors on unknown area', () => {
    const file = withFakeInput(SAMPLE);
    assert.throws(
        () => pathwayExtract.run({ argv: ['nope', '--in', file], fs, log: () => {} }),
        /not found/,
    );
});

test('run errors when --pid is malformed', () => {
    const file = withFakeInput(SAMPLE);
    assert.throws(
        () => pathwayExtract.run({ argv: ['boot', '--in', file, '--pid', 'tray-42'], fs, log: () => {} }),
        /must match/,
    );
});

test('run errors when input file is missing', () => {
    assert.throws(
        () => pathwayExtract.run({ argv: ['boot', '--in', '/nonexistent.html'], fs, log: () => {} }),
        /not found/,
    );
});
