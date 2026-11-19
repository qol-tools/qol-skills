'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'check-qol-arch-code.cjs');
const { lintFile } = require(HOOK);
const { osViolations, callViolations, textViolations, loadEntryOwners, ownerViolations } = require(path.join(__dirname, '..', 'bin', 'qol-owner-guard.cjs'));

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

const LIVENESS = {
    owner: 'libs/process/src/',
    use: 'qol_process::is_pid_gone',
    calls: ['is_pid_alive'],
    entry_points: [],
    allow: [],
};
const PROBE = 'pub fn running(pid: u32) -> bool {\n    is_pid_alive(pid)\n}\n';
const TESTED = 'pub fn live() {}\n\n#[cfg(test)]\nmod tests {\n    fn running(pid: u32) -> bool {\n        is_pid_alive(pid)\n    }\n}\n';

test('an entry scoped to production passes test code and test files', () => {
    const root = repo({ rulebook: false });
    place(root, '.qac/owners.json', JSON.stringify({ liveness: { ...LIVENESS, scope: 'production' } }));
    const refused = write(place(root, 'plugins/demo/src/watch.rs'), PROBE);
    assert.equal(refused.exitCode, 2);
    assert.match(refused.stderr, /liveness set by is_pid_alive in fn running/);
    assert.equal(write(place(root, 'plugins/demo/src/tested.rs'), TESTED).exitCode, 0);
    place(root, 'plugins/demo/src/feature/mod.rs', '#[cfg(test)]\nmod fixtures;\n');
    assert.equal(write(place(root, 'plugins/demo/src/feature/fixtures.rs'), PROBE).exitCode, 0);
});

test('an entry without a scope guards test code too', () => {
    const root = repo({ rulebook: false });
    place(root, '.qac/owners.json', JSON.stringify({ liveness: LIVENESS }));
    assert.equal(write(place(root, 'plugins/demo/src/tested.rs'), TESTED).exitCode, 2);
});

const NAMED = {
    concept: 'process liveness',
    folders: ['libs/process/src/'],
    use: 'qol_process::is_pid_gone',
    calls: [],
    entryPoints: new Set(),
    texts: new Set(),
    paths: ['is_pid_alive', 'is_pid_zombie'],
    allow: [],
};
const named = (src, at = AT) => textViolations(at, src, NAMED);

const namedRefused = [
    ['a call through the owner', 'fn f(pid: u32) -> bool { qol_process::is_pid_alive(pid) }', 1],
    ['a call through a re-export', 'fn f(pid: i32) -> bool { crate::process::is_pid_alive(pid) }', 1],
    ['the name passed as a value', 'fn f(pid: i64) -> bool { u32::try_from(pid).is_ok_and(qol_process::is_pid_alive) }', 1],
    ['a brace import', 'use qol_process::{is_pid_alive, kill_pid};', 1],
    ['a wrapper of the same name', 'pub fn is_pid_alive(pid: i32) -> bool { pid > 0 }', 1],
    ['both names in one block', 'fn f(pid: u32) -> bool { is_pid_alive(pid) && !is_pid_zombie(pid) }', 2],
    ['one name twice in one block', 'fn f(a: u32, b: u32) -> bool { is_pid_alive(a) || is_pid_alive(b) }', 2],
];

const namedAllowed = [
    ['a longer identifier', 'fn f(pid: u32) -> bool { is_pid_alive_now(pid) || was_is_pid_alive(pid) }'],
    ['the owner function', 'fn f(pid: u32) -> bool { !qol_process::is_pid_gone(pid) }'],
    ['a comment', '// was is_pid_alive(pid)\nfn f() {}'],
    ['a string', 'const S: &str = "is_pid_alive";'],
];

for (const [name, src, n] of namedRefused) {
    test(`name refused: ${name}`, () => assert.equal(named(src).length, n, JSON.stringify(named(src))));
}

for (const [name, src] of namedAllowed) {
    test(`name allowed: ${name}`, () => assert.deepEqual(named(src), []));
}

test('the owner folder may use its names', () => {
    const gone = 'pub fn is_pid_gone(pid: u32) -> bool {\n    !is_pid_alive(pid) || is_pid_zombie(pid)\n}\n';
    assert.deepEqual(named(gone, 'libs/process/src/lib.rs'), []);
});

test('a rulebook path of one name guards that name on Write', () => {
    const root = repo({ rulebook: false });
    place(root, '.qac/owners.json', JSON.stringify({
        'process liveness': { owner: 'libs/process/src/', use: 'qol_process::is_pid_gone', scope: 'production', paths: ['is_pid_alive'], allow: [] },
    }));
    const refused = write(place(root, 'plugins/demo/src/watch.rs'), 'pub fn running(pid: u32) -> bool {\n    qol_process::is_pid_alive(pid)\n}\n');
    assert.equal(refused.exitCode, 2);
    assert.match(refused.stderr, /process liveness outside its owner: is_pid_alive/);
    assert.match(refused.stderr, /use: qol_process::is_pid_gone/);
    assert.equal(write(place(root, 'plugins/demo/src/tested.rs'), TESTED).exitCode, 0);
});

const ROUTER = 'apps/tray/src/router.rs';
const VALUES = {
    concept: 'conventions values',
    folders: ['libs/conventions/src/'],
    use: 'the qol_conventions constant or route builder that holds the value',
    calls: [],
    entryPoints: new Set(),
    texts: new Set(['/api/shortcuts', 'QoL Tray']),
    prefixes: ['/api/'],
    paths: [],
    allow: [`${ROUTER}\0/api/legacy`],
};
const values = (src, at = AT) => textViolations(at, src, VALUES);

const valuesRefused = [
    ['a whole value', 'const NAME: &str = "QoL Tray";', 1],
    ['a route the owner holds', 'fn f() -> Response { get("/api/shortcuts") }', 1],
    ['a route under the prefix', 'fn f() -> Response { get("/api/core/queries/updates") }', 1],
    ['a format template under the prefix', 'fn f(name: &str) -> String { format!("/api/core/actions/{name}") }', 1],
    ['a value and a route', 'fn f() { let _ = ("QoL Tray", "/api/sync"); }', 2],
];

const valuesAllowed = [
    ['the prefix inside a longer string', 'const S: &str = "GET /api/shortcuts failed";'],
    ['a value inside a longer string', 'const S: &str = "QoL Tray Settings";'],
    ['a device path', 'const S: &str = "/dev/input/event0";'],
    ['the owner builder', 'fn f(id: &str) -> String { qol_conventions::api_routes::plugin(id) }'],
    ['a comment', '// GET /api/shortcuts\nfn f() {}'],
];

for (const [name, src, n] of valuesRefused) {
    test(`prefix refused: ${name}`, () => assert.equal(values(src).length, n, JSON.stringify(values(src))));
}

for (const [name, src] of valuesAllowed) {
    test(`prefix allowed: ${name}`, () => assert.deepEqual(values(src), []));
}

test('a prefix names the concept and the whole literal', () => {
    const [violation] = values('fn f() -> Response {\n    get("/api/sync")\n}\n');
    assert.equal(violation.line, 2);
    assert.equal(violation.what, 'conventions values outside its owner: "/api/sync"');
});

test('a prefix exception holds only for its file and literal', () => {
    const src = 'fn f() { let _ = (get("/api/legacy"), get("/api/sync")); }';
    assert.deepEqual(values(src, ROUTER).map(violation => violation.what), [
        'conventions values outside its owner: "/api/sync"',
    ]);
    assert.equal(values(src).length, 2);
});

test('the owner folder may use its prefixes', () => {
    assert.deepEqual(values('pub const SYNC: &str = "/api/sync";', 'libs/conventions/src/lib.rs'), []);
});

test('a rulebook entry with only prefixes guards them on Write', () => {
    const root = repo({ rulebook: false });
    place(root, '.qac/owners.json', JSON.stringify({
        'conventions values': { owner: 'libs/conventions/src/', use: 'qol_conventions::api_routes', scope: 'production', prefixes: ['/api/'], allow: [] },
    }));
    const refused = write(place(root, 'plugins/demo/src/client.rs'), 'pub fn sync() -> String {\n    String::from("/api/sync")\n}\n');
    assert.equal(refused.exitCode, 2);
    assert.match(refused.stderr, /conventions values outside its owner: "\/api\/sync"/);
});

const CONVENTIONS = [
    'pub const TRAY_DISPLAY_NAME: &str = "QoL Tray";',
    "pub const SOCKET_PATH: &'static str =",
    '    "/tmp/demo-state.sock";',
    'pub const DEFAULT_PORT: u16 = 42700;',
    'pub const ARG_CHECK: &str = "check";',
    'pub(crate) const INNER: &str = "inner value";',
    'const PRIVATE: &str = "private value";',
    'pub const LIST: &[&str] = &["listed value"];',
    '// pub const COMMENTED: &str = "commented value";',
    'pub mod routes {',
    '    pub const SYNC: &str = "/api/sync";',
    '}',
    '#[cfg(test)]',
    'mod tests {',
    '    pub const FIXTURE: &str = "fixture value";',
    '}',
    '',
].join('\n');

function conventionsRepo(entry) {
    const root = repo({ rulebook: false });
    place(root, '.qac/owners.json', JSON.stringify({
        'conventions values': {
            owner: 'libs/conventions/src/',
            use: 'the qol_conventions constant that holds the value',
            scope: 'production',
            const_texts: true,
            skip: [{ text: 'check', why: 'a plain word' }],
            allow: [],
            ...entry,
        },
    }));
    place(root, 'libs/conventions/src/lib.rs', CONVENTIONS);
    place(root, 'libs/conventions/src/artifact/mod.rs', 'pub const NESTED: &str = "nested value";\n');
    return root;
}

const uses = values => `pub fn uses() -> Vec<&'static str> {\n    vec![${values.map(value => JSON.stringify(value)).join(', ')}]\n}\n`;

test('const_texts guards every public str const the owner declares, read on every run', () => {
    const root = conventionsRepo();
    const refused = write(place(root, 'plugins/demo/src/client.rs'), uses(['QoL Tray', '/tmp/demo-state.sock', '/api/sync', 'nested value']));
    assert.equal(refused.exitCode, 2);
    for (const value of ['QoL Tray', '/tmp/demo-state.sock', '/api/sync', 'nested value']) {
        assert.ok(refused.stderr.includes(`conventions values outside its owner: ${JSON.stringify(value)}`), value);
    }
    place(root, 'libs/conventions/src/lib.rs', `${CONVENTIONS}pub const ADDED: &str = "added value";\n`);
    const added = write(place(root, 'plugins/demo/src/later.rs'), uses(['added value']));
    assert.equal(added.exitCode, 2);
    assert.match(added.stderr, /conventions values outside its owner: "added value"/);
});

test('const_texts leaves skipped, private, test-only and non-str values alone', () => {
    const root = conventionsRepo();
    const allowed = ['check', 'inner value', 'private value', 'listed value', 'commented value', 'fixture value', '42700'];
    const result = write(place(root, 'plugins/demo/src/client.rs'), uses(allowed));
    assert.equal(result.exitCode, 0, result.stderr);
});

test('const_texts without the flag guards nothing', () => {
    const root = conventionsRepo({ const_texts: false });
    assert.equal(write(place(root, 'plugins/demo/src/client.rs'), uses(['QoL Tray'])).exitCode, 0);
});

const NUMBER_CONSTS = [
    'pub const SPACED: u32 = 1_234_567;',
    'pub const SUFFIXED: u16 = 42_800u16;',
    'pub const UNDERSCORE_SUFFIX: u64 = 9_100_u64;',
    'pub const SCHEMA_VERSION: u32 = 1;',
    'pub const ALSO_ONE: u8 = 0_1u8;',
    'pub(crate) const INNER: u32 = 777;',
    'const PRIVATE: u32 = 778;',
    'pub const HEX: u32 = 0xA6CC;',
    'pub const FLOAT: f64 = 55.5;',
    'pub const SUM: u32 = 5 + 6;',
    '// pub const COMMENTED: u32 = 779;',
    '#[cfg(test)]',
    'mod tests {',
    '    pub const FIXTURE: u32 = 780;',
    '}',
    '',
].join('\n');

function numbersRepo(entry) {
    const root = conventionsRepo({ const_texts: false, const_numbers: true, skip: [{ text: '1', why: 'a schema version' }], ...entry });
    place(root, 'libs/conventions/src/numbers.rs', NUMBER_CONSTS);
    return root;
}

function numberFindings(root, relative, content) {
    const entries = loadEntryOwners(root);
    return ownerViolations(relative, content, null, entries, path.join(root, relative)).map(violation => {
        assert.match(violation.what, /^conventions values outside its owner: /);
        assert.equal(violation.use, 'the qol_conventions constant that holds the value');
        return violation.what.replace('conventions values outside its owner: ', '');
    });
}

const CLIENT = 'plugins/demo/src/client.rs';
const inFn = body => `pub fn port() -> u32 {\n    ${body}\n}\n`;
const inText = value => inFn(`let url = ${JSON.stringify(value)};`);

const numberTokens = [
    ['a plain literal', 'let port = 42700;', ['42700']],
    ['an underscored literal with a suffix', 'bind(42_700u16);', ['42_700u16']],
    ['a suffix after an underscore', 'bind(42700_u16);', ['42700_u16']],
    ['a suffix', 'bind(42700u16);', ['42700u16']],
    ['leading zeros are decimal', 'bind(00042700);', ['00042700']],
    ['a constant declared with underscores', 'let id = 1234567;', ['1234567']],
    ['a constant declared with a suffix', 'bind(42800);', ['42800']],
    ['a constant declared with an underscore and a suffix', 'let n = 9100;', ['9100']],
    ['the start of a range', 'for p in 42700..42800 {}', ['42700', '42800']],
    ['the end of a range', 'for p in 42000..42700 {}', ['42700']],
    ['an inclusive range', 'for p in 42700..=42800 {}', ['42700', '42800']],
    ['a method call on the literal', 'let m = 42700.max(1);', ['42700']],
    ['a match arm', 'match p { 42700 => 1, _ => 2 }', ['42700']],
    ['an array', 'let ports = [42700, 42800, 5];', ['42700', '42800']],
    ['in a macro', 'assert_eq!(p, 42_700);', ['42_700']],
];

const numberTokensLeftAlone = [
    ['inside an identifier', 'let port42700 = 3;'],
    ['inside an identifier before the digits', 'let p_42700x = 3;'],
    ['a longer number', 'let p = 427001;'],
    ['a longer number before', 'let p = 142700;'],
    ['a float', 'let p = 42700.0;'],
    ['a float with an exponent', 'let p = 42700e2;'],
    ['a float suffix', 'let p = 42700f32;'],
    ['a fraction digit', 'let p = 1.42700;'],
    ['a tuple field', 'let p = pair.42700;'],
    ['a hex literal', 'let p = 0x42700;'],
    ['the owner hex literal', 'let p = 0xA6CC;'],
    ['an octal literal', 'let p = 0o42700;'],
    ['a binary literal', 'let p = 0b101;'],
    ['a line comment', 'let p = 1; // 42700'],
    ['a doc comment', '/// the tray listens on 42700'],
    ['a block comment', '/* 42700 */ let p = 1;'],
    ['a nested block comment', '/* a /* 42700 */ 42800 */ let p = 1;'],
    ['a char literal', "let c = '7';"],
    ['a private, a pub(crate), a commented and a test-only const', 'let all = [777, 778, 779, 780];'],
    ['a float, a sum and a hex const', 'let all = [55, 5, 6, 10817];'],
    ['the skipped schema version', 'let v = 1;'],
    ['the skipped schema version with an underscore and a suffix', 'let v = 0_1u8;'],
    ['another number', 'let p = 42701;'],
];

test('const_numbers owns every public integer const, whole, as typed', () => {
    const root = numbersRepo();
    for (const [name, body, shown] of numberTokens) {
        assert.deepEqual(numberFindings(root, CLIENT, inFn(body)), shown, name);
    }
});

test('const_numbers leaves lookalikes, comments, hex, other values and the skip alone', () => {
    const root = numbersRepo();
    for (const [name, body] of numberTokensLeftAlone) {
        assert.deepEqual(numberFindings(root, CLIENT, inFn(body)), [], name);
    }
});

const numberTexts = [
    ['an address', '127.0.0.1:42700', true],
    ['an url', 'http://127.0.0.1:42700/api/mcp', true],
    ['the whole text', '42700', true],
    ['a range', 'ports 42700..42800', true],
    ['a format string', '{host}:42700', true],
    ['an underscored number', 'id 1_234_567 here', true],
    ['two copies', '127.0.0.1:42700 or localhost:42700', true],
    ['two owned numbers', '42700 and 42800', true],
    ['an escaped quote around it', 'say \\"42700\\"', true],
    ['inside an identifier', 'port42700', false],
    ['a longer number', '427001', false],
    ['a longer number before', '142700', false],
    ['a float', 'version 42700.0', false],
    ['a hex literal', '0x42700', false],
    ['another port', '127.0.0.1:42701', false],
    ['an address that holds the skipped number', '127.0.0.1', false],
    ['a version that holds the skipped number', 'v1.2.3', false],
    ['a number that is not owned', 'page 1 of 3', false],
];

test('const_numbers owns a number held whole inside a string literal, reported once as the string', () => {
    const root = numbersRepo();
    for (const [name, value, held] of numberTexts) {
        const content = inText(value);
        assert.deepEqual(numberFindings(root, CLIENT, content), held ? [JSON.stringify(value)] : [], name);
    }
});

test('const_numbers skips a number in a comment around a string and a string in a comment', () => {
    const root = numbersRepo();
    const content = '// let url = "127.0.0.1:42700";\n/* "http://x:42700" */\n';
    assert.deepEqual(numberFindings(root, CLIENT, content), []);
});

test('const_numbers owns the skip texts as normalized decimals only', () => {
    const open = numbersRepo({ skip: [] });
    assert.deepEqual(numberFindings(open, CLIENT, inFn('let v = [1, 0_1u8];')), ['1', '0_1u8']);
    assert.deepEqual(numberFindings(open, CLIENT, inText('v 1 here')), ['"v 1 here"']);
    const spaced = numbersRepo({ skip: [{ text: '1', why: 'a schema version' }, { text: '1234567', why: 'an id' }] });
    assert.deepEqual(numberFindings(spaced, CLIENT, inFn('let v = [1, 1_234_567, 42700];')), ['42700']);
});

test('const_numbers keeps the owner folders, tests and allowed files free', () => {
    const root = numbersRepo();
    const body = 'let p = 42700;\nlet url = "127.0.0.1:42700";';
    const cases = [
        ['an owner file', 'libs/conventions/src/other.rs', inFn(body), []],
        ['a nested owner file', 'libs/conventions/src/artifact/mod.rs', inFn(body), []],
        ['a test file', 'plugins/demo/tests/ports.rs', inFn(body), []],
        ['a test module', CLIENT, `${inFn('let q = 1;')}#[cfg(test)]\nmod tests {\n    fn t() {\n        let p = 42700;\n        let u = "127.0.0.1:42700";\n    }\n}\n`, []],
        ['a vendored file', 'vendor/dep/src/lib.rs', inFn(body), []],
        ['a file outside rust', 'plugins/demo/notes.md', body, []],
        ['production code', CLIENT, inFn(body), ['42700', '"127.0.0.1:42700"']],
    ];
    for (const [name, relative, content, expected] of cases) {
        assert.deepEqual(numberFindings(root, relative, content), expected, name);
    }
    const everything = numbersRepo({ scope: 'all' });
    assert.deepEqual(numberFindings(everything, 'plugins/demo/tests/ports.rs', inFn(body)), ['42700', '"127.0.0.1:42700"']);
});

test('const_numbers allow names the file and the number as plain decimal text', () => {
    const allowed = { path: CLIENT, text: '42700', why: 'the probe names the tray port' };
    const root = numbersRepo({ allow: [allowed] });
    const body = 'let a = [42700, 42_700u16, 42700..42800];\nlet u = "127.0.0.1:42700";';
    assert.deepEqual(numberFindings(root, CLIENT, inFn(body)), ['42800']);
    assert.deepEqual(numberFindings(root, 'plugins/demo/src/other.rs', inFn('let a = 42700;')), ['42700']);
    assert.deepEqual(numberFindings(root, CLIENT, inText('42700 and 42800')), ['"42700 and 42800"']);
    assert.deepEqual(numberFindings(root, CLIENT, inText('127.0.0.1:42700')), []);
    const typed = numbersRepo({ allow: [{ path: CLIENT, text: '42_700u16', why: 'typed form' }] });
    assert.deepEqual(numberFindings(typed, CLIENT, inFn('let a = 42_700u16;')), ['42_700u16']);
});

test('const_numbers without the flag guards no number', () => {
    for (const entry of [{ const_numbers: false }, { const_numbers: 'yes' }, { const_numbers: undefined }]) {
        const root = numbersRepo(entry);
        assert.deepEqual(numberFindings(root, CLIENT, inFn('let p = 42700;\nlet url = "127.0.0.1:42700";')), [], JSON.stringify(entry));
    }
});

test('const_numbers keeps const_texts and counts violations by their message', () => {
    const root = numbersRepo({ const_texts: true });
    const found = numberFindings(root, CLIENT, inFn('let p = 42700;\nlet s = "QoL Tray";'));
    assert.deepEqual(found, ['42700', '"QoL Tray"']);
});

test('const_numbers reports a string once when it is also an owned text or prefix', () => {
    const root = numbersRepo({ const_texts: true, prefixes: ['/api/'] });
    place(root, 'libs/conventions/src/address.rs', 'pub const TRAY_ADDRESS: &str = "127.0.0.1:42700";\n');
    assert.deepEqual(numberFindings(root, CLIENT, inText('127.0.0.1:42700')), ['"127.0.0.1:42700"']);
    assert.deepEqual(numberFindings(root, CLIENT, inText('/api/ports/42700')), ['"/api/ports/42700"']);
});

test('const_numbers refuses a new copy on Write, lets an existing copy stay and reads a new const on the next run', () => {
    const root = numbersRepo();
    const file = place(root, CLIENT, inFn('let p = 42700;'));
    assert.equal(write(file, `${inFn('let p = 42700;')}pub fn other() {}\n`).exitCode, 0);
    const grown = write(file, `${inFn('let p = 42700;')}pub fn again() -> u32 {\n    42_700u16 as u32\n}\n`);
    assert.equal(grown.exitCode, 2);
    assert.match(grown.stderr, /conventions values outside its owner: 42_700u16/);
    const url = write(place(root, 'plugins/demo/src/url.rs'), inText('http://127.0.0.1:42700/api/mcp'));
    assert.equal(url.exitCode, 2);
    assert.match(url.stderr, /conventions values outside its owner: "http:\/\/127\.0\.0\.1:42700\/api\/mcp"/);
    assert.equal(write(place(root, 'plugins/demo/src/free.rs'), inFn('let p = 42900;')).exitCode, 0);
    place(root, 'libs/conventions/src/numbers.rs', `${NUMBER_CONSTS}pub const ADDED: u16 = 42_900;\n`);
    const added = write(place(root, 'plugins/demo/src/later.rs'), inFn('let p = 42900;'));
    assert.equal(added.exitCode, 2);
    assert.match(added.stderr, /conventions values outside its owner: 42900/);
});

const MARKS = {
    'action marks': {
        owner: 'libs/gpui/src/',
        use: 'a kit part in libs/gpui that draws the action mark',
        paths: ['Icon::Tick', 'Icon::Close', 'pictures::chevron', 'Busy::ring'],
        calls: ['settings_action_affordance'],
        entry_points: [],
        allow: [],
    },
};
const marksRepo = () => {
    const root = repo({ rulebook: false });
    place(root, '.qac/owners.json', JSON.stringify(MARKS));
    return root;
};
const TICK = 'fn chosen(ink: u32) -> IconView {\n    icon(Icon::Tick, 12.0, ink)\n}\n';
const BUTTON = 'fn row(kit: Kit) -> Div {\n    settings_action_affordance("pair", "Pair", kit)\n}\n';
const DEFINED = 'pub fn settings_action_affordance(id: &str, label: &str, kit: Kit) -> Div {\n    div()\n}\n';

test('action marks: a plugin may not draw a mark itself', () => {
    const root = marksRepo();
    assert.equal(write(place(root, 'plugins/demo/src/menu.rs'), TICK).exitCode, 2);
    assert.equal(write(place(root, 'apps/tray/src/view.rs'), 'use qol_gpui::pictures::{chevron, image};\n').exitCode, 2);
});

test('action marks: the kit draws marks', () => {
    const root = marksRepo();
    assert.equal(write(place(root, 'libs/gpui/src/kit.rs'), TICK).exitCode, 0);
});

test('action marks: the retired row button is refused in the kit too', () => {
    const root = marksRepo();
    assert.equal(write(place(root, 'libs/gpui/src/settings_panel/pages/mod.rs'), BUTTON).exitCode, 2);
    assert.equal(write(place(root, 'apps/tray/src/view.rs'), BUTTON).exitCode, 2);
});

test('action marks: the retired definition and its existing callers pass', () => {
    const root = marksRepo();
    assert.equal(write(place(root, 'libs/gpui/src/settings_panel/components/mod.rs'), DEFINED).exitCode, 0);
    const file = place(root, 'apps/tray/src/view.rs', BUTTON);
    assert.equal(write(file, BUTTON + 'fn other() {}\n').exitCode, 0);
    assert.equal(write(file, BUTTON + BUTTON.replace('fn row', 'fn second')).exitCode, 2);
});
