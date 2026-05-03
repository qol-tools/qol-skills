'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const checkMd = require('../bin/check-pathway-md.cjs');
const HOOK = path.join(__dirname, '..', 'bin', 'check-pathway-md.cjs');

const FILENAME = 'TRAY-42-fold-installs.md';
const FILEPATH = `/repo/docs/adr/${FILENAME}`;

const VALID_ADR = `# TRAY-42 Fold Installs Into Config Dir

- **Status:** Proposed
- **Closes:** #42
- **Date:** 2026-05-03

## Problem

Today installs are scattered.

\`\`\`mermaid
graph LR
    A --> B
    classDef bad fill:#f5c2c7
    class B bad
\`\`\`

| ID | State | Smell |
|----|-------|-------|
| TRAY-42.1 | Broken | one-sentence smell |
| TRAY-42.2 | Leaky  | another smell |

## Proposals

### Proposal A — fold installs \`[cheap]\`

Move them.

\`\`\`mermaid
graph LR
    A --> C
\`\`\`

| Pros | Cons |
|------|------|
| fast | brittle |

**Closes:** TRAY-42.1, TRAY-42.2
`;

function runHook(payload) {
    const r = spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
    return { code: r.status, stderr: r.stderr };
}

test('valid ADR Write passes full validation', () => {
    const v = checkMd.validate('Write', { file_path: FILEPATH, content: VALID_ADR });
    assert.deepStrictEqual(v, []);
});

test('Write with missing Problem section fails', () => {
    const bad = VALID_ADR.replace('## Problem', '## What');
    const v = checkMd.validate('Write', { file_path: FILEPATH, content: bad });
    assert.ok(v.some(s => /Problem/.test(s)), 'expected Problem violation');
});

test('Write with missing Proposals section fails', () => {
    const bad = VALID_ADR.replace('## Proposals', '## Other');
    const v = checkMd.validate('Write', { file_path: FILEPATH, content: bad });
    assert.ok(v.some(s => /Proposals/.test(s)), 'expected Proposals violation');
});

test('Write with no mermaid blocks fails', () => {
    const bad = VALID_ADR.replace(/```mermaid[\s\S]*?```/g, '');
    const v = checkMd.validate('Write', { file_path: FILEPATH, content: bad });
    assert.ok(v.some(s => /mermaid/.test(s)));
});

test('Write with smell row missing sub-ID fails', () => {
    const bad = VALID_ADR.replace('| TRAY-42.1 |', '| 1 |');
    const v = checkMd.validate('Write', { file_path: FILEPATH, content: bad });
    assert.ok(v.some(s => /sub-ID/.test(s)));
});

test('Write with smell row using wrong PID fails', () => {
    const bad = VALID_ADR.replace('| TRAY-42.1 |', '| LIGHTS-7.1 |');
    const v = checkMd.validate('Write', { file_path: FILEPATH, content: bad });
    assert.ok(v.some(s => /does not start with this ADR's PID/.test(s)));
});

test('Write with Closes referencing missing sub-ID fails', () => {
    const bad = VALID_ADR.replace('TRAY-42.1, TRAY-42.2', 'TRAY-42.1, TRAY-42.99');
    const v = checkMd.validate('Write', { file_path: FILEPATH, content: bad });
    assert.ok(v.some(s => /TRAY-42\.99/.test(s)));
});

test('Write with bare PID in Closes fails', () => {
    const bad = VALID_ADR.replace('TRAY-42.1, TRAY-42.2', 'TRAY-42');
    const v = checkMd.validate('Write', { file_path: FILEPATH, content: bad });
    assert.ok(v.some(s => /bare PID/.test(s)));
});

test('Write with proposal missing cost badge fails', () => {
    const bad = VALID_ADR.replace('### Proposal A — fold installs `[cheap]`', '### Proposal A — fold installs');
    const v = checkMd.validate('Write', { file_path: FILEPATH, content: bad });
    assert.ok(v.some(s => /cost badge/.test(s)));
});

test('Write with malformed filename fails', () => {
    const v = checkMd.validate('Write', { file_path: '/repo/docs/adr/random.md', content: VALID_ADR });
    assert.ok(v.some(s => /filename/.test(s)));
});

test('Write with fa:fa- icons in mermaid fails (GitHub incompat)', () => {
    const bad = VALID_ADR.replace('graph LR\n    A --> B', 'graph LR\n    A[fa:fa-bell] --> B');
    const v = checkMd.validate('Write', { file_path: FILEPATH, content: bad });
    assert.ok(v.some(s => /fa:fa-/.test(s)));
});

test('Write with &lt; entity in mermaid fails (GitHub Mermaid HTML-parses it)', () => {
    const bad = VALID_ADR.replace('A --> B', 'Tray-->>Main: visible &lt;100ms');
    const v = checkMd.validate('Write', { file_path: FILEPATH, content: bad });
    assert.ok(v.some(s => /&lt;/.test(s)), `expected &lt; violation, got: ${v.join(' / ')}`);
});

test('Write with bare < in sequenceDiagram message fails (GitHub Mermaid HTML-parses it)', () => {
    const bad = VALID_ADR.replace(
        '```mermaid\ngraph LR\n    A --> B',
        '```mermaid\nsequenceDiagram\n    Tray-->>Main: visible <100ms',
    );
    const v = checkMd.validate('Write', { file_path: FILEPATH, content: bad });
    assert.ok(v.some(s => /bare `<`/.test(s)), `expected bare-< violation, got: ${v.join(' / ')}`);
});

test('Write with click directive in mermaid fails (GitHub incompat)', () => {
    const bad = VALID_ADR.replace('A --> C\n```', 'A --> C\n    click A href "https://x.com"\n```');
    const v = checkMd.validate('Write', { file_path: FILEPATH, content: bad });
    assert.ok(v.some(s => /click/.test(s)));
});

test('Edit only validates closes syntax + mermaid compat (not full structure)', () => {
    const edit = '\n\n**Closes:** TRAY-42.1\n';
    const v = checkMd.validate('Edit', { file_path: FILEPATH, new_string: edit });
    assert.deepStrictEqual(v, [], 'valid sub-id should pass on Edit');

    const bad = '\n\n**Closes:** TRAY-42\n';
    const v2 = checkMd.validate('Edit', { file_path: FILEPATH, new_string: bad });
    assert.ok(v2.some(s => /bare PID/.test(s)));
});

test('Edit Closes line with PIDs but no sub-IDs fails', () => {
    const v = checkMd.validate('Edit', {
        file_path: FILEPATH,
        new_string: '**Closes:** TRAY-42',
    });
    assert.ok(v.some(s => /bare PID/.test(s)));
});

test('Edit Closes line that looks like a frontmatter Closes #42 is ignored', () => {
    const v = checkMd.validate('Edit', {
        file_path: FILEPATH,
        new_string: '- **Closes:** #42',
    });
    assert.deepStrictEqual(v, []);
});

test('non-ADR markdown files are not inspected', () => {
    const v = checkMd.validate('Write', {
        file_path: '/repo/README.md',
        content: 'just some markdown',
    });
    assert.deepStrictEqual(v, []);
});

test('hook exit code 0 for non-Edit/Write tool', () => {
    const r = runHook({ tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.strictEqual(r.code, 0);
});

test('hook exit code 0 for valid ADR Write', () => {
    const r = runHook({
        tool_name: 'Write',
        tool_input: { file_path: FILEPATH, content: VALID_ADR },
        cwd: '/tmp',
    });
    assert.strictEqual(r.code, 0, `stderr: ${r.stderr}`);
});

test('hook exit code 2 for invalid ADR Write', () => {
    const r = runHook({
        tool_name: 'Write',
        tool_input: { file_path: FILEPATH, content: 'no problem section' },
        cwd: '/tmp',
    });
    assert.strictEqual(r.code, 2);
    assert.match(r.stderr, /missing/);
});

test('hook exit code 0 for non-ADR markdown file', () => {
    const r = runHook({
        tool_name: 'Write',
        tool_input: { file_path: '/repo/README.md', content: 'irrelevant' },
        cwd: '/tmp',
    });
    assert.strictEqual(r.code, 0);
});
