'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
    findTriggers,
    hasCitation,
    consumeBypass,
    readLastAssistantMessage,
    lastAssistantText,
    TRIGGER_PATTERNS,
} = require('../bin/stop-deny-uncited-arch-claims.cjs');

const hookScript = path.join(__dirname, '..', 'bin', 'stop-deny-uncited-arch-claims.cjs');

function runHook(payload) {
    return execFileSync('node', [hookScript], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
    });
}

test('TRIGGER_PATTERNS exports a non-empty array of regexes', () => {
    assert.ok(Array.isArray(TRIGGER_PATTERNS));
    assert.ok(TRIGGER_PATTERNS.length > 0);
    for (const re of TRIGGER_PATTERNS) {
        assert.ok(re instanceof RegExp, `expected RegExp, got ${typeof re}`);
    }
});

test('findTriggers catches the verdict phrases from the May 2026 miss', () => {
    const cases = [
        'We hit the testability wall.',
        "This isn't testable without a refactor.",
        'SyncService is not testable as-is.',
        'Profile sync is untestable.',
        "the test seam doesn't exist yet",
        'the seam does not exist',
        'no test seam in this module',
        'this needs a refactor before testing',
        'needs a refactor first',
        'needs a config_root refactor',
        'needs config-root injection',
        'would need to inject the path here',
        'SyncService is coupled to global paths',
        'service is coupled to the global path',
    ];
    for (const text of cases) {
        const hits = findTriggers(text);
        assert.ok(hits.length > 0, `expected trigger for ${JSON.stringify(text)}`);
    }
});

test('findTriggers ignores benign prose', () => {
    const cases = [
        'All 6 tests pass.',
        'Refactor candidates: see the design doc.',
        'Tests are cheap to add here.',
        'The seam at src/paths.rs:33 already exists.',
        'No regressions.',
        '',
    ];
    for (const text of cases) {
        assert.deepEqual(
            findTriggers(text),
            [],
            `expected no trigger for ${JSON.stringify(text)}`,
        );
    }
});

test('hasCitation accepts file:line refs for common languages', () => {
    const cases = [
        'See src/paths.rs:33 for details',
        'foo/bar.ts:120 has it',
        'src/main.go:7',
        'tests/lib.py:12',
        'docs/x.md:4',
        'plugins/foo/bin/x.cjs:99',
    ];
    for (const text of cases) {
        assert.ok(hasCitation(text), `expected citation in ${JSON.stringify(text)}`);
    }
});

test('hasCitation rejects file refs without line and bare line refs', () => {
    const cases = [
        'See src/paths.rs for details',
        'around line 33',
        'src/main.rs is the file',
        'reference Cargo.toml',
        '',
    ];
    for (const text of cases) {
        assert.equal(
            hasCitation(text),
            false,
            `expected no citation in ${JSON.stringify(text)}`,
        );
    }
});

test('readLastAssistantMessage extracts the most recent assistant text from JSONL', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hook-'));
    const transcript = path.join(tmp, 'transcript.jsonl');
    fs.writeFileSync(
        transcript,
        [
            JSON.stringify({ message: { role: 'user', content: 'first' } }),
            JSON.stringify({ message: { role: 'assistant', content: 'older assistant turn' } }),
            JSON.stringify({ message: { role: 'user', content: 'middle' } }),
            JSON.stringify({
                message: {
                    role: 'assistant',
                    content: [
                        { type: 'text', text: 'final assistant turn' },
                        { type: 'tool_use', name: 'Bash' },
                    ],
                },
            }),
        ].join('\n'),
    );
    try {
        assert.equal(readLastAssistantMessage(transcript), 'final assistant turn');
    } finally {
        fs.rmSync(tmp, { recursive: true });
    }
});

test('readLastAssistantMessage tolerates missing or unreadable transcript', () => {
    assert.equal(readLastAssistantMessage('/nonexistent/path.jsonl'), '');
    assert.equal(readLastAssistantMessage(''), '');
    assert.equal(readLastAssistantMessage(null), '');
});

test('readLastAssistantMessage returns empty when no assistant message exists', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hook-'));
    const transcript = path.join(tmp, 'transcript.jsonl');
    fs.writeFileSync(
        transcript,
        [
            JSON.stringify({ message: { role: 'user', content: 'first' } }),
            JSON.stringify({ message: { role: 'user', content: 'second' } }),
        ].join('\n'),
    );
    try {
        assert.equal(readLastAssistantMessage(transcript), '');
    } finally {
        fs.rmSync(tmp, { recursive: true });
    }
});

test('lastAssistantText prefers direct Stop hook payload text', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hook-'));
    const transcript = path.join(tmp, 'transcript.jsonl');
    fs.writeFileSync(
        transcript,
        JSON.stringify({ message: { role: 'assistant', content: 'from transcript' } }),
    );
    try {
        assert.equal(
            lastAssistantText({
                last_assistant_message: 'from payload',
                transcript_path: transcript,
            }),
            'from payload',
        );
    } finally {
        fs.rmSync(tmp, { recursive: true });
    }
});

test('CLI blocks direct Stop hook payload verdicts without transcript parsing', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hook-'));
    const cwd = path.join(tmp, 'qol-tools', 'repo');
    fs.mkdirSync(cwd, { recursive: true });
    try {
        const output = runHook({
            cwd,
            last_assistant_message: 'This is untestable without a refactor.',
        });
        const parsed = JSON.parse(output);
        assert.equal(parsed.decision, 'block');
        assert.match(parsed.reason, /untestable/);
    } finally {
        fs.rmSync(tmp, { recursive: true });
    }
});

test('CLI exits cleanly on malformed JSON input', () => {
    const output = execFileSync('node', [hookScript], {
        input: '{',
        encoding: 'utf8',
    });
    assert.equal(output, '');
});

test('consumeBypass deletes single-shot marker and returns true', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hook-bypass-'));
    fs.mkdirSync(path.join(tmp, '.claude'));
    const marker = path.join(tmp, '.claude', 'bypass-seam-claim');
    fs.writeFileSync(marker, '');
    try {
        assert.equal(consumeBypass(tmp), true);
        assert.equal(fs.existsSync(marker), false, 'marker must be deleted');
    } finally {
        fs.rmSync(tmp, { recursive: true });
    }
});

test('consumeBypass decrements numeric counter when above 1', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hook-bypass-'));
    fs.mkdirSync(path.join(tmp, '.claude'));
    const marker = path.join(tmp, '.claude', 'bypass-seam-claim');
    fs.writeFileSync(marker, '3');
    try {
        assert.equal(consumeBypass(tmp), true);
        assert.equal(fs.readFileSync(marker, 'utf8').trim(), '2', 'counter must decrement');
    } finally {
        fs.rmSync(tmp, { recursive: true });
    }
});

test('consumeBypass returns false when no marker', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stop-hook-bypass-'));
    try {
        assert.equal(consumeBypass(tmp), false);
    } finally {
        fs.rmSync(tmp, { recursive: true });
    }
});
