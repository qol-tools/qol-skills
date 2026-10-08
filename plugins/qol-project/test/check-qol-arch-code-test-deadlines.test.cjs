'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'check-qol-arch-code.cjs');

function run(payload) {
    const result = spawnSync('node', [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
    });
    return { exitCode: result.status, stderr: result.stderr };
}

function fixture(relativePath, content) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-hook-'));
    const root = path.join(temp, 'qol-monorepo');
    const crateRoot = path.join(root, 'libs', 'qol-library');
    const file = path.join(crateRoot, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.writeFileSync(path.join(crateRoot, 'Cargo.toml'), '[package]\nname = "qol-library"\nversion = "0.1.0"\n');
    if (content !== undefined) fs.writeFileSync(file, content);
    return { root, file };
}

function write(file, content, cwd) {
    return run({ tool_name: 'Write', tool_input: { file_path: file, content }, cwd });
}

function testModule(body) {
    return [
        'pub fn work() {}',
        '',
        '#[cfg(test)]',
        'mod tests {',
        '    use std::time::{Duration, Instant};',
        '',
        '    #[test]',
        '    fn waits() {',
        ...body.map(line => `        ${line}`),
        '    }',
        '}',
        '',
    ].join('\n');
}

for (const [label, line] of [
    ['recv_timeout under 5 s', 'rx.recv_timeout(Duration::from_millis(500)).unwrap();'],
    ['recv_timeout under 5 s', 'rx.recv_timeout(Duration::from_secs(2)).expect("the event must arrive");'],
    ['recv_timeout under 5 s', 'assert!(rx.recv_timeout(std::time::Duration::from_secs(1)).is_ok());'],
    ['elapsed-time upper bound under 5 s', 'assert!(started.elapsed() < Duration::from_millis(400));'],
    ['elapsed-time upper bound under 5 s', 'assert!(elapsed <= Duration::from_secs(3));'],
    ['tokio timeout under 5 s', 'tokio::time::timeout(Duration::from_secs(1), task).await.unwrap();'],
]) {
    test(`blocks ${line} in a test module`, () => {
        const { file } = fixture('src/lib.rs');
        const r = write(file, testModule([line]));
        assert.equal(r.exitCode, 2);
        assert.match(r.stderr, new RegExp(label));
        assert.match(r.stderr, /Never let a passing test race a\s+short clock/);
    });
}

test('blocks a short wait split across lines', () => {
    const { file } = fixture('src/lib.rs');
    const r = write(file, testModule([
        'rx',
        '    .recv_timeout(Duration::from_millis(300))',
        '    .expect("the event must arrive");',
    ]));
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /recv_timeout under 5 s/);
});

test('blocks a short wait in a tests/ integration file', () => {
    const { file } = fixture('tests/flow.rs');
    const r = write(file, 'fn waits() {\n    rx.recv_timeout(Duration::from_secs(1)).unwrap();\n}\n');
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /recv_timeout under 5 s/);
});

test('blocks a short wait added by Edit to a tests.rs file', () => {
    const { file } = fixture('src/tests.rs', 'fn waits() {\n    rx.recv_timeout(Duration::from_secs(5)).unwrap();\n}\n');
    const r = run({
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: 'from_secs(5)', new_string: 'from_millis(250)' },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /recv_timeout under 5 s/);
});

test('blocks a production deadline given a shorter value under cfg(test)', () => {
    const { file } = fixture('src/probe.rs');
    const r = write(file, [
        '#[cfg(not(test))]',
        'const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(2);',
        '#[cfg(test)]',
        'const PROBE_TIMEOUT: std::time::Duration = std::time::Duration::from_millis(300);',
        '',
    ].join('\n'));
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /production deadline shortened under #\[cfg\(test\)\]/);
});

for (const [label, lines] of [
    ['a wait that expects nothing to arrive', ['assert!(rx.recv_timeout(Duration::from_millis(50)).is_err());']],
    ['a 5 s wait on an expected event', ['rx.recv_timeout(Duration::from_secs(5)).unwrap();']],
    ['an elapsed-time lower bound', ['assert!(started.elapsed() >= Duration::from_millis(200));']],
    ['a 5 s elapsed-time upper bound', ['assert!(started.elapsed() < Duration::from_secs(5));']],
    ['a short tokio timeout the test expects to fire', ['assert!(tokio::time::timeout(Duration::from_millis(100), task).await.is_err());']],
    ['a short deadline in a comment', ['// rx.recv_timeout(Duration::from_millis(500)).unwrap();']],
]) {
    test(`passes ${label}`, () => {
        const { file } = fixture('src/lib.rs');
        const r = write(file, testModule(lines));
        assert.equal(r.exitCode, 0, r.stderr);
    });
}

test('passes a short wait in production code', () => {
    const { file } = fixture('src/poll.rs');
    const r = write(file, 'pub fn poll(rx: &Receiver<()>) {\n    rx.recv_timeout(Duration::from_millis(100)).unwrap();\n}\n');
    assert.equal(r.exitCode, 0, r.stderr);
});

test('passes a cfg(test) interval that is not a deadline', () => {
    const { file } = fixture('src/socket.rs');
    const r = write(file, [
        '#[cfg(not(test))]',
        'const KEEPALIVE_PROBE: Duration = Duration::from_secs(5);',
        '#[cfg(test)]',
        'const KEEPALIVE_PROBE: Duration = Duration::from_millis(50);',
        '',
    ].join('\n'));
    assert.equal(r.exitCode, 0, r.stderr);
});

test('passes a test-only deadline with no production twin', () => {
    const { file } = fixture('src/server.rs');
    const r = write(file, '#[cfg(test)]\nconst TEST_ROUND_TIMEOUT: Duration = Duration::from_millis(250);\n');
    assert.equal(r.exitCode, 0, r.stderr);
});

test('passes an unrelated edit to a file with existing short waits', () => {
    const debt = testModule(['rx.recv_timeout(Duration::from_millis(500)).unwrap();']);
    const { file } = fixture('src/lib.rs', debt);
    const r = run({
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: 'pub fn work() {}', new_string: 'pub fn work() -> u8 {\n    1\n}' },
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('the bypass marker lets one edit through and then re-locks', () => {
    const { root, file } = fixture('src/lib.rs');
    const marker = path.join(root, '.claude', 'bypass-qol-arch-code');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '');
    const content = testModule(['rx.recv_timeout(Duration::from_millis(500)).unwrap();']);

    assert.equal(write(file, content, root).exitCode, 0);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(write(file, content, root).exitCode, 2);
});

test('earlier checks still fire after the filter', () => {
    const { file } = fixture('src/lib.rs');
    const r = write(file, 'compile_error!("unsupported");\n');
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /compile_error/);
});
