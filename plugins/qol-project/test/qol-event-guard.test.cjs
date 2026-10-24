'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'check-qol-arch-code.cjs');
const { lintFile } = require(HOOK);
const { newViolations, isPastTense } = require('../bin/qol-event-guard.cjs');

const FILE = 'libs/runtime/src/protocol.rs';

const PROTOCOL = ({ kinds = ['FocusChanged', 'CursorMoved'], focus = '        monitor_idx: Option<usize>,\n', cursor = '        x: f32,\n        y: f32,\n', extra = '' } = {}) => `use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RuntimeEventKind {
${kinds.map(kind => `    ${kind},\n`).join('')}}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "event", rename_all = "snake_case")]
pub enum RuntimeEvent {
    FocusChanged {
${focus}    },
    CursorMoved {
${cursor}    },
${extra}}

#[cfg(test)]
mod tests {
    enum RuntimeEventKind {
        NotAnEvent,
    }
}
`;

const messages = (baseline, content) => newViolations(FILE, baseline, content).map(v => `${v.line}: ${v.text}`);

test('past tense: regular, irregular and present names', () => {
    for (const name of ['FocusChanged', 'LauncherAppsSynced', 'WindowShown', 'PanelHidden', 'DeviceLost', 'ScanDone']) {
        assert.equal(isPastTense(name), true, name);
    }
    for (const name of ['WindowListRefresh', 'FocusChange', 'CursorMove', 'Tick']) {
        assert.equal(isPastTense(name), false, name);
    }
});

test('an unchanged protocol has no findings, with or without a base', () => {
    assert.deepEqual(messages(PROTOCOL(), PROTOCOL()), []);
    assert.deepEqual(messages(null, PROTOCOL()), []);
});

test('a variant that is not past tense is reported on its line, with or without a base', () => {
    const content = PROTOCOL({ kinds: ['FocusChanged', 'CursorMoved', 'WindowListRefresh'] });
    assert.deepEqual(messages(null, content), ['8: RuntimeEventKind::WindowListRefresh is not past tense; name the event for what happened (FocusChanged, LauncherAppsSynced)']);
    assert.equal(messages(content, content).length, 1);
});

test('a test-only enum with the same name is ignored', () => {
    assert.deepEqual(messages(null, PROTOCOL()), []);
});

test('a removed or renamed variant is reported', () => {
    const found = messages(PROTOCOL(), PROTOCOL({ kinds: ['FocusChanged', 'PointerMoved'] }));
    assert.deepEqual(found, ['5: RuntimeEventKind::CursorMoved was removed or renamed; subscribers built against it stop parsing. Keep the variant and add a new one']);
});

test('a removed payload field is reported', () => {
    const found = messages(PROTOCOL(), PROTOCOL({ cursor: '        x: f32,\n' }));
    assert.equal(found.length, 1);
    assert.match(found[0], /RuntimeEvent::CursorMoved\.y was removed or renamed; payloads are additive only/);
});

test('a new payload field needs #[serde(default)] unless it is an Option or skipped', () => {
    const cases = [
        ['        window_id: u32,\n', 1],
        ['        #[serde(default)]\n        window_id: u32,\n', 0],
        ['        #[serde(default, skip_serializing_if = "Option::is_none")]\n        window_id: Option<u32>,\n', 0],
        ['        window_id: Option<u32>,\n', 0],
        ['        #[serde(skip)]\n        window_id: u32,\n', 0],
    ];
    for (const [field, count] of cases) {
        const found = messages(PROTOCOL(), PROTOCOL({ focus: '        monitor_idx: Option<usize>,\n' + field }));
        assert.equal(found.length, count, field);
        if (count) assert.match(found[0], /^15: RuntimeEvent::FocusChanged\.window_id is a new field without #\[serde\(default\)\]/);
    }
});

test('fields of a new variant need no default, since no older subscriber knows the variant', () => {
    const extra = '    MonitorsChanged {\n        monitors: Vec<u32>,\n    },\n';
    assert.deepEqual(messages(PROTOCOL(), PROTOCOL({ extra })), []);
});

test('files without the event enums are ignored', () => {
    assert.deepEqual(newViolations('libs/x/src/lib.rs', null, 'pub enum Other { Tick }\n'), []);
});

function run(payload) {
    const result = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
    return { exitCode: result.status, stderr: result.stderr };
}

test('hook: an Edit that renames an event is blocked, and lint judges it against the base', () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qac-events-')), 'qol-monorepo', 'libs', 'runtime', 'src');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'protocol.rs');
    fs.writeFileSync(file, PROTOCOL());
    const result = run({ tool_name: 'Edit', cwd: dir, tool_input: { file_path: file, old_string: '    CursorMoved,\n', new_string: '    CursorMove,\n' } });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /runtime event violation/);
    assert.match(result.stderr, /RuntimeEventKind::CursorMoved was removed or renamed/);
    assert.match(result.stderr, /RuntimeEventKind::CursorMove is not past tense/);
    assert.match(result.stderr, /qol-arch-channels skill, "Rules"/);

    const renamed = PROTOCOL({ kinds: ['FocusChanged', 'PointerMoved'] });
    assert.equal(lintFile(file, renamed, PROTOCOL()).length, 1);
    assert.deepEqual(lintFile(file, renamed, renamed), []);
});
