'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { callerLane, dataDir, decide, recordedParent } = require('../bin/deny-lane-ask-user.cjs');

const ask = { tool_name: 'AskUserQuestion', tool_input: { questions: [] } };
const row = (fields) => ({ root_pid: 40, master: false, ...fields });
const lane = (rows, parents = {}) => () =>
    callerLane({ rows, chain: new Set([99, 40, 7]), parentOf: (key) => parents[key] ?? null });

test('a lane with a recorded parent is sent to its parent', () => {
    const decision = decide(ask, lane([row({ key: 'sb-skills' })], { 'sb-skills': 'switchboard-automation' }));
    assert.equal(decision?.hookSpecificOutput?.permissionDecision, 'deny');
    const [first, second] = decision.hookSpecificOutput.permissionDecisionReason.split('\n');
    assert.match(first, /^sb-skills is a lane of switchboard-automation/);
    assert.match(second, /^\[deny-lane-ask-user\] send the question to switchboard-automation with session_send kind ask/);
});

test('the switchboard, keyless and parentless sessions keep AskUserQuestion', () => {
    const parents = { switchboard: 'someone', orphan: null };
    for (const rows of [
        [row({ key: 'switchboard', master: true })],
        [row({})],
        [row({ key: 'orphan' })],
        [row({ key: 'sb-skills', root_pid: 1234 })],
        [],
    ]) {
        assert.equal(decide(ask, lane(rows, { ...parents, 'sb-skills': 'p' })), null, JSON.stringify(rows));
    }
});

test('other tools never resolve the caller', () => {
    let asked = false;
    const probe = () => {
        asked = true;
        return { key: 'k', parent: 'p' };
    };
    assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'ls' } }, probe), null);
    assert.equal(asked, false);
});

test('the parent is read from the lineage record and unsafe keys are refused', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'lineage-'));
    const dir = path.join(base, 'qol-tray', 'sessions', 'lineage');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'lane-1.json'), JSON.stringify({ child: 'lane-1', parent: 'arch', recorded_at_ms: 1 }));
    fs.writeFileSync(path.join(dir, 'blank.json'), JSON.stringify({ child: 'blank', parent: '' }));
    assert.equal(recordedParent('lane-1', base), 'arch');
    for (const key of ['blank', 'missing', '..', '../lineage/lane-1', 'a b']) {
        assert.equal(recordedParent(key, base), null, key);
    }
    fs.rmSync(base, { recursive: true, force: true });
});

test('the data directory follows the platform', () => {
    assert.equal(dataDir({}, '/h', 'linux'), path.join('/h', '.local', 'share'));
    assert.equal(dataDir({ XDG_DATA_HOME: '/x' }, '/h', 'linux'), '/x');
    assert.equal(dataDir({}, '/h', 'darwin'), path.join('/h', 'Library', 'Application Support'));
    assert.equal(dataDir({ LOCALAPPDATA: 'C:\\L' }, '/h', 'win32'), 'C:\\L');
});
