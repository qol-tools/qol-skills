'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'check-pathway-doc.cjs');

function run(payload) {
    const result = spawnSync('node', [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
    });
    return { exitCode: result.status, stderr: result.stderr };
}

const VALID_PROPOSAL = `
<div class="proposal">
  <h4>Proposal A &mdash; example <span class="badge cheap">cheap</span></h4>
  <pre class="mermaid">graph LR; A --> B</pre>
  <div class="tradeoffs">
    <div><h5>pros</h5>fast</div>
    <div><h5>cons</h5>brittle</div>
  </div>
  <p class="closes"><b>Closes:</b> <code>AREA-1</code>, <code>AREA-2</code></p>
</div>`;

const VALID_SMELL_TABLE = `
<table>
  <tr><th>ID</th><th>State</th><th>Smell</th></tr>
  <tr class="bad"><td class="pid">AREA-1</td><td><span class="swatch bad"></span>Broken</td><td>data loss</td></tr>
  <tr class="warn"><td class="pid">AREA-2</td><td><span class="swatch warn"></span>Leaky</td><td>race window</td></tr>
</table>`;

const VALID_PAGE = `
<section class="page" id="area-1">
  <h2>Area</h2>
  <h3>Problem</h3>
  <pre class="mermaid">graph TD; A --> B</pre>
  ${VALID_SMELL_TABLE}
  <h3>Proposals</h3>
  ${VALID_PROPOSAL}
</section>`;

const VALID_LEGEND = `<div class="legend"><span><span class="swatch bad"></span>bad</span></div>`;

const VALID_DOC = `<!doctype html><html><body>
<nav class="sidebar"><a href="#overview">x</a></nav>
<section class="page" id="overview"><h2>Overview</h2>${VALID_LEGEND}</section>
${VALID_PAGE}
<section class="page" id="cross"><h2>Cross</h2></section>
</body></html>`;

function call({ tool = 'Write', file = '/p/foo-pathways.html', content = VALID_DOC, cwd } = {}) {
    return run({
        tool_name: tool,
        cwd,
        tool_input: tool === 'Edit'
            ? { file_path: file, new_string: content }
            : { file_path: file, content },
    });
}

test('valid full doc passes', () => {
    const r = call();
    assert.equal(r.exitCode, 0, r.stderr);
});

test('non-pathway html files are not inspected', () => {
    const r = call({ file: '/p/index.html', content: '<html></html>' });
    assert.equal(r.exitCode, 0);
});

test('non-html files are not inspected', () => {
    const r = call({ file: '/p/foo-pathways.md', content: 'no sidebar' });
    assert.equal(r.exitCode, 0);
});

test('template.html is exempt', () => {
    const r = call({ file: '/p/skills/arch-pathways/template.html', content: '<html>incomplete</html>' });
    assert.equal(r.exitCode, 0);
});

test('non-Edit tools (Bash) are passthrough', () => {
    const r = run({ tool_name: 'Bash', tool_input: { command: 'echo' } });
    assert.equal(r.exitCode, 0);
});

test('missing sidebar is rejected', () => {
    const r = call({ content: VALID_DOC.replace('<nav class="sidebar">', '<nav class="other">') });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /missing <nav class="sidebar">/);
});

test('section without Problem header is rejected', () => {
    const broken = VALID_PAGE.replace('<h3>Problem</h3>', '<h3>Stuff</h3>');
    const doc = VALID_DOC.replace(VALID_PAGE, broken);
    const r = call({ content: doc });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /section #area-1: missing <h3>Problem<\/h3>/);
});

test('section without Proposals header is rejected', () => {
    const broken = VALID_PAGE.replace('<h3>Proposals</h3>', '<h3>Other</h3>');
    const doc = VALID_DOC.replace(VALID_PAGE, broken);
    const r = call({ content: doc });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /missing <h3>Proposals<\/h3>/);
});

test('overview page is exempt from Problem/Proposals requirement', () => {
    const r = call({
        content: `<html><body>
<nav class="sidebar"></nav>
<section class="page" id="overview"><h2>Overview</h2><p>just text</p></section>
<section class="page" id="cross"><h2>Cross</h2></section>
</body></html>`,
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('cross page is exempt from Problem/Proposals requirement', () => {
    const r = call({
        content: `<html><body>
<nav class="sidebar"></nav>
<section class="page" id="overview"></section>
<section class="page" id="cross"><h2>Cross</h2><p>just text</p></section>
</body></html>`,
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('proposal without mermaid diagram is rejected', () => {
    const broken = VALID_PROPOSAL.replace('<pre class="mermaid">graph LR; A --> B</pre>', '');
    const doc = VALID_DOC.replace(VALID_PROPOSAL, broken);
    const r = call({ content: doc });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /missing <pre class="mermaid">/);
});

test('proposal without tradeoffs grid is rejected', () => {
    const broken = VALID_PROPOSAL.replace(/<div class="tradeoffs">[\s\S]*?<\/div>\s*<\/div>/, '');
    const doc = VALID_DOC.replace(VALID_PROPOSAL, broken);
    const r = call({ content: doc });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /missing <div class="tradeoffs">/);
});

test('proposal with cons-before-pros is accepted', () => {
    const reordered = VALID_PROPOSAL
        .replace('<h5>pros</h5>fast', '__P__')
        .replace('<h5>cons</h5>brittle', '<h5>pros</h5>fast')
        .replace('__P__', '<h5>cons</h5>brittle');
    const doc = VALID_DOC.replace(VALID_PROPOSAL, reordered);
    const r = call({ content: doc });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('proposal without badge is rejected', () => {
    const broken = VALID_PROPOSAL.replace(/<span class="badge cheap">cheap<\/span>/, '');
    const doc = VALID_DOC.replace(VALID_PROPOSAL, broken);
    const r = call({ content: doc });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /missing <span class="badge/);
});

test('proposal with invalid badge value (e.g. yolo) is rejected', () => {
    const broken = VALID_PROPOSAL.replace('badge cheap', 'badge yolo');
    const doc = VALID_DOC.replace(VALID_PROPOSAL, broken);
    const r = call({ content: doc });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /missing <span class="badge/);
});

test('all three badge values are accepted', () => {
    for (const badge of ['cheap', 'medium', 'heavy']) {
        const swapped = VALID_PROPOSAL.replace('badge cheap', `badge ${badge}`).replace('>cheap<', `>${badge}<`);
        const doc = VALID_DOC.replace(VALID_PROPOSAL, swapped);
        const r = call({ content: doc });
        assert.equal(r.exitCode, 0, `${badge}: ${r.stderr}`);
    }
});

test('multiple proposals all validated', () => {
    const twoBroken = `
<section class="page" id="area-1">
  <h3>Problem</h3>
  <pre class="mermaid">a</pre>
  <h3>Proposals</h3>
  ${VALID_PROPOSAL}
  <div class="proposal">
    <h4>Proposal B <span class="badge medium">medium</span></h4>
    <pre class="mermaid">b</pre>
  </div>
</section>`;
    const doc = VALID_DOC.replace(VALID_PAGE, twoBroken);
    const r = call({ content: doc });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /proposal #2: missing <div class="tradeoffs">/);
});

test('Edit tool is also inspected', () => {
    const r = call({ tool: 'Edit', content: '<html>no sidebar</html>' });
    assert.equal(r.exitCode, 2);
});

test('bypass marker passes one edit and is consumed', () => {
    const tmp = require('node:os').tmpdir();
    const dir = require('node:fs').mkdtempSync(path.join(tmp, 'pathway-bypass-'));
    require('node:fs').mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const marker = path.join(dir, '.claude', 'bypass-arch-pathways');
    require('node:fs').writeFileSync(marker, '');

    const r = call({ cwd: dir, content: '<html>no sidebar</html>' });
    assert.equal(r.exitCode, 0, r.stderr);
    assert.equal(require('node:fs').existsSync(marker), false, 'marker should be consumed');
});

test('bypass marker with N decrements', () => {
    const tmp = require('node:os').tmpdir();
    const dir = require('node:fs').mkdtempSync(path.join(tmp, 'pathway-bypassN-'));
    require('node:fs').mkdirSync(path.join(dir, '.claude'), { recursive: true });
    const marker = path.join(dir, '.claude', 'bypass-arch-pathways');
    require('node:fs').writeFileSync(marker, '3');

    call({ cwd: dir, content: '<html>no sidebar</html>' });
    const after = require('node:fs').readFileSync(marker, 'utf8').trim();
    assert.equal(after, '2');
});

test('malformed payload does not crash hook (silent fail returns 0)', () => {
    const r = run({ not_a_tool_call: true });
    assert.equal(r.exitCode, 0);
});

test('empty stdin returns 0', () => {
    const result = spawnSync('node', [HOOK], { input: '', encoding: 'utf8' });
    assert.equal(result.status, 0);
});

test('smell table row missing tr class is rejected', () => {
    const broken = VALID_SMELL_TABLE.replace('<tr class="bad">', '<tr>');
    const doc = VALID_DOC.replace(VALID_SMELL_TABLE, broken);
    const r = call({ content: doc });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /missing class="bad\|warn\|good"/);
});

test('smell table row missing swatch is rejected', () => {
    const broken = VALID_SMELL_TABLE.replace('<span class="swatch bad"></span>', '');
    const doc = VALID_DOC.replace(VALID_SMELL_TABLE, broken);
    const r = call({ content: doc });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /missing <span class="swatch/);
});

test('smell table mismatched row class vs swatch is rejected', () => {
    const broken = VALID_SMELL_TABLE.replace('<span class="swatch bad">', '<span class="swatch warn">');
    const doc = VALID_DOC.replace(VALID_SMELL_TABLE, broken);
    const r = call({ content: doc });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /does not match swatch class/);
});

test('doc with smell table but no legend is rejected', () => {
    const doc = VALID_DOC.replace(VALID_LEGEND, '');
    const r = call({ content: doc });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /missing <div class="legend">/);
});

test('non-smell tables are not subject to swatch rules', () => {
    const nonSmell = `<table><tr><th>Foo</th><th>Bar</th></tr><tr><td>x</td><td>y</td></tr></table>`;
    const proposalNoCloses = `
<div class="proposal">
  <h4>Proposal A &mdash; example <span class="badge cheap">cheap</span></h4>
  <pre class="mermaid">graph LR; A --> B</pre>
  <div class="tradeoffs">
    <div><h5>pros</h5>fast</div>
    <div><h5>cons</h5>brittle</div>
  </div>
  <p class="closes"><b>Closes:</b> N/A</p>
</div>`;
    const doc = VALID_DOC
        .replace(VALID_SMELL_TABLE, nonSmell)
        .replace(VALID_PROPOSAL, proposalNoCloses);
    const r = call({ content: doc });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /contains no problem IDs/);
});

test('doc with no smell tables does not require legend (proposal with no closes refs)', () => {
    const proposalEmptyCloses = `
<div class="proposal">
  <h4>Proposal A &mdash; example <span class="badge cheap">cheap</span></h4>
  <pre class="mermaid">graph LR; A --> B</pre>
  <div class="tradeoffs">
    <div><h5>pros</h5>fast</div>
    <div><h5>cons</h5>brittle</div>
  </div>
  <p class="closes">N/A</p>
</div>`;
    const noTablePage = VALID_PAGE.replace(VALID_SMELL_TABLE, '').replace(VALID_PROPOSAL, proposalEmptyCloses);
    const doc = VALID_DOC.replace(VALID_PAGE, noTablePage).replace(VALID_LEGEND, '');
    const r = call({ content: doc });
    assert.equal(r.exitCode, 2, 'should fail because closes has no PIDs');
    assert.match(r.stderr, /contains no problem IDs/);
});

test('all three swatch severities accepted in same table', () => {
    const allThree = `
<table>
  <tr><th>ID</th><th>State</th><th>Smell</th></tr>
  <tr class="bad"><td class="pid">AREA-1</td><td><span class="swatch bad"></span>X</td><td>broken</td></tr>
  <tr class="warn"><td class="pid">AREA-2</td><td><span class="swatch warn"></span>Y</td><td>leaky</td></tr>
  <tr class="good"><td class="pid">AREA-3</td><td><span class="swatch good"></span>Z</td><td>fine</td></tr>
</table>`;
    const closesAll = VALID_PROPOSAL.replace(
        '<p class="closes"><b>Closes:</b> <code>AREA-1</code>, <code>AREA-2</code></p>',
        '<p class="closes"><b>Closes:</b> <code>AREA-1</code>, <code>AREA-2</code>, <code>AREA-3</code></p>'
    );
    const doc = VALID_DOC.replace(VALID_SMELL_TABLE, allThree).replace(VALID_PROPOSAL, closesAll);
    const r = call({ content: doc });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('smell table row missing pid cell is rejected', () => {
    const broken = VALID_SMELL_TABLE.replace('<td class="pid">AREA-1</td>', '');
    const doc = VALID_DOC.replace(VALID_SMELL_TABLE, broken);
    const r = call({ content: doc });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /missing <td class="pid">AREA-N<\/td>/);
});

test('proposal missing closes paragraph is rejected', () => {
    const broken = VALID_PROPOSAL.replace(/<p class="closes">[\s\S]*?<\/p>/, '');
    const doc = VALID_DOC.replace(VALID_PROPOSAL, broken);
    const r = call({ content: doc });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /missing <p class="closes">/);
});

test('closes empty of PIDs is rejected', () => {
    const broken = VALID_PROPOSAL.replace(
        /<p class="closes">[\s\S]*?<\/p>/,
        '<p class="closes"><b>Closes:</b> nothing yet</p>'
    );
    const doc = VALID_DOC.replace(VALID_PROPOSAL, broken);
    const r = call({ content: doc });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /contains no problem IDs/);
});

test('closes referencing unknown PID in same section is rejected', () => {
    const broken = VALID_PROPOSAL.replace(
        '<code>AREA-1</code>, <code>AREA-2</code>',
        '<code>AREA-1</code>, <code>AREA-99</code>'
    );
    const doc = VALID_DOC.replace(VALID_PROPOSAL, broken);
    const r = call({ content: doc });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /closes "AREA-99" but section #area-1 has no smell row/);
});

test('closes referencing only valid PIDs from same section passes', () => {
    const r = call();
    assert.equal(r.exitCode, 0, r.stderr);
});

test('pid format must be uppercase prefix dash digits', () => {
    const broken = VALID_SMELL_TABLE.replace('<td class="pid">AREA-1</td>', '<td class="pid">area-1</td>');
    const doc = VALID_DOC.replace(VALID_SMELL_TABLE, broken);
    const r = call({ content: doc });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /missing <td class="pid">/);
});
