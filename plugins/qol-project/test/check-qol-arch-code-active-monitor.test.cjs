'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'check-qol-arch-code.cjs');
const { lintFile } = require(HOOK);

function run(payload) {
    const result = spawnSync('node', [HOOK], {
        input: JSON.stringify(payload),
        encoding: 'utf8',
    });
    return { exitCode: result.status, stderr: result.stderr };
}

const CRATES = {
    plugin: { dir: 'plugins/plugin-fixture', name: 'plugin-fixture', plugin: true },
    kit: { dir: 'libs/gpui', name: 'qol-gpui', plugin: false },
    vendored: { dir: 'vendor/gpui', name: 'gpui', plugin: false },
};

function fixture(relativePath, content, crate = 'plugin') {
    const { dir, name, plugin } = CRATES[crate];
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-hook-'));
    const root = path.join(temp, 'qol-monorepo');
    const crateRoot = path.join(root, dir);
    const file = path.join(crateRoot, relativePath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (plugin) fs.writeFileSync(path.join(crateRoot, 'plugin.toml'), '[plugin]\nid = "fixture"\n');
    fs.writeFileSync(path.join(crateRoot, 'Cargo.toml'), `[package]\nname = "${name}"\nversion = "0.1.0"\n`);
    if (content !== undefined) fs.writeFileSync(file, content);
    return { root, file };
}

function write(file, content) {
    return run({ tool_name: 'Write', tool_input: { file_path: file, content } });
}

function body(line) {
    return `pub fn show(cx: &mut App) {\n    ${line};\n}\n`;
}

const OPEN_WINDOW = 'cx.open_window(options, |_, cx| cx.new(|_| View))';
const BUILT_MONITOR = 'let monitor = ActiveMonitor::from_bounds(saved.bounds)';
const OWN_DISPLAY = 'let monitor = window.display(cx).map(|d| ActiveMonitor::from_display(d.as_ref()))';
const RESTORED_MONITOR = 'let monitor = restored.map(|restored| ActiveMonitor::from_gpui_bounds(restored.monitor))';
const PRIMARY_DISPLAY = 'let bounds = Bounds::centered(None, size(px(400.0), px(300.0)), cx)';
const SAVED_MONITOR = 'let monitor = settings_surface().remembered_monitor(cx).or_else(|| tracker.snapshot_monitor())';
const KIT_SHOW = 'Surface::new(SurfaceKind::Panel).show_focused(&tracker, cx, build)';

test('passes a window shown through the kit with the tracker', () => {
    const { file } = fixture('src/ui/mod.rs');
    const r = write(file, body(KIT_SHOW));
    assert.equal(r.exitCode, 0, r.stderr);
});

for (const [label, line] of [
    ['gpui window opened outside the qol-gpui kit', OPEN_WINDOW],
    ['ActiveMonitor built outside qol_gpui::monitor', BUILT_MONITOR],
    ['ActiveMonitor built outside qol_gpui::monitor', OWN_DISPLAY],
    ['ActiveMonitor built outside qol_gpui::monitor', RESTORED_MONITOR],
    ['window centered on the primary display', PRIMARY_DISPLAY],
    ['saved window placement picked as the monitor', SAVED_MONITOR],
]) {
    test(`blocks ${line} in a plugin on Write`, () => {
        const { file } = fixture('src/ui/mod.rs');
        const r = write(file, body(line));
        assert.equal(r.exitCode, 2);
        assert.match(r.stderr, new RegExp(label));
        assert.match(r.stderr, /Enforcement: active-monitor guard/);
    });
}

test('passes an ActiveMonitor decoded from the signal', () => {
    const { file } = fixture('src/ui/mod.rs');
    const r = write(file, body('let monitor = ActiveMonitor::from_event(&event).or_else(|| ActiveMonitor::from_key(key))'));
    assert.equal(r.exitCode, 0, r.stderr);
});

test('passes open_window inside the qol-gpui kit', () => {
    const { file } = fixture('src/surface/mod.rs', undefined, 'kit');
    const r = write(file, body(OPEN_WINDOW));
    assert.equal(r.exitCode, 0, r.stderr);
});

test('blocks an ActiveMonitor built in kit window memory', () => {
    const { file } = fixture('src/surface/memory/mod.rs', undefined, 'kit');
    const r = write(file, body(BUILT_MONITOR));
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /ActiveMonitor built outside qol_gpui::monitor/);
});

for (const relative of ['src/monitor.rs', 'src/monitor/mod.rs']) {
    test(`passes an ActiveMonitor built in ${relative}`, () => {
        const { file } = fixture(relative, undefined, 'kit');
        const r = write(file, body(BUILT_MONITOR));
        assert.equal(r.exitCode, 0, r.stderr);
    });
}

test('blocks a primary display fallback inside the kit', () => {
    const { file } = fixture('src/surface/mod.rs', undefined, 'kit');
    const r = write(file, body(PRIMARY_DISPLAY));
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /window centered on the primary display/);
});

test('blocks saved placement picked as the monitor inside the kit', () => {
    const { file } = fixture('src/settings_panel/mod.rs', undefined, 'kit');
    const r = write(file, body(SAVED_MONITOR));
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /saved window placement picked as the monitor/);
});

test('passes bounds centered on a chosen display', () => {
    const { file } = fixture('src/ui/mod.rs');
    const r = write(file, body('let bounds = Bounds::centered(Some(display_id), size, cx)'));
    assert.equal(r.exitCode, 0, r.stderr);
});

test('passes a plugin helper that is only named open_window', () => {
    const { file } = fixture('src/ui/run.rs');
    const r = write(file, 'fn open_window(cx: &mut App) {}\n\npub fn run(cx: &mut App) {\n    open_window(cx);\n}\n');
    assert.equal(r.exitCode, 0, r.stderr);
});

test('blocks an open_window added by Edit', () => {
    const { file } = fixture('src/ui/mod.rs', body(KIT_SHOW));
    const r = run({
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: KIT_SHOW, new_string: OPEN_WINDOW },
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /gpui window opened outside the qol-gpui kit/);
});

test('passes an unrelated edit to a file with existing debt', () => {
    const { file } = fixture('src/ui/preview.rs', body(OPEN_WINDOW));
    const r = run({
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: 'pub fn show', new_string: 'pub(crate) fn show' },
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('ignores signals in comments and test modules', () => {
    const { file } = fixture('src/ui/mod.rs');
    const content = [
        `// never ${OPEN_WINDOW} here`,
        body(KIT_SHOW),
        '#[cfg(test)]',
        'mod tests {',
        '    #[test]',
        '    fn places() {',
        `        ${BUILT_MONITOR};`,
        `        ${PRIMARY_DISPLAY};`,
        '    }',
        '}',
        '',
    ].join('\n');
    const r = write(file, content);
    assert.equal(r.exitCode, 0, r.stderr);
});

for (const relative of ['tests/placement.rs', 'examples/01_window.rs']) {
    test(`ignores ${relative}`, () => {
        const { file } = fixture(relative);
        const r = write(file, body(OPEN_WINDOW));
        assert.equal(r.exitCode, 0, r.stderr);
    });
}

test('ignores vendored crates', () => {
    const { file } = fixture('src/app.rs', undefined, 'vendored');
    const r = write(file, body(PRIMARY_DISPLAY));
    assert.equal(r.exitCode, 0, r.stderr);
});

test('bypass marker passes one edit and then locks again', () => {
    const { root, file } = fixture('src/ui/mod.rs');
    const marker = path.join(root, '.claude', 'bypass-qol-arch-code');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '');
    const payload = { tool_name: 'Write', tool_input: { file_path: file, content: body(OPEN_WINDOW) }, cwd: root };
    assert.equal(run(payload).exitCode, 0);
    assert.equal(fs.existsSync(marker), false);
    assert.equal(run(payload).exitCode, 2);
});

test('lint without a base reports existing debt', () => {
    const content = body(OPEN_WINDOW);
    const { file } = fixture('src/ui/preview.rs', content);
    const messages = lintFile(file, content);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /gpui window opened outside the qol-gpui kit/);
});

test('lint against an unchanged base reports nothing', () => {
    const content = body(OPEN_WINDOW);
    const { file } = fixture('src/ui/preview.rs', content);
    assert.deepEqual(lintFile(file, content, content), []);
});

test('the settings guard still fires first', () => {
    const { file } = fixture('src/config/mod.rs');
    const r = write(file, body(`let _ = qol_config::plugin_config_paths(&[ID]); ${OPEN_WINDOW}`));
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /Enforcement: settings guard/);
});

test('later checks still fire when no window is placed', () => {
    const { file } = fixture('src/ui/mod.rs');
    const r = write(file, 'compile_error!("unsupported");\n');
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /compile_error!/);
});
