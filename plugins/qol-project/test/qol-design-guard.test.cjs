'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'check-qol-arch-code.cjs');
const GUARD = path.join(__dirname, '..', 'bin', 'qol-design-guard.cjs');

const THEME = `pub const HEIGHT_INLINE: f32 = 28.0;
pub const HEIGHT_CONTROL: f32 = 36.0;
pub const HEIGHT_SETTING_ROW: f32 = 52.0;
pub const HEIGHT_LADDER: [f32; 3] = [
    HEIGHT_INLINE,
    HEIGHT_CONTROL,
    HEIGHT_SETTING_ROW,
];
pub const LIST_ENTRY_HEIGHTS: [f32; 1] = [32.0];
pub const RADIUS_CONTROL: f32 = 6.0;
pub const RADIUS_LADDER: [f32; 1] = [RADIUS_CONTROL];
pub const SPACE_INSET: f32 = 8.0;
pub const SPACE_PAD: f32 = 16.0;
pub const SPACE_LADDER: [f32; 2] = [
    SPACE_INSET,
    SPACE_PAD,
];
`;

const COMPLIANT_PAGE = `use gpui::*;
use qol_gpui::settings_panel::{intent, settings_list, SettingsGroupHeader, CustomSettingsBreadcrumbs};

impl CustomSettingsBreadcrumbs for PeersView {
    fn settings_hints(&self) -> Option<CustomHints> {
        Some(CustomHints { question: None, left: vec![SettingsHint::new(Key::ENTER, "open")], right: Vec::new() })
    }
}

impl PeersView {
    fn on_key(&mut self, key: &str) {
        match intent(key, None, false) {
            _ => {}
        }
    }

    fn render_list(&self) -> AnyElement {
        let range = self.list.visible_range(3);
        settings_list()
            .child(SettingsGroupHeader::new("peers", Some("computers you linked".into()), kit()))
            .child(settings_value_group())
            .child(kit().scroll_cue(ScrollSource::Window { first: range.start, shown: range.len(), total: 3 }, kit().grounds.pane))
            .into_any_element()
    }
}
`;

const FLAT_PAGE = `use gpui::*;

impl CustomSettingsBreadcrumbs for PeersView {
    fn settings_breadcrumbs(&self) -> Vec<SettingsDestination> {
        Vec::new()
    }
}

impl PeersView {
    fn on_key(&mut self, key: &str) {
        match key {
            "up" => {}
            _ => {}
        }
    }

    fn render(&self) -> Div {
        settings_page().child(settings_label_group("Refresh", None, ground, kit()))
    }
}
`;

function workspace() {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-design-'));
    const root = path.join(temp, 'qol-monorepo');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    fs.mkdirSync(path.join(root, 'libs', 'theme', 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'libs', 'theme', 'src', 'lib.rs'), THEME);
    return root;
}

function place(root, relative, content) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (content !== undefined) fs.writeFileSync(file, content);
    return file;
}

function write(root, relative, content, existing) {
    const file = place(root, relative, existing);
    const result = spawnSync('node', [HOOK], {
        input: JSON.stringify({ tool_name: 'Write', cwd: root, tool_input: { file_path: file, content } }),
        encoding: 'utf8',
    });
    return { exitCode: result.status, stderr: result.stderr };
}

function edit(root, relative, existing, oldString, newString) {
    const file = place(root, relative, existing);
    const result = spawnSync('node', [HOOK], {
        input: JSON.stringify({
            tool_name: 'Edit',
            cwd: root,
            tool_input: { file_path: file, old_string: oldString, new_string: newString },
        }),
        encoding: 'utf8',
    });
    return { exitCode: result.status, stderr: result.stderr };
}

const SURFACE = 'plugins/fixture/src/ui/panel/view.rs';
const SETTINGS = 'apps/tray/src/settings_surface/platform/native_tools/peers/view.rs';

for (const [label, line, use] of [
    ['a hand animation', 'Animation::new(Duration::from_millis(200))', 'Motion::'],
    ['a hand hover', 'div().hover(|style| style)', 'kit.pointable'],
    ['a hand text size', 'div().text_size(px(13.0))', 'TextStyle::'],
    ['a hand font family', 'div().font_family("Inter")', 'TextStyle::'],
    ['a key spelled as a string', 'kit.hint("enter", "open")', 'qol_gpui::Key'],
    ['a colour literal', 'div().bg(rgb(0x1a1b1e))', 'kit.grounds'],
    ['an off-ladder height', 'div().h(px(44.0))', 'HEIGHT_'],
    ['an off-ladder radius', 'div().rounded(px(5.0))', 'RADIUS_'],
    ['a hand opacity', 'div().opacity(0.5)', 'OPACITY_'],
    ['a hand shadow', 'let shadow = BoxShadow { blur_radius: px(4.0) };', 'SHADOW_'],
    ['a running ellipsis', 'settings_label("Loading peers...", kit())', 'qol_gpui::Busy'],
]) {
    test(`blocks ${label} in a gpui surface and names the replacement`, () => {
        const root = workspace();
        const r = write(root, SURFACE, `use gpui::*;\nfn draw() {\n    ${line};\n}\n`);
        assert.strictEqual(r.exitCode, 2, r.stderr);
        assert.match(r.stderr, /design violation/);
        assert.ok(r.stderr.includes(use), `expected "${use}" in:\n${r.stderr}`);
    });
}

test('passes a gpui surface built from theme tokens and kit parts', () => {
    const root = workspace();
    const r = write(root, SURFACE, `use gpui::*;
fn draw(kit: Kit) -> Div {
    div()
        .h(px(qol_theme::HEIGHT_CONTROL))
        .h(px(36.0))
        .rounded(px(qol_theme::RADIUS_CONTROL))
        .bg(kit.grounds.pane.bg)
        .text(TextStyle::Label)
        .opacity(qol_theme::OPACITY_REST)
        .child(kit.hint(Key::ENTER, "open"))
        .with_animation("fade", qol_gpui::motion::animation(Motion::FADE), |el, t| el)
}
`);
    assert.strictEqual(r.exitCode, 0, r.stderr);
});

test('blocks rem spacing helpers and off-ladder spacing only in settings scope', () => {
    const root = workspace();
    const settings = write(root, 'apps/tray/src/settings_surface/platform/native_tools/peers/model.rs', 'fn draw() { div().gap_2().px(px(10.0)); }\n');
    assert.strictEqual(settings.exitCode, 2, settings.stderr);
    assert.match(settings.stderr, /uses \.gap_2\(\)/);
    assert.match(settings.stderr, /sets px to 10/);
    assert.match(settings.stderr, /SPACE_\*/);

    const elsewhere = write(root, SURFACE, 'fn draw() { div().gap_2().px(px(10.0)); }\n');
    assert.strictEqual(elsewhere.exitCode, 0, elsewhere.stderr);
});

test('blocks leaf styling and raw palette reads in a core settings page', () => {
    const root = workspace();
    const r = write(root, 'apps/tray/src/settings_surface/platform/native_tools/peers/row.rs', 'fn draw(kit: Kit) { div().bg(kit.palette.surface_raised); }\n');
    assert.strictEqual(r.exitCode, 2, r.stderr);
    assert.match(r.stderr, /styles a leaf with \.bg\(/);
    assert.match(r.stderr, /reads kit\.palette\.surface_raised/);
});

test('blocks a core settings page that skips the shared page structure', () => {
    const root = workspace();
    const r = write(root, SETTINGS, FLAT_PAGE);
    assert.strictEqual(r.exitCode, 2, r.stderr);
    for (const expected of ['settings_list()', 'SettingsGroupHeader::new', 'settings_value_group()', 'settings_hints', 'intent(']) {
        assert.ok(r.stderr.includes(expected), `expected "${expected}" in:\n${r.stderr}`);
    }
});

test('passes a core settings page with list, group headers, values, hints and intents', () => {
    const root = workspace();
    const r = write(root, SETTINGS, COMPLIANT_PAGE);
    assert.strictEqual(r.exitCode, 0, r.stderr);
});

const CRUMB_PAGE = COMPLIANT_PAGE.replace(
    'impl CustomSettingsBreadcrumbs for PeersView {\n',
    'impl CustomSettingsBreadcrumbs for PeersView {\n    fn settings_breadcrumbs(&self) -> Vec<SettingsDestination> {\n        match self.level {\n            Level::Main => Vec::new(),\n            Level::Peer => SettingsDestination::new("peer").ok().into_iter().collect(),\n        }\n    }\n',
);

test('blocks a core settings page that opens a deeper level in place of its rows', () => {
    const root = workspace();
    const r = write(root, SETTINGS, CRUMB_PAGE);
    assert.strictEqual(r.exitCode, 2, r.stderr);
    assert.match(r.stderr, /opens a deeper level in place of its own rows/);
    assert.match(r.stderr, /deck::render\(kit, card, DeckFrame/);
});

test('passes a core settings page that draws its deeper level as a deck card', () => {
    const root = workspace();
    const decked = CRUMB_PAGE.replace(
        '            .into_any_element()\n',
        '            .into_any_element();\n        deck::render(kit(), self.card(), self.frame()).into_any_element()\n',
    );
    const r = write(root, SETTINGS, decked);
    assert.strictEqual(r.exitCode, 0, r.stderr);
});

test('passes a core settings page whose breadcrumbs stay empty without a deck', () => {
    const root = workspace();
    const r = write(root, SETTINGS, COMPLIANT_PAGE.replace(
        'impl CustomSettingsBreadcrumbs for PeersView {\n',
        'impl CustomSettingsBreadcrumbs for PeersView {\n    fn settings_breadcrumbs(&self) -> Vec<SettingsDestination> {\n        Vec::new()\n    }\n',
    ));
    assert.strictEqual(r.exitCode, 0, r.stderr);
});

test('does not block an unrelated edit to a file with existing design debt', () => {
    const root = workspace();
    const r = edit(root, SETTINGS, FLAT_PAGE, 'Vec::new()', 'vec![]');
    assert.strictEqual(r.exitCode, 0, r.stderr);
});

test('blocks an edit that adds a second copy of existing debt', () => {
    const root = workspace();
    const existing = 'use gpui::*;\nfn draw() {\n    div().hover(|s| s);\n}\n';
    const r = edit(root, SURFACE, existing, '    div().hover(|s| s);\n', '    div().hover(|s| s);\n    div().hover(|s| s);\n');
    assert.strictEqual(r.exitCode, 2, r.stderr);
});

test('ignores Rust tests and files outside the gpui surface roots', () => {
    const root = workspace();
    assert.strictEqual(write(root, 'plugins/fixture/src/ui/view_tests.rs', 'fn t() { div().hover(|s| s); }\n').exitCode, 0);
    assert.strictEqual(write(root, 'plugins/fixture/tests/view.rs', 'fn t() { div().hover(|s| s); }\n').exitCode, 0);
    assert.strictEqual(write(root, 'libs/peers/src/lib.rs', 'fn t() { div().hover(|s| s); }\n').exitCode, 0);
});

for (const [label, css, use] of [
    ['a hex colour', '.peer { color: #e0ac3f; }', 'var(--'],
    ['an rgba literal', '.peer { background: rgba(0, 0, 0, 0.4); }', 'rgba(var(--accent-rgb), a)'],
    ['a literal font size', '.peer {\n    font-size: 13px;\n}', 'var(--qol-text-'],
    ['a literal font family', '.peer {\n    font-family: "Inter", sans-serif;\n}', 'var(--font-sans)'],
    ['a literal transition time', '.peer {\n    transition: opacity 180ms ease;\n}', 'var(--qol-motion-'],
    ['a literal shadow', '.peer {\n    box-shadow: 0 2px 4px var(--shadow);\n}', 'var(--qol-shadow-float)'],
    ['a coloured side line', '.peer {\n    border-left: 3px solid var(--accent);\n}', 'never a coloured side line'],
]) {
    test(`blocks ${label} in web settings CSS`, () => {
        const root = workspace();
        const r = write(root, 'apps/tray/ui/styles/linked-computers.css', `${css}\n`);
        assert.strictEqual(r.exitCode, 2, r.stderr);
        assert.ok(r.stderr.includes(use), `expected "${use}" in:\n${r.stderr}`);
    });
}

test('passes web settings CSS built from tokens', () => {
    const root = workspace();
    const r = write(root, 'apps/tray/ui/styles/linked-computers.css', `.peer {
    color: var(--text-muted);
    background: rgba(var(--accent-rgb), 0.08);
    font-size: var(--qol-text-detail-size);
    font-family: var(--font-mono);
    transition: opacity var(--qol-motion-quick) ease;
    box-shadow: var(--qol-shadow-raised);
}
`);
    assert.strictEqual(r.exitCode, 0, r.stderr);
});

test('blocks bare prose, h3 headings and static inline styles in a web settings view', () => {
    const root = workspace();
    const r = write(root, 'apps/tray/ui/views/peers/view.js', [
        'export const View = () => html`<div>',
        '    <p>Linked</p>',
        '    <h3>Pairing requests</h3>',
        '    <p class="peer-id" style="overflow-wrap:anywhere">${id}</p>',
        '</div>`;',
        '',
    ].join('\n'));
    assert.strictEqual(r.exitCode, 2, r.stderr);
    assert.match(r.stderr, /a bare <p>/);
    assert.match(r.stderr, /an <h3> heading/);
    assert.match(r.stderr, /style="overflow-wrap:anywhere"/);
    assert.match(r.stderr, /section-header/);
});

test('passes a web settings view built from sections, classed parts and dynamic styles', () => {
    const root = workspace();
    const r = write(root, 'apps/tray/ui/views/peers/view.js', [
        'export const View = () => html`<section class="peers-section">',
        '    <div class="section-header"><h2>Linked computers</h2></div>',
        '    <p class="peers-empty">No linked computers yet.</p>',
        '    <div class="thumb" style="left:${x}px"></div>',
        '</section>`;',
        '',
    ].join('\n'));
    assert.strictEqual(r.exitCode, 0, r.stderr);
});

test('the design bypass marker lets one edit through and is consumed', () => {
    const root = workspace();
    const marker = path.join(root, '.claude', 'bypass-qol-design');
    fs.mkdirSync(path.dirname(marker), { recursive: true });
    fs.writeFileSync(marker, '');
    const first = write(root, SURFACE, 'fn draw() { div().hover(|s| s); }\n');
    assert.strictEqual(first.exitCode, 0, first.stderr);
    assert.strictEqual(fs.existsSync(marker), false);
    const second = write(root, SURFACE, 'fn draw() { div().hover(|s| s); }\n');
    assert.strictEqual(second.exitCode, 2, second.stderr);
});

test('the scan command passes a compliant page and flags a non-compliant one', () => {
    const root = workspace();
    place(root, SETTINGS, COMPLIANT_PAGE);
    const clean = spawnSync('node', [GUARD, root, 'apps/tray/src'], { encoding: 'utf8' });
    assert.strictEqual(clean.status, 0, clean.stdout);
    assert.match(clean.stdout, /1 files scanned, 1 pass, 0 flagged/);

    place(root, 'apps/tray/src/settings_surface/platform/native_tools/flat/view.rs', FLAT_PAGE);
    const flagged = spawnSync('node', [GUARD, root, 'apps/tray/src'], { encoding: 'utf8' });
    assert.strictEqual(flagged.status, 1, flagged.stdout);
    assert.match(flagged.stdout, /FLAG apps\/tray\/src\/settings_surface\/platform\/native_tools\/flat\/view\.rs/);
    assert.match(flagged.stdout, /2 files scanned, 1 pass, 1 flagged/);
});
