'use strict';

const test = require('node:test');
const assert = require('node:assert');

const survey = require('../lib/html-survey.cjs');

const SAMPLE = `<!doctype html><html><body>
<nav class="sidebar"></nav>
<main>
<section class="page" id="overview"><h2>Overview</h2></section>
<section class="page" id="boot">
  <h2>1. Boot pathway</h2>
  <div class="problem">
    <h3>Problem</h3>
    <p>Boot is slow.</p>
    <pre class="mermaid">
graph LR
    A --> B
    classDef bad fill:#f5c2c7
    class B bad
    </pre>
    <table>
      <tr><th>ID</th><th>State</th><th>Smell</th></tr>
      <tr class="bad"><td class="pid">BOOT-1</td><td><span class="swatch bad"></span>Broken</td><td>blocks main thread</td></tr>
      <tr class="warn"><td class="pid">BOOT-2</td><td><span class="swatch warn"></span>Leaky</td><td>races startup</td></tr>
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
    <div class="proposal">
      <h4>Proposal B &mdash; pidfile <span class="badge cheap">cheap</span></h4>
      <pre class="mermaid">graph TD; X --> Y</pre>
      <div class="tradeoffs">
        <div><h5>pros</h5>atomic</div>
        <div><h5>cons</h5>per-platform</div>
      </div>
      <p class="closes"><b>Closes:</b> <code>BOOT-1</code></p>
    </div>
  </div>
</section>
</main></body></html>`;

test('parseAreas finds all section ids', () => {
    const areas = survey.parseAreas(SAMPLE);
    assert.deepStrictEqual([...areas.keys()], ['overview', 'boot']);
});

test('parseSection extracts title, problem, proposals via headers', () => {
    const areas = survey.parseAreas(SAMPLE);
    const sec = survey.parseSection(areas.get('boot'));
    assert.strictEqual(sec.title, '1. Boot pathway');
    assert.ok(sec.problem.includes('<h3>Problem</h3>'));
    assert.ok(sec.problem.includes('<table>'));
    assert.ok(!sec.problem.includes('<h3>Proposals</h3>'));
    assert.ok(sec.proposals.includes('<h3>Proposals</h3>'));
    assert.ok(sec.proposals.includes('Proposal A'));
});

test('parseSmellTable extracts ID + state + smell cells', () => {
    const sec = survey.parseSection(survey.parseAreas(SAMPLE).get('boot'));
    const rows = survey.parseSmellTable(sec.problem);
    assert.strictEqual(rows.length, 2);
    assert.strictEqual(rows[0][0], 'BOOT-1');
    assert.match(rows[0][1], /Broken/);
    assert.strictEqual(rows[0][2], 'blocks main thread');
    assert.strictEqual(rows[1][0], 'BOOT-2');
});

test('parseMermaidBlocks returns trimmed unindented diagrams', () => {
    const sec = survey.parseSection(survey.parseAreas(SAMPLE).get('boot'));
    const blocks = survey.parseMermaidBlocks(sec.problem);
    assert.strictEqual(blocks.length, 1);
    assert.match(blocks[0], /^graph LR/);
    assert.match(blocks[0], /class B bad$/);
});

test('parseProposalCards returns title/cost/description/mermaid/pros/cons/closes', () => {
    const sec = survey.parseSection(survey.parseAreas(SAMPLE).get('boot'));
    const cards = survey.parseProposalCards(sec.proposals);
    assert.strictEqual(cards.length, 2);

    const a = cards[0];
    assert.match(a.title, /Proposal A/);
    assert.strictEqual(a.cost, 'medium');
    assert.strictEqual(a.description, 'Move work off main.');
    assert.strictEqual(a.mermaid.length, 1);
    assert.deepStrictEqual(a.pros, ['fast', 'simple']);
    assert.deepStrictEqual(a.cons, ['requires events']);
    assert.deepStrictEqual(a.closes, ['BOOT-1', 'BOOT-2']);

    const b = cards[1];
    assert.match(b.title, /Proposal B/);
    assert.strictEqual(b.cost, 'cheap');
    assert.deepStrictEqual(b.pros, ['atomic']);
    assert.deepStrictEqual(b.cons, ['per-platform']);
    assert.deepStrictEqual(b.closes, ['BOOT-1']);
});

test('buildPidMap maps source PIDs to "<TARGET>.N" in row order', () => {
    const sec = survey.parseSection(survey.parseAreas(SAMPLE).get('boot'));
    const rows = survey.parseSmellTable(sec.problem);
    const map = survey.buildPidMap(rows, 'TRAY-42');
    assert.strictEqual(map.get('BOOT-1'), 'TRAY-42.1');
    assert.strictEqual(map.get('BOOT-2'), 'TRAY-42.2');
});

test('rewritePidsInString applies the map', () => {
    const map = new Map([['BOOT-1', 'TRAY-42.1'], ['BOOT-2', 'TRAY-42.2']]);
    assert.strictEqual(
        survey.rewritePidsInString('Closes: BOOT-1, BOOT-2', map),
        'Closes: TRAY-42.1, TRAY-42.2',
    );
});

test('extractBalanced handles nested divs', () => {
    const html = '<div class="tradeoffs"><div>a</div><div>b<div>c</div>d</div></div> trailing';
    const found = survey.extractBalanced(html, /<div\s+class="tradeoffs"[^>]*>/i);
    assert.ok(found, 'should find tradeoffs block');
    assert.match(found.inner, /<div>a<\/div>/);
    assert.match(found.inner, /<div>c<\/div>/);
    assert.ok(!found.inner.includes('trailing'));
});

test('stripHtml decodes common entities and removes tags', () => {
    assert.strictEqual(survey.stripHtml('<b>x</b>&mdash;<i>y</i>'), 'x—y');
    assert.strictEqual(survey.stripHtml('a &amp; b &lt; c'), 'a & b < c');
});
