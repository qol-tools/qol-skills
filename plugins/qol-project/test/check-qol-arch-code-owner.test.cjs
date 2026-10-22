'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'check-qol-arch-code.cjs');
const { lintFile } = require(HOOK);
const { osViolations, callViolations, textViolations } = require(path.join(__dirname, '..', 'bin', 'qol-owner-guard.cjs'));

const OWNERS = {
    os: {
        owner: 'libs/platform/src/os/',
        use: 'qol_platform::Os',
        names: ['linux', 'macos', 'windows'],
        labels: ['Linux', 'macOS', 'Windows'],
        allow: [{ path: 'plugins/demo/src/registry.rs', text: 'Windows', why: 'registry key' }],
    },
    'window chrome': {
        owner: ['libs/gpui/src/popup_window/platform/', 'libs/gpui/src/platform/'],
        use: 'a chrome entry point the Surface calls before the window shows',
        calls: ['setHasShadow', 'setStyleMask', 'DwmSetWindowAttribute', 'override_redirect'],
        entry_points: ['disable_window_shadow', 'square_window_corners'],
        allow: [{ path: 'libs/gpui/src/popup_window/platform/windows.rs', text: 'cloak', why: 'cloaking hides the window' }],
    },
    'desktop settings': {
        owner: 'libs/desktop-settings/src/',
        use: 'qol_desktop_settings::gsettings',
        texts: ['gsettings'],
        allow: [{ path: 'plugins/demo/src/doctor.rs', text: 'gsettings', why: 'the doctor reports where the binary is' }],
    },
    'qol folders': {
        owner: 'libs/config/src/',
        use: 'qol_config::cache_dir',
        paths: ['dirs::cache_dir', 'dirs::data_dir'],
        allow: [{ path: 'plugins/demo/src/legacy.rs', text: 'dirs::cache_dir', why: 'moves the old file' }],
    },
};

const OWNER = {
    owner: OWNERS.os.owner,
    use: OWNERS.os.use,
    text: new Set([...OWNERS.os.names, ...OWNERS.os.labels]),
    allow: [],
};
const AT = 'plugins/demo/src/lib.rs';
const check = src => osViolations(AT, src, OWNER);

function run(payload) {
    const result = spawnSync('node', [HOOK], { input: JSON.stringify(payload), encoding: 'utf8' });
    return { exitCode: result.status, stderr: result.stderr };
}

function repo({ rulebook = true } = {}) {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-hook-'));
    const root = path.join(temp, 'qol-monorepo');
    fs.mkdirSync(path.join(root, '.git'), { recursive: true });
    if (rulebook) {
        fs.mkdirSync(path.join(root, '.qac'));
        fs.writeFileSync(path.join(root, '.qac', 'owners.json'), JSON.stringify(OWNERS));
    }
    const crate = path.join(root, 'plugins', 'demo');
    fs.mkdirSync(path.join(crate, 'src'), { recursive: true });
    fs.writeFileSync(path.join(crate, 'Cargo.toml'), '[package]\nname = "qol-demo"\nversion = "0.1.0"\n');
    return root;
}

function place(root, relative, content) {
    const file = path.join(root, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (content !== undefined) fs.writeFileSync(file, content);
    return file;
}

function write(file, content) {
    return run({ tool_name: 'Write', tool_input: { file_path: file, content }, cwd: path.dirname(file) });
}

const LIST = 'pub const PLATFORMS: [&str; 3] = ["linux", "macos", "windows"];\n';

const refused = [
    ['the #174 list', LIST, 3],
    ['compare with the std constant', 'fn f(p: &str) -> bool { p == std::env::consts::OS }', 1],
    ['renamed import', 'use std::env::consts::OS as HOST;', 1],
    ['module import then use', "use std::env::consts;\nfn f() -> &'static str { consts::OS }", 1],
    ['renamed module', "use std::env::consts as c;\nfn f() -> &'static str { c::OS }", 1],
    ['glob import', 'use std::env::consts::*;', 1],
    ['brace import', 'use std::env::consts::{ARCH, OS};', 1],
    ['multi-line brace import then use', "use std::env::{\n    consts,\n    var,\n};\nfn f() -> &'static str { consts::OS }", 1],
    ['runtime cfg!', 'fn f() -> bool { cfg!(target_os = "macos") }', 1],
    ['multi-line cfg!', 'fn f() -> bool {\n    cfg!(any(\n        target_os = "linux",\n        target_os = "macos"\n    ))\n}', 1],
    ['env! build variable', 'const OS: &str = env!("CARGO_CFG_TARGET_OS");', 1],
    ['build script variable', 'fn main() { let _ = std::env::var("CARGO_CFG_TARGET_OS"); }', 1],
    ['name inside a macro', 'fn f() -> String { format!("{}", "linux") }', 1],
    ['raw string', 'const W: &str = r#"windows"#;', 1],
    ['byte string', 'const L: &[u8] = b"linux";', 1],
    ['serde rename attribute', '#[serde(rename = "macos")]\nstruct M;', 1],
    ['display label', 'const L: &str = "Windows";', 1],
    ['macOS label', 'const L: &str = "macOS";', 1],
    ['match arm', 'fn f(s: &str) -> u8 { match s { "linux" => 1, _ => 0 } }', 1],
    ['after a quote char literal', "fn f() { let _c = '\"'; let _s = \"linux\"; }", 1],
    ['after a lifetime', "fn f<'a>(_x: &'a str) -> &'a str { \"macos\" }", 1],
];

const allowed = [
    ['cfg attribute', '#[cfg(target_os = "linux")]\nmod linux;'],
    ['cfg any attribute', '#[cfg(any(target_os = "linux", target_os = "macos"))]\nmod unix;'],
    ['inner cfg attribute', '#![cfg(target_os = "windows")]'],
    ['cfg_attr', '#[cfg_attr(target_os = "macos", allow(dead_code))]\nfn f() {}'],
    ['cfg_if', 'cfg_if::cfg_if! { if #[cfg(target_os = "linux")] { fn f() {} } }'],
    ['line comment', '// reads "linux" here\nfn f() {}'],
    ['nested block comment', '/* "windows" /* "macos" */ still comment */ fn f() {}'],
    ['doc comment', '/// returns "linux"\nfn f() {}'],
    ['toml test text in a raw string', 'const T: &str = r#"platforms = ["linux", "windows"]"#;'],
    ['target triple', 'const T: &str = "x86_64-unknown-linux-gnu";'],
    ['mac bundle folder', 'const D: &str = "MacOS"; const P: &str = "Contents/MacOS";'],
    ['word inside a sentence', 'const S: &str = "close all windows";'],
    ['escaped quotes', 'const S: &str = "say \\"linux\\"";'],
    ['cpu constant', 'const A: &str = std::env::consts::ARCH;'],
    ['exe suffix', 'fn f() -> String { format!("git{}", std::env::consts::EXE_SUFFIX) }'],
    ['brace import without OS', 'use std::env::consts::{ARCH, EXE_SUFFIX};'],
    ['windows subsystem attribute', '#![windows_subsystem = "windows"]'],
    ['identifier named linux', 'mod linux; fn f() { linux::run() }'],
];

for (const [name, src, n] of refused) {
    test(`refused: ${name}`, () => assert.equal(check(src).length, n, JSON.stringify(check(src))));
}

for (const [name, src] of allowed) {
    test(`allowed: ${name}`, () => assert.deepEqual(check(src), []));
}

test('line numbers survive a string line continuation', () => {
    const src = 'const A: &str = "one \\\ntwo";\nconst B: &str = "linux";';
    assert.deepEqual(check(src).map(v => v.line), [3]);
});

test('line numbers survive a multi-line raw string', () => {
    const src = 'const A: &str = r#"\none\n"#;\nconst B: &str = "linux";';
    assert.deepEqual(check(src).map(v => v.line), [4]);
});

test('the owner folder may name the OS', () => {
    const src = 'pub const ALL: [&str; 3] = ["linux", "macos", "windows"]; pub fn current() -> &\'static str { std::env::consts::OS }';
    assert.deepEqual(osViolations('libs/platform/src/os/mod.rs', src, OWNER), []);
});

test('known gap: a name split on purpose is not caught', () => {
    assert.equal(check('const L: &str = concat!("li", "nux");').length, 0);
});

test('blocks the #174 list on Write', () => {
    const file = place(repo(), 'plugins/demo/src/platform.rs');
    const r = write(file, LIST);
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /OS name typed as text: "linux"/);
    assert.match(r.stderr, /use: qol_platform::Os/);
    assert.match(r.stderr, /Enforcement: owner guard/);
});

test('blocks an OS name added by an Edit', () => {
    const file = place(repo(), 'plugins/demo/src/lib.rs', 'pub fn host() -> &\'static str {\n    "unknown"\n}\n');
    const r = run({
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: '"unknown"', new_string: '"windows"' },
        cwd: path.dirname(file),
    });
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /OS name typed as text: "windows"/);
});

test('blocks an OS name in an integration test', () => {
    const file = place(repo(), 'plugins/demo/tests/resolver.rs');
    const r = write(file, '#[test]\nfn windows_only() {\n    assert!(supports(&["windows"]));\n}\n');
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /OS name typed as text: "windows"/);
});

test('blocks an OS name in a #[cfg(test)] module', () => {
    const file = place(repo(), 'plugins/demo/src/lib.rs');
    const r = write(file, '#[cfg(test)]\nmod tests {\n    const P: &str = "linux";\n}\n');
    assert.equal(r.exitCode, 2);
});

test('passes an edit that leaves existing uses alone', () => {
    const file = place(repo(), 'plugins/demo/src/lib.rs', `${LIST}pub fn one() -> u8 {\n    1\n}\n`);
    const r = run({
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: '    1\n', new_string: '    2\n' },
        cwd: path.dirname(file),
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('blocks one more copy of an existing use', () => {
    const file = place(repo(), 'plugins/demo/src/lib.rs', 'const A: &str = "linux";\n');
    const r = write(file, 'const A: &str = "linux";\nconst B: &str = "linux";\n');
    assert.equal(r.exitCode, 2);
});

test('passes the owner folder', () => {
    const file = place(repo(), 'libs/platform/src/os/mod.rs');
    const r = write(file, `${LIST}pub fn current() -> &'static str { std::env::consts::OS }\n`);
    assert.equal(r.exitCode, 0, r.stderr);
});

test('passes an exception the rulebook lists', () => {
    const file = place(repo(), 'plugins/demo/src/registry.rs');
    const r = write(file, 'pub fn key(base: &Path) -> PathBuf { base.join("Windows") }\n');
    assert.equal(r.exitCode, 0, r.stderr);
});

test('the exception holds only for its file', () => {
    const file = place(repo(), 'plugins/demo/src/other.rs');
    const r = write(file, 'pub fn key(base: &Path) -> PathBuf { base.join("Windows") }\n');
    assert.equal(r.exitCode, 2);
});

test('does nothing without a rulebook', () => {
    const file = place(repo({ rulebook: false }), 'plugins/demo/src/platform.rs');
    const r = write(file, LIST);
    assert.equal(r.exitCode, 0, r.stderr);
});

test('does nothing with an unreadable rulebook', () => {
    const root = repo({ rulebook: false });
    place(root, '.qac/owners.json', '{ not json');
    const r = write(place(root, 'plugins/demo/src/platform.rs'), LIST);
    assert.equal(r.exitCode, 0, r.stderr);
});

test('passes vendored code', () => {
    const file = place(repo(), 'vendor/gpui/src/platform.rs');
    const r = write(file, LIST);
    assert.equal(r.exitCode, 0, r.stderr);
});

test('a bypass marker passes one edit and then relocks', () => {
    const root = repo();
    const file = place(root, 'plugins/demo/src/platform.rs');
    place(root, '.claude/bypass-qol-arch-code', '');
    assert.equal(write(file, LIST).exitCode, 0);
    assert.equal(fs.existsSync(path.join(root, '.claude', 'bypass-qol-arch-code')), false);
    assert.equal(write(file, LIST).exitCode, 2);
});

test('lint reports every use without a base', () => {
    const file = place(repo(), 'plugins/demo/src/platform.rs', LIST);
    const messages = lintFile(file, LIST);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /platform\.rs:1 OS name typed as text: "linux"/);
});

test('lint with a base reports only what the change added', () => {
    const file = place(repo(), 'plugins/demo/src/platform.rs');
    const after = `${LIST}const L: &str = "Linux";\n`;
    const messages = lintFile(file, after, LIST);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /"Linux"/);
    assert.doesNotMatch(messages[0], /"linux"/);
});

test('an earlier filter still fires first', () => {
    const file = place(repo(), 'plugins/demo/src/lib.rs');
    const r = write(file, 'compile_error!("linux");\n');
    assert.equal(r.exitCode, 2);
});

const CHROME = {
    concept: 'window chrome',
    folders: OWNERS['window chrome'].owner,
    use: OWNERS['window chrome'].use,
    calls: OWNERS['window chrome'].calls,
    entryPoints: new Set(OWNERS['window chrome'].entry_points),
    allow: OWNERS['window chrome'].allow.map(item => `${item.path}\0${item.text}`),
};
const MACOS = 'libs/gpui/src/popup_window/platform/macos.rs';
const chrome = (src, at = MACOS) => callViolations(at, src, CHROME);
const PR_210 = 'fn show_window_by_title_with_focus(title: &str) -> bool {\n    window.setLevel(level);\n    if notice {\n        window.setHasShadow(false);\n    }\n    true\n}\n';
const ENTRY = 'pub fn disable_window_shadow(title: &str) -> bool {\n    window.setHasShadow(false);\n    true\n}\n';

const chromeRefused = [
    ['the #210 show function', PR_210, 1],
    ['a closure inside a show function', 'fn show(w: &W) { run(move || w.setHasShadow(false)); }', 1],
    ['a function nested in an entry point', 'fn disable_window_shadow() { fn inner(w: &W) { w.setHasShadow(false); } }', 1],
    ['a free function call', 'fn hide(h: HWND) { unsafe { DwmSetWindowAttribute(h, 1, p, 4); } }', 1],
    ['a builder method', 'fn grab(c: &C) { let aux = Aux::new().override_redirect(1); }', 1],
    ['two calls in one function', 'fn show(w: &W) { w.setHasShadow(false); w.setStyleMask(m); }', 2],
    ['an entry point name with a suffix', 'fn disable_window_shadow_now(w: &W) { w.setHasShadow(false); }', 1],
    ['an array return type before the body', 'fn show(w: &W) -> [u8; 2] { w.setHasShadow(false); [0, 0] }', 1],
];

const chromeAllowed = [
    ['an entry point', ENTRY],
    ['an entry point after a trait method without a body', 'trait T { fn show(&self); }\n' + ENTRY],
    ['a comment', 'fn show(w: &W) { /* w.setHasShadow(false) */ }'],
    ['a string', 'fn show() -> &\'static str { "setHasShadow(false)" }'],
    ['the definition of a function with that name', 'fn setHasShadow(flag: bool) {}'],
    ['a longer identifier', 'fn show(c: &C, w: u32) -> bool { window_is_override_redirect(c, w) }'],
    ['an import', 'use windows_sys::Win32::Graphics::Dwm::{DwmSetWindowAttribute, DWMWA_CLOAK};'],
    ['a function the rulebook allows', 'fn cloak(h: HWND) { unsafe { DwmSetWindowAttribute(h, 1, p, 4); } }'],
];

for (const [name, src, n] of chromeRefused) {
    test(`chrome refused: ${name}`, () => assert.equal(chrome(src).length, n, JSON.stringify(chrome(src))));
}

const WINDOWS = 'libs/gpui/src/popup_window/platform/windows.rs';

for (const [name, src] of chromeAllowed) {
    test(`chrome allowed: ${name}`, () => assert.deepEqual(chrome(src, src.includes('fn cloak') ? WINDOWS : MACOS), []));
}

test('chrome names the call and the function', () => {
    const [violation] = chrome(PR_210);
    assert.equal(violation.line, 4);
    assert.equal(violation.what, 'window chrome set by setHasShadow in fn show_window_by_title_with_focus');
});

test('an entry point outside the owner folders is refused', () => {
    assert.equal(chrome(ENTRY, 'libs/gpui/src/surface/mod.rs').length, 1);
});

test('the allowed function holds only for its file', () => {
    assert.equal(chrome('fn cloak(h: HWND) { unsafe { DwmSetWindowAttribute(h, 1, p, 4); } }').length, 1);
});

test('chrome in vendored code passes', () => {
    assert.deepEqual(chrome(PR_210, 'vendor/gpui/src/platform/mac/window.rs'), []);
});

test('blocks the #210 shadow call on Write', () => {
    const file = place(repo(), MACOS);
    const r = write(file, PR_210);
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /window chrome set by setHasShadow in fn show_window_by_title_with_focus/);
    assert.match(r.stderr, /use: a chrome entry point the Surface calls/);
    assert.match(r.stderr, /Enforcement: owner guard/);
});

test('passes moving the shadow call into its entry point', () => {
    const file = place(repo(), MACOS, PR_210);
    const r = write(file, ENTRY);
    assert.equal(r.exitCode, 0, r.stderr);
});

test('passes an edit beside an existing chrome call', () => {
    const file = place(repo(), MACOS, PR_210);
    const r = run({
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: '    true\n', new_string: '    false\n' },
        cwd: path.dirname(file),
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('lint reports existing chrome calls without a base', () => {
    const file = place(repo(), MACOS, PR_210);
    const messages = lintFile(file, PR_210);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /macos\.rs:4 window chrome set by setHasShadow/);
});

test('a rulebook without an os entry still guards chrome', () => {
    const root = repo({ rulebook: false });
    place(root, '.qac/owners.json', JSON.stringify({ 'window chrome': OWNERS['window chrome'] }));
    const file = place(root, MACOS);
    assert.equal(write(file, PR_210).exitCode, 2);
    assert.equal(write(place(root, 'plugins/demo/src/platform.rs'), LIST).exitCode, 0);
});

const ownedBy = concept => ({
    concept,
    folders: [OWNERS[concept].owner].flat(),
    use: OWNERS[concept].use,
    calls: [],
    entryPoints: new Set(),
    texts: new Set(OWNERS[concept].texts || []),
    paths: OWNERS[concept].paths || [],
    allow: OWNERS[concept].allow.map(item => `${item.path}\0${item.text}`),
});
const SETTINGS = ownedBy('desktop settings');
const FOLDERS = ownedBy('qol folders');
const settings = (src, at = AT) => textViolations(at, src, SETTINGS);
const folders = (src, at = AT) => textViolations(at, src, FOLDERS);
const RUN = 'fn theme() -> Output {\n    Command::new("gsettings").args(["get", SCHEMA, KEY]).output().unwrap()\n}\n';
const PICK = 'fn store() -> Option<PathBuf> {\n    dirs::cache_dir()\n}\n';

const settingsRefused = [
    ['a command', RUN, 1],
    ['a raw string', 'const TOOL: &str = r#"gsettings"#;', 1],
    ['a test module', '#[cfg(test)]\nmod tests {\n    #[test]\n    fn t() { let _ = "gsettings"; }\n}', 1],
    ['two runs', RUN + RUN.replace('fn theme', 'fn tone'), 2],
];

const settingsAllowed = [
    ['a longer string', 'const S: &str = "gsettings get failed";'],
    ['a comment', '// runs gsettings\nfn f() {}'],
    ['an identifier', 'fn gsettings(args: &[&str]) {}'],
    ['the owner module', 'use qol_desktop_settings::gsettings;\nfn f() { let _ = gsettings::get("a", "b"); }'],
];

for (const [name, src, n] of settingsRefused) {
    test(`text refused: ${name}`, () => assert.equal(settings(src).length, n, JSON.stringify(settings(src))));
}

for (const [name, src] of settingsAllowed) {
    test(`text allowed: ${name}`, () => assert.deepEqual(settings(src), []));
}

test('a text names the concept and the literal', () => {
    const [violation] = settings(RUN);
    assert.equal(violation.line, 2);
    assert.equal(violation.what, 'desktop settings outside its owner: "gsettings"');
});

test('the owner folder may use its texts', () => {
    assert.deepEqual(settings(RUN, 'libs/desktop-settings/src/gsettings.rs'), []);
});

test('a text exception holds only for its file', () => {
    assert.deepEqual(settings(RUN, 'plugins/demo/src/doctor.rs'), []);
    assert.equal(settings(RUN, 'plugins/demo/src/tone.rs').length, 1);
});

const foldersRefused = [
    ['a call', PICK, 1],
    ['the path as a value', 'fn p() -> Option<PathBuf> { dirs::data_local_dir().or_else(dirs::data_dir) }', 1],
    ['a brace import', 'use dirs::{cache_dir, home_dir};', 1],
    ['a multi-line brace import', 'use dirs::{\n    home_dir,\n    data_dir,\n};', 1],
    ['spaces around the separator', 'fn p() -> Option<PathBuf> { dirs :: cache_dir() }', 1],
    ['two paths', 'fn p() { let _ = (dirs::cache_dir(), dirs::data_dir()); }', 2],
];

const foldersAllowed = [
    ['another function of the module', 'fn p() -> Option<PathBuf> { dirs::home_dir() }'],
    ['a longer identifier', 'fn p() -> Option<PathBuf> { dirs::cache_dir_v2() }'],
    ['a module ending in the same name', 'fn p() -> Option<PathBuf> { qol_dirs::cache_dir() }'],
    ['the owner function', 'fn p() -> Option<PathBuf> { qol_config::cache_dir() }'],
    ['a comment', '// was dirs::cache_dir()\nfn f() {}'],
    ['a string', 'const S: &str = "dirs::cache_dir";'],
    ['a brace import without the name', 'use dirs::{home_dir, download_dir};'],
];

for (const [name, src, n] of foldersRefused) {
    test(`path refused: ${name}`, () => assert.equal(folders(src).length, n, JSON.stringify(folders(src))));
}

for (const [name, src] of foldersAllowed) {
    test(`path allowed: ${name}`, () => assert.deepEqual(folders(src), []));
}

test('a path names the concept and the path', () => {
    const [violation] = folders(PICK);
    assert.equal(violation.line, 2);
    assert.equal(violation.what, 'qol folders outside its owner: dirs::cache_dir');
});

test('the owner folder may use its paths', () => {
    assert.deepEqual(folders(PICK, 'libs/config/src/lib.rs'), []);
});

test('a path exception holds only for its file and path', () => {
    const src = 'fn p() { let _ = (dirs::cache_dir(), dirs::data_dir()); }';
    assert.deepEqual(folders(src, 'plugins/demo/src/legacy.rs').map(violation => violation.what), [
        'qol folders outside its owner: dirs::data_dir',
    ]);
});

test('blocks a new gsettings run on Write', () => {
    const file = place(repo(), 'plugins/demo/src/tone.rs');
    const r = write(file, RUN);
    assert.equal(r.exitCode, 2);
    assert.match(r.stderr, /desktop settings outside its owner: "gsettings"/);
    assert.match(r.stderr, /use: qol_desktop_settings::gsettings/);
});

test('passes an edit beside an existing folder pick', () => {
    const file = place(repo(), 'plugins/demo/src/store.rs', PICK);
    const r = run({
        tool_name: 'Edit',
        tool_input: { file_path: file, old_string: 'fn store()', new_string: 'fn store_path()' },
        cwd: path.dirname(file),
    });
    assert.equal(r.exitCode, 0, r.stderr);
});

test('lint reports existing folder picks without a base', () => {
    const file = place(repo(), 'plugins/demo/src/store.rs', PICK);
    const messages = lintFile(file, PICK);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /store\.rs:2 qol folders outside its owner: dirs::cache_dir/);
});

test('an entry without calls, texts or paths guards nothing', () => {
    const root = repo({ rulebook: false });
    place(root, '.qac/owners.json', JSON.stringify({ 'desktop settings': { ...OWNERS['desktop settings'], texts: [] } }));
    assert.equal(write(place(root, 'plugins/demo/src/tone.rs'), RUN).exitCode, 0);
});
