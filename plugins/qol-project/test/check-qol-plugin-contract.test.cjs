'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'check-qol-plugin-contract.cjs');

const SCHEMA = `use std::collections::HashMap;
use serde::Deserialize;

#[derive(Deserialize)]
pub struct PluginManifest {
    pub plugin: PluginInfo,
    #[serde(default)]
    pub runtime: Option<RuntimeConfig>,
    #[serde(default)]
    pub daemon: Option<DaemonConfig>,
    #[serde(default, rename = "action")]
    pub actions: HashMap<String, ActionDecl>,
    #[serde(default)]
    pub capabilities: Capabilities,
    #[serde(default)]
    pub shortcuts: Vec<ShortcutDeclaration>,
    #[serde(default)]
    pub menu: Menu,
    #[serde(default)]
    pub config: ConfigDeclarations,
    #[serde(default)]
    pub dependencies: Dependencies,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PluginInfo {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub icon: Option<String>,
    #[serde(default)]
    pub legacy_note: Option<String>,
}

#[derive(Deserialize)]
pub struct RuntimeConfig {
    pub command: String,
}

#[derive(Deserialize)]
pub struct DaemonConfig {
    #[serde(default)]
    pub enabled: bool,
    pub command: String,
    #[serde(default)]
    pub socket: Option<String>,
}

#[derive(Deserialize)]
pub struct ActionDecl {
    pub label: String,
    #[serde(default)]
    pub kind: ActionType,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub config_key: Option<String>,
}

#[derive(Deserialize, Default, Clone, Copy, PartialEq)]
pub enum ActionType {
    #[default]
    #[serde(rename = "run")]
    Run,
    #[serde(rename = "settings")]
    Settings,
    #[serde(rename = "toggle-config")]
    ToggleConfig,
}

#[derive(Deserialize, Default)]
pub struct Capabilities {
    #[serde(default)]
    pub gpui: bool,
    #[serde(default)]
    pub doctor: bool,
    #[serde(flatten)]
    pub extras: HashMap<String, toml::Value>,
}

#[derive(Deserialize)]
pub struct ShortcutDeclaration {
    pub id: String,
    pub name: String,
    #[serde(default = "default_shortcut_action")]
    pub action: String,
}

#[derive(Deserialize, Default)]
pub struct Menu {
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub items: Vec<MenuItem>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum MenuItem {
    Action { id: String, label: String },
    Checkbox { id: String, label: String, #[serde(default)] checked: bool },
}

#[derive(Deserialize, Default)]
pub struct ConfigDeclarations {
    #[serde(default)]
    pub scope: HashMap<String, ConfigScope>,
}

#[derive(Deserialize, Clone, Copy)]
#[serde(rename_all = "lowercase")]
pub enum ConfigScope {
    Core,
    Os,
    Device,
}

#[derive(Deserialize, Default)]
pub struct Dependencies {
    #[serde(default)]
    pub binaries: Vec<BinaryDependency>,
}

#[derive(Deserialize)]
pub struct BinaryDependency {
    pub name: String,
}
`;

const CONFIG_SCHEMA = `use indexmap::IndexMap;
use serde::Deserialize;

#[derive(Deserialize)]
pub struct ConfigSpecV1 {
    pub schema_version: u32,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub field: IndexMap<String, FieldSpec>,
    #[serde(default)]
    pub section: IndexMap<String, SectionSpec>,
}

#[derive(Deserialize)]
pub struct FieldSpec {
    #[serde(rename = "type")]
    pub kind: FieldKind,
    pub label: String,
    #[serde(default)]
    pub config_key: Option<String>,
    #[serde(default)]
    pub default: Option<toml::Value>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub active_query: Option<String>,
    #[serde(default)]
    pub section: Option<String>,
    #[serde(default)]
    pub platforms: Option<Vec<String>>,
    #[serde(default)]
    pub label_map: Option<IndexMap<String, String>>,
    #[serde(default)]
    pub tone_map: Option<IndexMap<String, String>>,
}

impl FieldSpec {
    pub fn has_stored_value(&self) -> bool {
        self.kind.has_stored_value()
            && !(self.kind == FieldKind::Number && self.active_query.is_some())
    }
}

#[derive(Deserialize, Clone, Copy, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum FieldKind {
    Boolean,
    Number,
    String,
    Action,
    Status,
    QrCode,
}

impl FieldKind {
    pub fn has_stored_value(self) -> bool {
        !matches!(self, Self::Action | Self::Status | Self::QrCode)
    }
}

#[derive(Deserialize)]
pub struct SectionSpec {
    pub label: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub actions: Vec<String>,
    #[serde(default)]
    pub platforms: Option<Vec<String>>,
}

#[derive(Deserialize)]
pub struct RuntimeSpec {
    pub schema_version: u32,
    #[serde(default, rename = "action")]
    pub actions: IndexMap<String, ActionSpec>,
    #[serde(default, rename = "query")]
    pub queries: IndexMap<String, QuerySpec>,
}

#[derive(Deserialize)]
pub struct ActionSpec {
    pub description: String,
}

#[derive(Deserialize)]
pub struct QuerySpec {
    pub description: String,
    #[serde(default)]
    pub poll_interval_ms: Option<u64>,
}
`;

const MARKS = `pub enum Mark {
    Qol,
    Gear,
}

impl Mark {
    pub fn name(self) -> &'static str {
        match self {
            Self::Qol => "qol",
            Self::Gear => "gear",
        }
    }

    pub fn from_name(name: &str) -> Option<Self> {
        [Self::Qol, Self::Gear].into_iter().find(|mark| mark.name() == name)
    }
}
`;

const TRAY = `fn honour(manifest: &PluginManifest, config: &ConfigSpecV1, runtime: &RuntimeSpec) {
    let plugin = &manifest.plugin;
    let _ = (&plugin.id, &plugin.name, &plugin.icon, &manifest.runtime, &manifest.daemon, &manifest.shortcuts);
    let _ = (&manifest.capabilities.gpui, &manifest.capabilities.doctor, manifest.capabilities.extras.get("peer_trust"));
    let _ = (&manifest.menu.label, &manifest.menu.items, &manifest.config.scope, &manifest.dependencies.binaries);
    for action in manifest.actions.values() {
        let _ = (&action.label, &action.kind, &action.args, &action.config_key);
    }
    for item in &manifest.menu.items {
        match item {
            MenuItem::Action { id, label } => {}
            MenuItem::Checkbox { id, label, checked } => {}
        }
    }
    for shortcut in &manifest.shortcuts {
        let _ = (&shortcut.id, &shortcut.name, &shortcut.action);
    }
    if let Some(daemon) = &manifest.daemon {
        let _ = (daemon.enabled, &daemon.command, &daemon.socket);
    }
    if let Some(runtime) = &manifest.runtime {
        let _ = &runtime.command;
    }
    let _ = (&config.schema_version, &config.title, &config.description, &config.section);
    for field in config.field.values() {
        let _ = (&field.kind, &field.label, &field.config_key, &field.default, &field.query, &field.active_query, &field.section, &field.platforms, &field.label_map, &field.tone_map);
    }
    for section in config.section.values() {
        let _ = (&section.label, &section.description, &section.actions, &section.platforms);
    }
    let _ = (&runtime.schema_version, &runtime.actions, &runtime.queries);
    for query in runtime.queries.values() {
        let _ = (&query.description, &query.poll_interval_ms);
    }
}
`;

const MANIFEST = `[plugin]
id = "qol-demo"
name = "Demo"
icon = "gear"

[runtime]
command = "qol-demo"

[action.run]
label = "Run"
args = ["run"]

[action.settings]
label = "Settings"
kind = "settings"
args = ["settings"]

[capabilities]
doctor = true

[menu]
label = "Demo"
items = []
`;

const CONFIG = `schema_version = 1
title = "Demo"
description = "Switch the demo on and watch its state."

[field.enabled]
type = "boolean"
label = "Enabled"
config_key = "general.enabled"
default = true

[field.state]
type = "status"
label = "State"
query = "status"
`;

const RUNTIME = `schema_version = 1

[query.status]
description = "Current state"
`;

const SOURCE = `use serde::Deserialize;

#[derive(Deserialize)]
struct Config {
    general: General,
}

#[derive(Deserialize)]
struct General {
    enabled: bool,
}

fn main() {
    let config: Config = load();
    if config.general.enabled {}
    match std::env::args().nth(1).as_deref() {
        Some("run") | Some("settings") | Some("status") => {}
        _ => {}
    }
    app().doctor_checks(checks());
}
`;

const CARGO = `[package]
name = "qol-demo"
version = "0.1.0"
edition = "2021"

[dependencies]
serde = "1"
`;

const FILES = {
    'Cargo.toml': '[workspace]\nmembers = ["plugins/*"]\n',
    'libs/plugin-api/Cargo.toml': '[package]\nname = "qol-plugin-api"\n',
    'libs/plugin-api/src/lib.rs': SCHEMA,
    'libs/config/src/lib.rs': CONFIG_SCHEMA,
    'libs/theme/src/marks.rs': MARKS,
    'apps/tray/src/main.rs': TRAY,
    'plugins/demo/Cargo.toml': CARGO,
    'plugins/demo/plugin.toml': MANIFEST,
    'plugins/demo/qol-config.toml': CONFIG,
    'plugins/demo/qol-runtime.toml': RUNTIME,
    'plugins/demo/src/main.rs': SOURCE,
};

function git(root, args) {
    const result = spawnSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
}

function fixture(overrides = {}, { commit = false, outside = false } = {}) {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), outside ? 'contract-' : 'qol-contract-'));
    const root = path.join(base, outside ? 'monorepo' : 'qol-monorepo');
    for (const [rel, content] of Object.entries({ ...FILES, ...overrides })) {
        if (content === null) continue;
        const file = path.join(root, rel);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
    }
    git(root, ['init', '-q']);
    if (commit) {
        git(root, ['add', '-A']);
        git(root, ['commit', '-q', '-m', 'fixture']);
    }
    const temp = path.join(base, 'tmp');
    fs.mkdirSync(temp);
    return { root, temp, file: rel => path.join(root, rel) };
}

function hook(repo, payload) {
    const env = { ...process.env, TMPDIR: repo.temp, TEMP: repo.temp, TMP: repo.temp };
    const result = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(payload), encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
}

function write(repo, rel, content) {
    return hook(repo, { tool_name: 'Write', tool_input: { file_path: repo.file(rel), content } });
}

function edit(repo, rel, oldString, newString) {
    return hook(repo, { tool_name: 'Edit', tool_input: { file_path: repo.file(rel), old_string: oldString, new_string: newString } });
}

function denial(stdout) {
    assert.notEqual(stdout, '', 'expected a denial');
    const output = JSON.parse(stdout).hookSpecificOutput;
    assert.equal(output.permissionDecision, 'deny');
    assert.match(output.permissionDecisionReason, /\[qol-plugin-contract\]/);
    assert.match(output.permissionDecisionReason, /Contracts are honoured to the letter/);
    return output.permissionDecisionReason;
}

function allowed(stdout) {
    assert.equal(stdout, '');
}

test('a new contract the code honours passes', () => {
    for (const [name, content] of [['plugin.toml', MANIFEST], ['qol-config.toml', CONFIG], ['qol-runtime.toml', RUNTIME]]) {
        const repo = fixture({ [`plugins/demo/${name}`]: null });
        allowed(write(repo, `plugins/demo/${name}`, content));
    }
});

test('an unknown key that serde drops is denied with its line', () => {
    const repo = fixture();
    const reason = denial(write(repo, 'plugins/demo/plugin.toml', MANIFEST.replace('[runtime]\ncommand = "qol-demo"\n', '[runtime]\ncommand = "qol-demo"\ntimeout = 5\n')));
    assert.match(reason, /plugin\.toml:8 Key is not part of the contract: runtime\.timeout is not a field of RuntimeConfig, so serde drops it/);
});

test('an unknown key under deny_unknown_fields says the file is refused', () => {
    const repo = fixture();
    const reason = denial(write(repo, 'plugins/demo/plugin.toml', MANIFEST.replace('icon = "gear"\n', 'icon = "gear"\ncolour = "red"\n')));
    assert.match(reason, /plugin\.colour is not a field of PluginInfo, so the tray refuses the whole file/);
});

test('a value of the wrong type is denied', () => {
    const repo = fixture();
    const reason = denial(write(repo, 'plugins/demo/plugin.toml', MANIFEST.replace('doctor = true', 'doctor = "yes"')));
    assert.match(reason, /capabilities\.doctor must be true or false, not the string "yes"/);
});

test('a missing required key is denied', () => {
    const repo = fixture();
    const reason = denial(write(repo, 'plugins/demo/plugin.toml', MANIFEST.replace('name = "Demo"\n', '')));
    assert.match(reason, /plugin\.name is required by PluginInfo/);
});

test('a name outside the enum is denied', () => {
    const repo = fixture();
    const reason = denial(write(repo, 'plugins/demo/plugin.toml', MANIFEST.replace('kind = "settings"', 'kind = "panel"')));
    assert.match(reason, /action\.settings\.kind = "panel" is not one of run, settings, toggle-config/);
});

test('a key the struct accepts but no code reads is denied', () => {
    const repo = fixture();
    const reason = denial(write(repo, 'plugins/demo/plugin.toml', MANIFEST.replace('icon = "gear"\n', 'icon = "gear"\nlegacy_note = "old"\n')));
    assert.match(reason, /Key is accepted but nothing reads it: plugin\.legacy_note sets PluginInfo\.legacy_note/);
});

test('a key swallowed by a flattened map passes only when the code looks it up', () => {
    const repo = fixture();
    allowed(write(repo, 'plugins/demo/plugin.toml', MANIFEST.replace('doctor = true', 'doctor = true\npeer_trust = "pointz-v1"')));
    const reason = denial(write(repo, 'plugins/demo/plugin.toml', MANIFEST.replace('doctor = true', 'doctor = true\nwidgets = true')));
    assert.match(reason, /capabilities\.widgets is not a field of Capabilities; it lands in Capabilities\.extras, and no code looks up "widgets" there/);
});

test('a TOML syntax error is denied', () => {
    const repo = fixture();
    const reason = denial(write(repo, 'plugins/demo/plugin.toml', MANIFEST.replace('[menu]', '[menu')));
    assert.match(reason, /Contract does not parse/);
});

test('an action whose token the plugin never mentions is denied', () => {
    const repo = fixture();
    const reason = denial(write(repo, 'plugins/demo/plugin.toml', `${MANIFEST}\n[action.export]\nlabel = "Export"\n`));
    assert.match(reason, /\[action\.export\] reaches the plugin as "export" through `qol-demo export`/);
});

test('an action token built from two literals counts as handled', () => {
    const repo = fixture({ 'plugins/demo/src/main.rs': SOURCE.replace('Some("status")', 'Some("status") | Some("touchpad") | Some("_on")') });
    allowed(write(repo, 'plugins/demo/plugin.toml', `${MANIFEST}\n[action.touchpad_on]\nlabel = "Touchpad on"\nargs = ["touchpad_on"]\n`));
});

test('an action with no daemon socket and no runtime command is denied', () => {
    const repo = fixture();
    const manifest = MANIFEST.replace('[runtime]\ncommand = "qol-demo"\n', '');
    const reason = denial(write(repo, 'plugins/demo/plugin.toml', manifest));
    assert.match(reason, /\[action\.run\] has no enabled \[daemon\] socket and no \[runtime\] command/);
});

test('a daemon sharing the runtime binary receives the action id, not the args', () => {
    const repo = fixture();
    const daemon = '[daemon]\nenabled = true\ncommand = "qol-demo"\nsocket = "/tmp/qol-demo.sock"\n';
    const reason = denial(write(repo, 'plugins/demo/plugin.toml', `${MANIFEST}\n${daemon}\n[action.flip]\nlabel = "Flip"\nargs = ["run"]\n`));
    assert.match(reason, /\[action\.flip\] reaches the plugin as "flip" through the daemon socket, but/);
});

test('a hosted settings action needs no dispatch token', () => {
    const repo = fixture({
        'plugins/demo/src/main.rs': SOURCE.replace(' | Some("settings")', ''),
        'plugins/demo/plugin.toml': MANIFEST.replace(/\[action\.settings\][\s\S]*?\n\n/, ''),
    });
    allowed(write(repo, 'plugins/demo/plugin.toml', MANIFEST));
});

test('a shortcut to an undeclared action and a duplicate shortcut id are denied', () => {
    const repo = fixture();
    const shortcuts = '[[shortcuts]]\nid = "go"\nname = "Go"\naction = "run"\n\n[[shortcuts]]\nid = "go"\nname = "Again"\n';
    const reason = denial(write(repo, 'plugins/demo/plugin.toml', `${MANIFEST}\n${shortcuts}`));
    assert.match(reason, /\[\[shortcuts\]\] go runs action "open", which plugin\.toml does not declare/);
    assert.match(reason, /\[\[shortcuts\]\] id "go" appears more than once/);
});

test('a command the plugin does not build is denied', () => {
    const repo = fixture();
    const reason = denial(write(repo, 'plugins/demo/plugin.toml', MANIFEST.replace('command = "qol-demo"', 'command = "qol-dmeo"')));
    assert.match(reason, /\[runtime\] command = "qol-dmeo", but plugins\/demo\/Cargo\.toml builds qol-demo/);
});

test('an icon that names no mark is denied', () => {
    const repo = fixture();
    const reason = denial(write(repo, 'plugins/demo/plugin.toml', MANIFEST.replace('icon = "gear"', 'icon = "cog"')));
    assert.match(reason, /\[plugin\] icon = "cog" is not a qol_theme mark name/);
});

test('the doctor capability must match registered checks both ways', () => {
    const repo = fixture({
        'plugins/demo/src/main.rs': SOURCE.replace('    app().doctor_checks(checks());\n', ''),
        'plugins/demo/plugin.toml': MANIFEST.replace('doctor = true', 'doctor = false'),
    });
    assert.match(denial(write(repo, 'plugins/demo/plugin.toml', MANIFEST)), /doctor = true, but plugins\/demo\/src registers no doctor checks/);
    const wired = fixture();
    assert.match(denial(write(wired, 'plugins/demo/plugin.toml', MANIFEST.replace('doctor = true', 'doctor = false'))), /registers doctor checks, but \[capabilities\] doctor is not true/);
});

test('menu items are denied when actions exist, and checkboxes always', () => {
    const repo = fixture();
    const item = '{ type = "action", id = "run", label = "Run" }';
    assert.match(denial(write(repo, 'plugins/demo/plugin.toml', MANIFEST.replace('items = []', `items = [${item}]`))), /\[menu\] items holds 1 entry, but plugin\.toml declares \[action\.\*\]/);
    const legacy = MANIFEST.replace(/\[action\.run\][\s\S]*?\[capabilities\]/, '[capabilities]').replace('items = []', `items = [${item}, { type = "checkbox", id = "audio", label = "Audio" }]`);
    assert.match(denial(write(repo, 'plugins/demo/plugin.toml', legacy)), /\[menu\] checkbox "audio" is never shown/);
});

test('a config scope must name a stored key or a parent path of one', () => {
    const repo = fixture();
    allowed(write(repo, 'plugins/demo/plugin.toml', `${MANIFEST}\n[config.scope]\ngeneral = "device"\n`));
    allowed(write(repo, 'plugins/demo/plugin.toml', `${MANIFEST}\n[config.scope]\n"general.enabled" = "device"\n`));
    assert.match(denial(write(repo, 'plugins/demo/plugin.toml', `${MANIFEST}\n[config.scope]\nstate = "device"\n`)), /\[config\] scope\.state names no stored qol-config\.toml key or parent of one/);
    assert.match(denial(write(repo, 'plugins/demo/plugin.toml', `${MANIFEST}\n[config.scope]\n"general.missing" = "device"\n`)), /\[config\] scope\.general\.missing names no stored qol-config\.toml key/);
    assert.match(denial(write(repo, 'plugins/demo/plugin.toml', `${MANIFEST}\n[config.scope]\ntitle_bar = "os"\n`)), /\[config\] scope\.title_bar names no stored qol-config\.toml key/);
    const framed = fixture({ 'plugins/demo/qol-config.toml': `${CONFIG}\n[window]\ntitle_bar = true\n` });
    allowed(write(framed, 'plugins/demo/plugin.toml', `${MANIFEST}\n[config.scope]\ntitle_bar = "os"\n`));
});

test('a toggle-config action must name a stored field', () => {
    const repo = fixture();
    allowed(write(repo, 'plugins/demo/plugin.toml', `${MANIFEST}\n[action.flip]\nlabel = "Flip"\nkind = "toggle-config"\nconfig_key = "general.enabled"\n`));
    assert.match(denial(write(repo, 'plugins/demo/plugin.toml', `${MANIFEST}\n[action.flip]\nlabel = "Flip"\nkind = "toggle-config"\nconfig_key = "state"\n`)), /toggles config_key "state", which no stored qol-config\.toml field declares/);
});

test('a stored setting no plugin struct reads is denied, while unstored kinds pass', () => {
    const repo = fixture();
    allowed(write(repo, 'plugins/demo/qol-config.toml', `${CONFIG}\n[field.code]\ntype = "qr_code"\nlabel = "Code"\n\n[field.level]\ntype = "number"\nlabel = "Level"\nactive_query = "status"\n`));
    const reason = denial(write(repo, 'plugins/demo/qol-config.toml', `${CONFIG}\n[field.volume]\ntype = "number"\nlabel = "Volume"\nconfig_key = "general.volume"\ndefault = 5\n`));
    assert.match(reason, /\[field\.volume\] stores "general\.volume", which matches no Deserialize struct field and no string/);
});

test('a setting bound to a field nothing reads is denied', () => {
    const repo = fixture({
        'plugins/demo/src/main.rs': SOURCE.replace('    if config.general.enabled {}\n', ''),
        'plugins/demo/qol-config.toml': CONFIG.replace(/\[field\.enabled\][\s\S]*?\n\n/, ''),
    });
    const reason = denial(write(repo, 'plugins/demo/qol-config.toml', CONFIG));
    assert.match(reason, /stores "general\.enabled", which binds to the field enabled, which no code outside tests reads/);
});

test('a section listing an undeclared action is denied', () => {
    const repo = fixture();
    const reason = denial(write(repo, 'plugins/demo/qol-config.toml', `${CONFIG}\n[section.main]\nlabel = "Main"\nactions = ["export"]\n`));
    assert.match(reason, /\[section\.main\] actions lists "export"/);
});

const SECTION_FIELDS = `
[field.volume]
type = "boolean"
label = "Volume"
config_key = "general.enabled"
section = "audio"

[field.balance]
type = "status"
label = "Balance"
query = "status"
section = "audio"
`;

test('sections with a sub header and a distinct lead row pass', () => {
    const repo = fixture();
    allowed(write(repo, 'plugins/demo/qol-config.toml', `${CONFIG.replace(/\[field\.enabled\][\s\S]*$/, '')}\n[section.audio]\nlabel = "Audio"\ndescription = "How the demo sounds."\n${SECTION_FIELDS}\n[section.solo]\nlabel = "Solo"\ndescription = "One row."\n\n[field.single]\ntype = "status"\nlabel = "Single row"\nquery = "status"\nsection = "solo"\n`));
});

test('a section without a description is denied', () => {
    const repo = fixture();
    const reason = denial(write(repo, 'plugins/demo/qol-config.toml', `${CONFIG}\n[section.audio]\nlabel = "Audio"\n${SECTION_FIELDS}`));
    assert.match(reason, /Settings header has no sub header: \[section\.audio\] has no description/);
    const blank = denial(write(repo, 'plugins/demo/qol-config.toml', `${CONFIG}\n[section.audio]\nlabel = "Audio"\ndescription = "  "\n${SECTION_FIELDS}`));
    assert.match(blank, /\[section\.audio\] has no description/);
});

test('a section sharing the label of its only field is denied', () => {
    const repo = fixture();
    const only = '\n[section.audio]\nlabel = " Volume "\ndescription = "How loud."\n\n[field.volume]\ntype = "boolean"\nlabel = "volume"\nconfig_key = "general.enabled"\nsection = "audio"\n';
    const reason = denial(write(repo, 'plugins/demo/qol-config.toml', `${CONFIG}${only}`));
    assert.match(reason, /Settings header repeats its only row: \[section\.audio\] label " Volume " equals the label of its only field \[field\.volume\]/);
    allowed(write(repo, 'plugins/demo/qol-config.toml', `${CONFIG}${only}\n[field.balance]\ntype = "status"\nlabel = "Balance"\nquery = "status"\nsection = "audio"\n`));
});

test('root fields need a top-level description', () => {
    const repo = fixture();
    const reason = denial(write(repo, 'plugins/demo/qol-config.toml', CONFIG.replace(/description = .*\n/, '')));
    assert.match(reason, /Settings header has no sub header: fields outside every section show under a General header/);
    denial(write(repo, 'plugins/demo/qol-config.toml', CONFIG.replace(/description = .*\n/, 'description = ""\n')));
    allowed(write(repo, 'plugins/demo/qol-config.toml', 'schema_version = 1\n\n[section.audio]\nlabel = "Audio"\ndescription = "How the demo sounds."\n' + SECTION_FIELDS));
});

const EMITTER = `
pub fn state() -> &'static str {
    "ok"
}
`;

const ADAPTER = `use serde::Deserialize;

#[derive(Deserialize)]
pub struct Audio {
    pub adapter: String,
}

pub fn read(audio: &Audio) -> String {
    audio.adapter.clone()
}
`;

const ADAPTER_FIELD = '\n[field.adapter]\ntype = "string"\nlabel = "Adapter"\nconfig_key = "adapter"\n';

function adapterRepo(file, extra = {}) {
    return fixture({ [`plugins/demo/src/${file}`]: ADAPTER, ...extra });
}

test('a status map key the plugin never emits is denied, while emitted and boolean keys pass', () => {
    const repo = fixture({ 'plugins/demo/src/state.rs': EMITTER });
    const field = (map, keys) => CONFIG.replace('query = "status"', `query = "status"\n${map} = { ${keys} }`);
    allowed(write(repo, 'plugins/demo/qol-config.toml', field('label_map', 'ok = "Fine", true = "On", false = "Off"')));
    allowed(write(repo, 'plugins/demo/qol-config.toml', field('tone_map', 'ok = "success"')));
    const label = denial(write(repo, 'plugins/demo/qol-config.toml', field('label_map', 'ok = "Fine", no_target = "No dongle"')));
    assert.match(label, /Status value is never emitted: \[field\.state\] label_map maps the state "no_target", but no string or serialized enum variant in plugins\/demo\/src outside tests emits it/);
    assert.doesNotMatch(label, /"ok"/);
    assert.match(label, /emit the state from the plugin or delete it from the map/);
    const tone = denial(write(repo, 'plugins/demo/qol-config.toml', field('tone_map', 'ok = "success", offline = "danger"')));
    assert.match(tone, /tone_map maps the state "offline"/);
});

test('a status state emitted as a serialized enum variant passes', () => {
    const lifecycle = '#[derive(Serialize)]\n#[serde(rename_all = "snake_case")]\npub enum Lifecycle {\n    Idle,\n    StillListening,\n    #[serde(rename = "halt")]\n    Stopping,\n}\n';
    const repo = fixture({ 'plugins/demo/src/state.rs': EMITTER, 'plugins/demo/src/lifecycle.rs': lifecycle });
    allowed(write(repo, 'plugins/demo/qol-config.toml', CONFIG.replace('query = "status"', 'query = "status"\nlabel_map = { idle = "Idle", still_listening = "Listening", halt = "Halting" }')));
    const unserialized = fixture({ 'plugins/demo/src/state.rs': EMITTER, 'plugins/demo/src/lifecycle.rs': lifecycle.replace('#[derive(Serialize)]\n', '') });
    const reason = denial(write(unserialized, 'plugins/demo/qol-config.toml', CONFIG.replace('query = "status"', 'query = "status"\nlabel_map = { still_listening = "Listening" }')));
    assert.match(reason, /maps the state "still_listening"/);
});

test('a state listed in both status maps is reported once', () => {
    const repo = fixture();
    const reason = denial(write(repo, 'plugins/demo/qol-config.toml', CONFIG.replace('query = "status"', 'query = "status"\nlabel_map = { gone = "Gone" }\ntone_map = { gone = "danger" }')));
    assert.equal(reason.match(/maps the state "gone"/g).length, 1);
});

test('a status map is not judged when the plugin has no source of its own', () => {
    const repo = fixture({ 'plugins/demo/src/main.rs': null });
    allowed(write(repo, 'plugins/demo/qol-config.toml', CONFIG.replace('query = "status"', 'query = "status"\nlabel_map = { gone = "Gone" }')));
});

test('a setting read only in one OS platform file needs platforms naming that OS', () => {
    for (const [file, system] of [['platform/linux.rs', 'linux'], ['platform/macos/mod.rs', 'macos'], ['platform/windows/input.rs', 'windows'], ['macos.rs', 'macos']]) {
        const repo = adapterRepo(file);
        const reason = denial(write(repo, 'plugins/demo/qol-config.toml', `${CONFIG}${ADAPTER_FIELD}`));
        assert.match(reason, new RegExp(`Setting is read on one OS only: \\[field\\.adapter\\] stores "adapter", which is read only in plugins/demo/src/${file.replace(/[./]/g, '\\$&')} \\(${system} code\\), but neither the field nor its section declares platforms`));
        assert.match(reason, /add platforms = \[\.\.\.\] naming the OSes whose code reads it, or read it on the others/);
        allowed(write(repo, 'plugins/demo/qol-config.toml', `${CONFIG}${ADAPTER_FIELD}platforms = ["${system}"]\n`));
    }
});

test('section platforms cover a field read only in one OS platform file', () => {
    const repo = adapterRepo('platform/linux.rs');
    const sectioned = (platforms, field = '') => `${CONFIG}\n[section.host]\nlabel = "Host"\ndescription = "The host system."\n${platforms}\n[field.adapter]\ntype = "string"\nlabel = "Adapter"\nconfig_key = "adapter"\nsection = "host"\n${field}`;
    allowed(write(repo, 'plugins/demo/qol-config.toml', sectioned('platforms = ["linux"]\n')));
    assert.match(denial(write(repo, 'plugins/demo/qol-config.toml', sectioned(''))), /neither the field nor its section declares platforms/);
    assert.match(denial(write(repo, 'plugins/demo/qol-config.toml', sectioned('platforms = ["linux", "macos"]\n'))), /declares platforms macos, but it is read only in plugins\/demo\/src\/platform\/linux\.rs \(linux code\)/);
});

test('platforms naming an OS no reader covers is denied', () => {
    const repo = adapterRepo('platform/linux.rs');
    const reason = denial(write(repo, 'plugins/demo/qol-config.toml', `${CONFIG}${ADAPTER_FIELD}platforms = ["linux", "windows"]\n`));
    assert.match(reason, /declares platforms windows, but it is read only in plugins\/demo\/src\/platform\/linux\.rs \(linux code\)/);
});

test('readers in several OS files are covered by the union of their platforms', () => {
    const repo = adapterRepo('platform/linux.rs', { 'plugins/demo/src/platform/macos.rs': ADAPTER });
    allowed(write(repo, 'plugins/demo/qol-config.toml', `${CONFIG}${ADAPTER_FIELD}platforms = ["linux", "macos"]\n`));
    denial(write(repo, 'plugins/demo/qol-config.toml', `${CONFIG}${ADAPTER_FIELD}`));
});

test('a setting read in the platform code of every OS needs no platforms', () => {
    const repo = adapterRepo('platform/linux.rs', { 'plugins/demo/src/platform/macos.rs': ADAPTER, 'plugins/demo/src/platform/windows/mod.rs': ADAPTER });
    allowed(write(repo, 'plugins/demo/qol-config.toml', `${CONFIG}${ADAPTER_FIELD}`));
});

test('a setting also read in shared code needs no platforms', () => {
    const repo = adapterRepo('platform/linux.rs', { 'plugins/demo/src/shared.rs': ADAPTER });
    allowed(write(repo, 'plugins/demo/qol-config.toml', `${CONFIG}${ADAPTER_FIELD}`));
    allowed(write(repo, 'plugins/demo/qol-config.toml', `${CONFIG}${ADAPTER_FIELD}platforms = ["linux", "windows"]\n`));
});

test('a plugin directory named after an OS does not make its shared code platform code', () => {
    const repo = fixture({ 'plugins/linux/Cargo.toml': CARGO, 'plugins/linux/plugin.toml': MANIFEST, 'plugins/linux/qol-config.toml': CONFIG, 'plugins/linux/qol-runtime.toml': RUNTIME, 'plugins/linux/src/main.rs': `${SOURCE}${ADAPTER}` });
    allowed(write(repo, 'plugins/linux/qol-config.toml', `${CONFIG}${ADAPTER_FIELD}`));
});

test('a runtime entry the plugin never mentions is denied', () => {
    const repo = fixture();
    const reason = denial(write(repo, 'plugins/demo/qol-runtime.toml', `${RUNTIME}\n[action.reset]\ndescription = "Reset"\n`));
    assert.match(reason, /\[action\.reset\] is declared, but neither plugins\/demo\/src nor its path dependencies mention "reset"/);
});

test('an edit that keeps an existing violation is allowed and one that adds a violation is denied', () => {
    const broken = MANIFEST.replace('icon = "gear"', 'icon = "cog"');
    const repo = fixture({ 'plugins/demo/plugin.toml': broken });
    allowed(edit(repo, 'plugins/demo/plugin.toml', 'name = "Demo"', 'name = "Demo plugin"'));
    assert.match(denial(edit(repo, 'plugins/demo/plugin.toml', 'label = "Run"', 'label = "Run"\nhint = 1')), /action\.run\.hint is not a field of ActionDecl/);
});

test('a source edit that drops a handled token is denied', () => {
    const repo = fixture({}, { commit: true });
    const reason = denial(edit(repo, 'plugins/demo/src/main.rs', 'Some("run") | ', ''));
    assert.match(reason, /This edit to main\.rs leaves a plugin contract declaration the code does not honour/);
    assert.match(reason, /\[action\.run\] reaches the plugin as "run"/);
    allowed(edit(repo, 'plugins/demo/src/main.rs', 'fn main() {', 'fn main() {\n    let _ = 1;'));
});

test('a changed file on disk is re-read rather than served from the cache', () => {
    const manifest = `${MANIFEST}\n[action.export]\nlabel = "Export"\nargs = ["export"]\n`;
    for (const commit of [false, true]) {
        const repo = fixture({}, { commit });
        assert.match(denial(write(repo, 'plugins/demo/plugin.toml', manifest)), /\[action\.export\] reaches the plugin as "export"/);
        assert.ok(fs.existsSync(path.join(repo.temp, 'qol-plugin-contract', 'facts.json')));
        fs.writeFileSync(repo.file('plugins/demo/src/main.rs'), SOURCE.replace('Some("status")', 'Some("status") | Some("export")'));
        allowed(write(repo, 'plugins/demo/plugin.toml', manifest));
    }
});

test('files outside the contract surface or outside a qol repo are ignored', () => {
    const broken = MANIFEST.replace('icon = "gear"', 'icon = "cog"');
    const repo = fixture();
    allowed(write(repo, 'plugins/demo/README.md', broken));
    allowed(write(repo, 'examples/plugin.toml', broken));
    allowed(write(repo, 'plugins/demo/src/tests.rs', SOURCE));
    allowed(hook(repo, { tool_name: 'Read', tool_input: { file_path: repo.file('plugins/demo/plugin.toml') } }));
    allowed(write(fixture({}, { outside: true }), 'plugins/demo/plugin.toml', broken));
});

test('lint mode reports every finding in a contract file with its line', () => {
    const repo = fixture({ 'plugins/demo/plugin.toml': MANIFEST.replace('icon = "gear"', 'icon = "cog"') });
    const env = { ...process.env, TMPDIR: repo.temp, TEMP: repo.temp, TMP: repo.temp };
    const runner = `const lint = require(${JSON.stringify(HOOK)});
const file = process.argv[1];
process.stdout.write(JSON.stringify(lint.lintFile(file, require('fs').readFileSync(file, 'utf8'))));`;
    const result = spawnSync(process.execPath, ['-e', runner, repo.file('plugins/demo/plugin.toml')], { encoding: 'utf8', env });
    assert.equal(result.status, 0, result.stderr);
    const messages = JSON.parse(result.stdout);
    assert.equal(messages.length, 1);
    assert.match(messages[0], /^Icon names no mark in plugin\.toml: \[plugin\] icon = "cog" is not a qol_theme mark name.* \(line 4\)\.\n\[qol-plugin-contract\]/);
});

test('existing debt whose wording changes is not re-reported as added', () => {
    const item = '{ type = "action", id = "run", label = "Run" }';
    const debt = MANIFEST.replace('items = []', `items = [${item}]`);
    const repo = fixture({ 'plugins/demo/plugin.toml': debt }, { commit: true });
    allowed(edit(repo, 'plugins/demo/plugin.toml', `items = [${item}]`, `items = [${item}, ${item}]`));
});

test('a second copy of an existing finding is still reported as added', () => {
    const once = '[[shortcuts]]\nid = "go"\nname = "Go"\naction = "run"\n\n[[shortcuts]]\nid = "go"\nname = "Again"\naction = "run"\n';
    const repo = fixture({ 'plugins/demo/plugin.toml': `${MANIFEST}\n${once}` }, { commit: true });
    const reason = denial(write(repo, 'plugins/demo/plugin.toml', `${MANIFEST}\n${once}\n[[shortcuts]]\nid = "go"\nname = "Third"\naction = "run"\n`));
    assert.match(reason, /leaves a plugin contract declaration the code does not honour/);
    assert.match(reason, /id "go" appears more than once/);
});

test('lint mode against a base reports only findings the contract file added', () => {
    const broken = MANIFEST.replace('icon = "gear"', 'icon = "cog"');
    const repo = fixture({ 'plugins/demo/plugin.toml': broken });
    const env = { ...process.env, TMPDIR: repo.temp, TEMP: repo.temp, TMP: repo.temp };
    const runner = `const lint = require(${JSON.stringify(HOOK)});
const [file, baseline] = process.argv.slice(1);
process.stdout.write(JSON.stringify(lint.lintFile(file, require('fs').readFileSync(file, 'utf8'), baseline)));`;
    const lintAgainst = baseline => {
        const result = spawnSync(process.execPath, ['-e', runner, repo.file('plugins/demo/plugin.toml'), baseline], { encoding: 'utf8', env });
        assert.equal(result.status, 0, result.stderr);
        return JSON.parse(result.stdout);
    };
    assert.deepEqual(lintAgainst(broken), []);
    assert.deepEqual(lintAgainst(broken.replace('[menu]', '[menu]\nunused = 1')), []);
    const added = lintAgainst(MANIFEST);
    assert.equal(added.length, 1);
    assert.match(added[0], /^Icon names no mark in plugin\.toml: \[plugin\] icon = "cog"/);
});

test('mentions accepts a literal or two literals joined directly or by a separator', () => {
    const { mentions } = require(HOOK);
    const strings = new Set(['run', 'set_', 'pointer_speed', 'touchpad', 'on']);
    assert.ok(mentions(strings, 'run'));
    assert.ok(mentions(strings, 'set_pointer_speed'));
    assert.ok(mentions(strings, 'touchpad_on'));
    assert.ok(!mentions(strings, 'touchpad_onn'));
    assert.ok(!mentions(strings, 'export'));
});
