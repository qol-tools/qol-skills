'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const layers = require('../bin/module-layers.cjs');

const HOOK = path.join(__dirname, '..', 'bin', 'check-qol-arch-code.cjs');
const SKILL = path.join(__dirname, '..', 'skills', 'qol-arch-code', 'SKILL.md');

const FILES = {
    'Cargo.toml': '[workspace]\nmembers = ["libs/*", "plugins/*", "apps/*"]\n',
    'libs/conventions/Cargo.toml': '[package]\nname = "qol-conventions"\n',
    'libs/conventions/src/lib.rs': [
        'pub mod build;',
        'pub mod routes;',
        'pub const ENV_HTTP_TOKEN: &str = "QOL_HTTP_TOKEN";',
        'pub const ENV_DAEMON_SOCKET: &str = "QOL_DAEMON_SOCKET";',
        'pub mod api_routes {',
        '    pub fn plugin_query(id: &str) -> String {',
        '        format!("/api/plugins/{id}")',
        '    }',
        '}',
        'pub mod names {',
        '    pub const TRAY: &str = "qol-tray";',
        '}',
        '',
    ].join('\n'),
    'libs/conventions/src/routes.rs': 'pub const CORE: &str = "/api/core";\n',
    'libs/conventions/src/build/mod.rs': [
        'pub fn emit() {',
        '    println!("cargo:rustc-env=QOL_PLUGIN_ID={}", 1);',
        '    println!("cargo:rustc-env=QOL_DAEMON_PORT={}", 2);',
        '}',
        '',
    ].join('\n'),
    'libs/config/Cargo.toml': '[package]\nname = "qol-config"\n',
    'libs/config/src/lib.rs': 'pub mod env;\npub mod inspection;\n',
    'libs/config/src/env.rs': [
        'pub fn token() -> String {',
        '    std::env::var(qol_conventions::ENV_HTTP_TOKEN).unwrap_or_default()',
        '}',
        '',
    ].join('\n'),
    'libs/config/src/inspection/mod.rs': [
        'use crate::env::token;',
        'pub fn inspect() -> String {',
        '    wrapped()',
        '}',
        'fn wrapped() -> String {',
        '    token()',
        '}',
        'pub fn pure() -> u8 {',
        '    1',
        '}',
        '',
    ].join('\n'),
    'libs/config/src/bin/tool.rs': 'fn main() { let _ = qol_conventions::ENV_HTTP_TOKEN; }\n',
    'libs/http/Cargo.toml': '[package]\nname = "qol-http"\n',
    'libs/http/src/lib.rs': [
        'pub fn post(id: &str) -> String {',
        '    qol_conventions::api_routes::plugin_query(id)',
        '}',
        'pub fn via_config() -> String {',
        '    qol_config::inspection::inspect()',
        '}',
        '',
    ].join('\n'),
    'libs/daemon/Cargo.toml': '[package]\nname = "qol-plugin-daemon"\n',
    'libs/daemon/src/lib.rs': 'pub mod daemon;\npub mod wire;\n',
    'libs/daemon/src/daemon/mod.rs': [
        'pub fn socket() -> Option<String> {',
        '    std::env::var(qol_conventions::ENV_DAEMON_SOCKET).ok()',
        '}',
        '',
    ].join('\n'),
    'libs/daemon/src/wire.rs': 'pub fn frame() -> u8 {\n    1\n}\n',
    'libs/plain/Cargo.toml': 'name = "no-package-table"\n',
    'libs/plain/src/lib.rs': 'pub fn f() {}\n',
    'plugins/demo/Cargo.toml': '[package]\nname = "qol-demo"\n',
    'plugins/demo/plugin.toml': '[plugin]\nid = "qol-demo"\n\n[action.open]\nrun = "open"\n\n[action.reload]\nrun = "reload"\n',
    'plugins/demo/qol-runtime.toml': '[query.devices]\nlabel = "Devices"\n\n[action.toggle]\nlabel = "Toggle"\n',
    'plugins/demo/src/lib.rs': 'pub mod app;\nmod config;\nmod feature;\nmod ui;\n',
    'plugins/demo/src/config/mod.rs': [
        'pub fn load() -> String {',
        '    qol_config::inspection::inspect()',
        '}',
        'pub fn save() -> String {',
        '    load()',
        '}',
        'pub fn defaults() -> u8 {',
        '    1',
        '}',
        '',
    ].join('\n'),
    'plugins/demo/src/app/mod.rs': [
        'use crate::config::load;',
        'pub fn port() -> String {',
        '    load()',
        '}',
        '',
    ].join('\n'),
    'plugins/demo/src/ui/mod.rs': 'pub fn draw() -> String {\n    crate::app::port()\n}\n',
    'plugins/demo/src/bin/extra.rs': 'fn main() {}\n',
    'plugins/broken/Cargo.toml': '[package]\nname = "qol-broken"\n',
    'plugins/broken/plugin.toml': '[action\nbroken',
    'plugins/broken/src/lib.rs': 'mod feature;\n',
    'apps/tray/Cargo.toml': '[package]\nname = "qol-tray"\n',
    'apps/tray/src/main.rs': 'fn main() {}\n',
    'tools/cli/Cargo.toml': '[package]\nname = "qol-cli"\n',
    'tools/cli/src/main.rs': 'fn main() {}\n',
};

function workspace(files = FILES) {
    const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qac-layers-')), 'qol-monorepo');
    for (const [relative, content] of Object.entries(files)) {
        const file = path.join(root, ...relative.split('/'));
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
    return root;
}

const ROOT = workspace();

function found(relative, content, root = ROOT) {
    return layers.findings(path.join(root, ...relative.split('/')), content)
        .map(finding => `${finding.rule}@${finding.line}`);
}

const VOCABULARY = layers.parseVocabulary(fs.readFileSync(SKILL, 'utf8'));

test('vocabulary: the skill table names every layer', () => {
    assert.ok(VOCABULARY);
    for (const name of ['cli', 'app', 'daemon', 'runtime', 'doctor', 'qol', 'plugin', 'adapter']) assert.ok(VOCABULARY.adapter.has(name), name);
    assert.deepEqual([...VOCABULARY.presentation], ['ui']);
    assert.deepEqual([...VOCABULARY.config], ['config']);
    assert.deepEqual([...VOCABULARY.platform], ['platform']);
});

test('vocabulary: no block or an empty row reads as no table', () => {
    assert.equal(layers.parseVocabulary('no table here'), null);
    assert.equal(layers.parseVocabulary(null), null);
    const partial = '<!-- module-layers:start -->\n| adapter | `cli` |\n| presentation | `ui` |\n| config | `config` |\n| platform | none |\n<!-- module-layers:end -->';
    assert.equal(layers.parseVocabulary(partial), null);
});

const LAYERS = [
    [[], 'root'],
    [['cli'], 'adapter'],
    [['daemon', 'ws', 'platform', 'unix'], 'adapter'],
    [['ui', 'platform'], 'presentation'],
    [['feature', 'platform', 'linux'], 'platform'],
    [['config', 'platform'], 'platform'],
    [['config', 'paths'], 'config'],
    [['feature'], 'capability'],
];

for (const [segments, layer] of LAYERS) {
    test(`layer: ${segments.join('/') || 'crate root'} is ${layer}`, () => {
        assert.equal(layers.layerOf(segments, VOCABULARY), layer);
    });
}

test('segments: crate roots, mod.rs folders and files', () => {
    assert.deepEqual(layers.moduleSegments(['lib.rs']), []);
    assert.deepEqual(layers.moduleSegments(['main.rs']), []);
    assert.deepEqual(layers.moduleSegments(['feature', 'mod.rs']), ['feature']);
    assert.deepEqual(layers.moduleSegments(['feature', 'scan.rs']), ['feature', 'scan']);
    assert.deepEqual(layers.moduleSegments(['feature', 'lib.rs']), ['feature', 'lib']);
});

const CASES = [
    ['upward: a capability imports the adapter', 'plugins/demo/src/feature/mod.rs', 'use crate::app::port;\n', ['upward-import@1']],
    ['upward: a use group names the adapter', 'plugins/demo/src/feature/mod.rs', 'use crate::{app, config};\n', ['upward-import@1']],
    ['upward: a nested group head names presentation', 'plugins/demo/src/feature/mod.rs', 'use crate::{ui::{draw}, config::load};\n', ['upward-import@1']],
    ['upward: a super chain climbs to the root', 'plugins/demo/src/feature/deep/mod.rs', 'fn f() {\n    super::super::ui::draw();\n}\n', ['upward-import@2', 'host-call@2']],
    ['upward: a super that stays inside the module passes', 'plugins/demo/src/feature/deep/mod.rs', 'use super::ui;\n', []],
    ['upward: pub(in crate::app) is visibility', 'plugins/demo/src/feature/mod.rs', 'pub(in crate::app) fn f() {}\n', []],
    ['upward: config may not reach the adapter', 'plugins/demo/src/config/paths.rs', 'use crate::app::port;\n', ['upward-import@1']],
    ['upward: platform may not reach presentation', 'plugins/demo/src/feature/platform/linux.rs', 'use crate::ui::draw;\n', ['upward-import@1']],
    ['upward: the adapter may reach presentation', 'plugins/demo/src/app/run.rs', 'use crate::ui::draw;\n', []],
    ['upward: presentation may reach the adapter', 'plugins/demo/src/ui/panel.rs', 'use crate::app::port;\n', []],
    ['upward: a capability may reach config and capabilities', 'plugins/demo/src/feature/mod.rs', 'use crate::config::defaults;\nuse crate::other::x;\n', []],
    ['upward: two names on one line report once each', 'plugins/demo/src/feature/mod.rs', 'use crate::{app, app::port};\n', ['upward-import@1']],
    ['upward: test code passes', 'plugins/demo/src/feature/mod.rs', '#[cfg(test)]\nmod tests {\n    use crate::app::port;\n}\n', []],
    ['upward: a lib crate is out of scope', 'libs/http/src/feature/mod.rs', 'use crate::cli::x;\n', []],
    ['upward: the tray is out of scope', 'apps/tray/src/features/x.rs', 'use crate::daemon::x;\n', []],
    ['platform: pub mod below the root', 'plugins/demo/src/feature/mod.rs', 'pub mod platform;\n', ['platform-visibility@1']],
    ['platform: pub(crate) mod below the root', 'plugins/demo/src/feature/mod.rs', 'mod scan;\npub(crate) mod platform;\n', ['platform-visibility@2']],
    ['platform: pub(super) inline module', 'libs/http/src/feature/mod.rs', 'pub(super) mod platform {\n}\n', ['platform-visibility@1']],
    ['platform: private and pub(self) pass', 'plugins/demo/src/feature/mod.rs', 'mod platform;\npub(self) mod platform_two;\npub(self) mod platform;\n', []],
    ['platform: other pub modules pass', 'plugins/demo/src/feature/mod.rs', 'pub mod scan;\n', []],
    ['platform: the crate root may expose it', 'plugins/demo/src/lib.rs', 'pub mod platform;\n', []],
    ['root: a plugin lib.rs holds a function', 'plugins/demo/src/lib.rs', 'mod app;\n\nfn helper() {}\n', ['root-composition@3']],
    ['root: types, impls and statics', 'plugins/demo/src/lib.rs', 'pub struct Shape;\nimpl Shape {}\npub(crate) static COUNT: u8 = 0;\nenum Kind { A }\n', ['root-composition@1', 'root-composition@2', 'root-composition@3', 'root-composition@4']],
    ['root: an attribute and modifiers before the item', 'plugins/demo/src/lib.rs', '#[derive(Debug)]\npub unsafe trait Marker {}\n', ['root-composition@2']],
    ['root: main.rs may hold fn main', 'plugins/demo/src/main.rs', 'use std::process::ExitCode;\n\nfn main() -> ExitCode {\n    ExitCode::SUCCESS\n}\n', []],
    ['root: main.rs holds another function', 'plugins/demo/src/main.rs', 'fn main() {}\n\nfn other() {}\n', ['root-composition@3']],
    ['root: lib.rs fn main is still code', 'plugins/demo/src/lib.rs', 'pub fn main() {}\n', ['root-composition@1']],
    ['root: composition only', 'plugins/demo/src/lib.rs', 'pub mod app;\npub use app::port;\npub(crate) const PLUGIN_ID: &str = env!("QOL_PLUGIN_ID");\n', []],
    ['root: nested items are not root items', 'plugins/demo/src/lib.rs', 'mod inline {\n    fn hidden() {}\n}\nconst F: fn() = {\n    fn inner() {}\n    inner\n};\n', []],
    ['root: an app crate', 'apps/tray/src/main.rs', 'fn main() {}\nfn scrub() {}\n', ['root-composition@2']],
    ['root: a lib crate is out of scope', 'libs/http/src/lib.rs', 'pub fn post() {}\n', []],
    ['root: a tool crate is out of scope', 'tools/cli/src/main.rs', 'fn main() {}\nfn other() {}\n', []],
    ['root: test items pass', 'plugins/demo/src/lib.rs', 'mod app;\n#[cfg(test)]\nmod tests {\n    fn helper() {}\n}\n', []],
    ['host: an injected env name', 'plugins/demo/src/feature/mod.rs', 'fn f() {\n    let _ = std::env::var(qol_conventions::ENV_HTTP_TOKEN);\n}\n', ['host-call@2']],
    ['host: an env name through an import', 'plugins/demo/src/feature/mod.rs', 'use qol_conventions::ENV_HTTP_TOKEN;\nfn f() {\n    let _ = std::env::var(ENV_HTTP_TOKEN);\n}\n', ['host-call@1', 'host-call@3']],
    ['host: a known ENV name counts once the file names qol_conventions, an unknown one passes', 'plugins/demo/src/feature/mod.rs', 'const ENV_HTTP_TOKEN: &str = "x";\nfn f() {\n    let _ = qol_conventions::ENV_OTHER;\n    let _ = ENV_HTTP_TOKEN;\n}\n', ['host-call@1', 'host-call@4']],
    ['host: an env name without qol_conventions passes', 'plugins/demo/src/feature/mod.rs', 'const ENV_HTTP_TOKEN: &str = "x";\n', []],
    ['host: an inline route module', 'plugins/demo/src/feature/mod.rs', 'fn f() -> String {\n    qol_conventions::api_routes::plugin_query("x")\n}\n', ['host-call@2']],
    ['host: a route module file', 'plugins/demo/src/feature/mod.rs', 'fn f() -> &\'static str {\n    qol_conventions::routes::CORE\n}\n', ['host-call@2']],
    ['host: a non-route conventions module passes', 'plugins/demo/src/feature/mod.rs', 'fn f() -> &\'static str {\n    qol_conventions::names::TRAY\n}\n', []],
    ['host: a lib function two files from the env read', 'plugins/demo/src/feature/mod.rs', 'fn f() -> String {\n    qol_config::inspection::inspect()\n}\n', ['host-call@2']],
    ['host: a lib function across crates', 'plugins/demo/src/feature/mod.rs', 'fn f() -> String {\n    qol_http::via_config()\n}\n', ['host-call@2']],
    ['host: a lib function through an import', 'plugins/demo/src/feature/mod.rs', 'use qol_http::post;\nfn f() -> String {\n    post("x")\n}\n', ['host-call@3']],
    ['host: a lib function that reads nothing passes', 'plugins/demo/src/feature/mod.rs', 'fn f() -> u8 {\n    qol_config::inspection::pure()\n}\n', []],
    ['host: a same-named method or definition passes', 'plugins/demo/src/feature/mod.rs', 'fn inspect() {}\nfn f(x: X) {\n    x.inspect();\n    inspect();\n}\n', []],
    ['host: a lib binary is not a host function', 'plugins/demo/src/feature/mod.rs', 'fn f() {\n    tool::main();\n}\n', []],
    ['host: a config function of the crate', 'plugins/demo/src/feature/mod.rs', 'fn f() -> String {\n    crate::config::load()\n}\n', ['host-call@2']],
    ['host: a crate function that calls one', 'plugins/demo/src/feature/mod.rs', 'use crate::config::save;\nfn f() -> String {\n    save()\n}\n', ['host-call@3']],
    ['host: an adapter function through super', 'plugins/demo/src/feature/mod.rs', 'use super::app::port;\nfn f() -> String {\n    port()\n}\n', ['upward-import@1', 'host-call@3']],
    ['host: a crate function that reads nothing passes', 'plugins/demo/src/feature/mod.rs', 'fn f() -> u8 {\n    crate::config::defaults()\n}\n', []],
    ['host: the platform layer', 'plugins/demo/src/feature/platform/linux.rs', 'fn f() -> String {\n    crate::config::load()\n}\n', ['host-call@2']],
    ['host: presentation may load config', 'plugins/demo/src/ui/panel.rs', 'fn f() -> String {\n    crate::config::load()\n}\n', []],
    ['host: config may read the host', 'plugins/demo/src/config/paths.rs', 'fn f() -> String {\n    qol_config::inspection::inspect()\n}\n', []],
    ['host: the adapter may read the host', 'plugins/demo/src/app/run.rs', 'fn f() -> String {\n    qol_config::inspection::inspect()\n}\n', []],
    ['host: a lib crate is out of scope', 'libs/http/src/feature/mod.rs', 'fn f() -> String {\n    qol_config::inspection::inspect()\n}\n', []],
    ['action: a match on two plugin.toml actions', 'plugins/demo/src/feature/mod.rs', 'fn f(id: &str) -> u8 {\n    match id {\n        "open" => 1,\n        "reload" => 2,\n        _ => 0,\n    }\n}\n', ['action-table@2']],
    ['action: runtime queries and actions with | and guards', 'plugins/demo/src/feature/mod.rs', 'fn f(id: &str, on: bool) -> u8 {\n    match id {\n        "devices" | "other" => 1,\n        "toggle" if on => 2,\n        _ => 0,\n    }\n}\n', ['action-table@2']],
    ['action: one id passes', 'plugins/demo/src/feature/mod.rs', 'fn f(id: &str) -> u8 {\n    match id {\n        "open" => 1,\n        _ => 0,\n    }\n}\n', []],
    ['action: ids as values, not patterns, pass', 'plugins/demo/src/feature/mod.rs', 'fn f(n: u8) -> &\'static str {\n    match n {\n        1 => "open",\n        _ => "reload",\n    }\n}\n', []],
    ['action: ids in a nested block, not arms, pass', 'plugins/demo/src/feature/mod.rs', 'fn f(n: u8) {\n    match n {\n        1 => g(["open", "reload"]),\n        _ => {}\n    }\n}\n', []],
    ['action: the adapter may match ids', 'plugins/demo/src/app/run.rs', 'fn f(id: &str) -> u8 {\n    match id {\n        "open" => 1,\n        "reload" => 2,\n        _ => 0,\n    }\n}\n', []],
    ['action: the crate root may match ids', 'plugins/demo/src/main.rs', 'fn main() {\n    match id() {\n        "open" => 1,\n        "reload" => 2,\n        _ => 0,\n    };\n}\n', []],
    ['action: a plugin.toml that does not parse has no ids', 'plugins/broken/src/feature/mod.rs', 'fn f(id: &str) -> u8 {\n    match id {\n        "open" => 1,\n        "reload" => 2,\n        _ => 0,\n    }\n}\n', []],
    ['daemon: a path into the daemon module', 'plugins/demo/src/feature/mod.rs', 'use qol_plugin_daemon::daemon::socket;\n', ['daemon-transport@1']],
    ['daemon: a use group head', 'plugins/demo/src/feature/mod.rs', 'use qol_plugin_daemon::{daemon::socket, wire};\n', ['daemon-transport@1']],
    ['daemon: other modules of the crate pass', 'plugins/demo/src/feature/mod.rs', 'use qol_plugin_daemon::wire::frame;\nuse qol_plugin_daemon::{wire};\n', []],
    ['daemon: the adapter may use it', 'plugins/demo/src/app/run.rs', 'use qol_plugin_daemon::daemon::socket;\n', []],
    ['daemon: presentation may not', 'plugins/demo/src/ui/panel.rs', 'use qol_plugin_daemon::daemon::socket;\n', ['daemon-transport@1']],
    ['manifest: env! outside the root', 'plugins/demo/src/app/run.rs', 'const ID: &str = env!("QOL_PLUGIN_ID");\n', ['manifest-env@1']],
    ['manifest: option_env! of the daemon port', 'libs/http/src/feature/mod.rs', 'const PORT: Option<&str> = option_env!("QOL_DAEMON_PORT");\n', ['manifest-env@1']],
    ['manifest: once in the root passes', 'plugins/demo/src/lib.rs', 'pub(crate) const PLUGIN_ID: &str = env!("QOL_PLUGIN_ID");\npub(crate) const PORT: &str = env!("QOL_DAEMON_PORT");\n', []],
    ['manifest: twice in the root', 'plugins/demo/src/lib.rs', 'pub(crate) const A: &str = env!("QOL_PLUGIN_ID");\npub(crate) const B: &str = env!("QOL_PLUGIN_ID");\n', ['manifest-env@2']],
    ['manifest: other variables and plain strings pass', 'plugins/demo/src/app/run.rs', 'const N: &str = env!("CARGO_PKG_NAME");\nconst S: &str = "QOL_PLUGIN_ID";\n', []],
    ['scope: a src/bin file is not a module', 'plugins/demo/src/bin/extra.rs', 'use crate::app::port;\nconst ID: &str = env!("QOL_PLUGIN_ID");\n', []],
    ['scope: a file outside src is not a module', 'plugins/demo/build.rs', 'const ID: &str = env!("QOL_PLUGIN_ID");\n', []],
    ['scope: a crate without a package table', 'libs/plain/src/feature/mod.rs', 'pub mod platform;\n', []],
    ['scope: not a Rust file', 'plugins/demo/src/feature/notes.md', 'use crate::app::port;\n', []],
    ['scope: empty content', 'plugins/demo/src/feature/mod.rs', '', []],
];

for (const [name, relative, content, expected] of CASES) {
    test(`layers: ${name}`, () => {
        assert.deepEqual(found(relative, content), expected);
    });
}

test('layers: a file outside any crate', () => {
    const lone = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qac-lone-')), 'src', 'feature.rs');
    assert.deepEqual(layers.findings(lone, 'pub mod platform;\n'), []);
});

test('layers: a crate outside a workspace keeps the rules that need no workspace', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qac-alone-'));
    fs.writeFileSync(path.join(root, 'Cargo.toml'), '[package]\nname = "alone"\n');
    fs.writeFileSync(path.join(root, 'plugin.toml'), '[action.open]\n[action.reload]\n');
    const file = path.join(root, 'src', 'feature', 'mod.rs');
    const content = 'use crate::app::x;\npub mod platform;\nconst ID: &str = env!("QOL_PLUGIN_ID");\nfn f(id: &str) {\n    match id {\n        "open" => {}\n        "reload" => {}\n        _ => {}\n    }\n}\n';
    assert.deepEqual(layers.findings(file, content).map(finding => finding.rule), ['upward-import', 'platform-visibility']);
});

test('layers: a workspace without conventions has no host rules', () => {
    const root = workspace({
        'Cargo.toml': '[workspace]\n',
        'plugins/demo/Cargo.toml': '[package]\nname = "qol-demo"\n',
        'plugins/demo/plugin.toml': '[plugin]\nid = "qol-demo"\n',
        'plugins/demo/src/lib.rs': 'mod feature;\n',
    });
    const content = 'fn f() {\n    let _ = qol_conventions::ENV_HTTP_TOKEN;\n    let _ = qol_plugin_daemon::daemon::socket();\n}\nconst ID: &str = env!("QOL_PLUGIN_ID");\n';
    assert.deepEqual(found('plugins/demo/src/feature/mod.rs', content, root), []);
});

test('layers: the message names the line, the file and the section', () => {
    const [finding] = layers.findings(path.join(ROOT, 'plugins', 'demo', 'src', 'feature', 'mod.rs'), 'use crate::app::port;\n');
    assert.match(finding.message, /^Upward module import in mod\.rs: on line 1, a capability module reaches crate::app, the adapter layer/);
    assert.match(finding.message, /\n\[qol-arch-code\] fix it in this edit \(qol-project:qol-arch-code, "Enforcement: module layers"\)$/);
});

test('layers: resetCaches reads a changed workspace again', () => {
    const root = workspace();
    const relative = 'plugins/demo/src/feature/mod.rs';
    const content = 'fn f() -> u8 {\n    qol_config::inspection::pure()\n}\n';
    assert.deepEqual(found(relative, content, root), []);
    fs.writeFileSync(path.join(root, 'libs', 'config', 'src', 'inspection', 'mod.rs'), 'pub fn pure() -> u8 {\n    crate::env::token().len() as u8\n}\n');
    assert.deepEqual(found(relative, content, root), []);
    layers.resetCaches();
    assert.deepEqual(found(relative, content, root), ['host-call@2']);
});

function hook(file, content) {
    const result = spawnSync('node', [HOOK], {
        input: JSON.stringify({ tool_name: 'Write', tool_input: { file_path: file, content }, cwd: ROOT }),
        encoding: 'utf8',
    });
    return { exitCode: result.status, stderr: result.stderr };
}

test('hook: an edit that leaves a finding is denied with each message', () => {
    const file = path.join(ROOT, 'plugins', 'demo', 'src', 'feature', 'mod.rs');
    const result = hook(file, 'use crate::app::port;\npub mod platform;\n');
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /Upward module import in mod\.rs: on line 1/);
    assert.match(result.stderr, /Exposed platform module in mod\.rs: on line 2/);
    assert.match(result.stderr, /\[qol-arch-code\] fix it in this edit/);
});

test('hook: a clean edit and a test file pass', () => {
    assert.equal(hook(path.join(ROOT, 'plugins', 'demo', 'src', 'feature', 'mod.rs'), 'use crate::config::defaults;\n').exitCode, 0);
    assert.equal(hook(path.join(ROOT, 'plugins', 'demo', 'src', 'feature', 'tests.rs'), 'use crate::app::port;\n').exitCode, 0);
});

test('hook: a bypass lets one edit through', () => {
    fs.mkdirSync(path.join(ROOT, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, '.claude', 'bypass-qol-arch-code'), '');
    const file = path.join(ROOT, 'plugins', 'demo', 'src', 'feature', 'mod.rs');
    assert.equal(hook(file, 'use crate::app::port;\n').exitCode, 0);
    assert.equal(hook(file, 'use crate::app::port;\n').exitCode, 2);
});

test('lint: qac reports every finding of a file', () => {
    const { lintFile } = require(HOOK);
    const file = path.join(ROOT, 'plugins', 'demo', 'src', 'feature', 'mod.rs');
    const messages = lintFile(file, 'use crate::app::port;\nconst ID: &str = env!("QOL_PLUGIN_ID");\n', 'use crate::app::port;\n');
    assert.equal(messages.length, 2);
    assert.match(messages[0], /Upward module import in mod\.rs: on line 1/);
    assert.match(messages[1], /Manifest value read outside the crate root in mod\.rs: on line 2/);
});
