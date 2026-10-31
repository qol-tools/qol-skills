import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parsePrompt } from "../hooks/qac-intercept.mjs";
import { FIX_FILE_LIMIT, fixBrief, fixGuidance, lint, renderHelp, splitRule, summarize } from "../src/qac.mjs";
import { progressReporter } from "../src/progress.mjs";
import { browserCommand, renderReport } from "../src/report.mjs";
import { locate } from "../src/locate.mjs";
import { EXIT, ROUTES, VERBS, parseArgs, run } from "../scripts/qac.mjs";
import { repoId } from "../src/gate/config.mjs";
import { GATE_EXIT } from "../src/gate/gate.mjs";
import { listSlips, recordFingerprint } from "../src/slips.mjs";

const QAC_CLI = fileURLToPath(new URL("../scripts/qac.mjs", import.meta.url));

function repo(files) {
  const root = path.join(mkdtempSync(path.join(tmpdir(), "qac-")), "qol-monorepo");
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-q"], { cwd: root });
  for (const [relative, content] of Object.entries(files)) {
    const file = path.join(root, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

const PLUGIN = {
  "plugins/fixture/plugin.toml": "[plugin]\nid = \"fixture\"\n",
  "plugins/fixture/Cargo.toml": "[package]\nname = \"plugin-fixture\"\nversion = \"0.1.0\"\n",
};

test("parsePrompt routes the qac verbs and passes other prompts through", () => {
  assert.deepEqual(parsePrompt("qac", "/w"), ["help", "--prefix=qac", "--pretty", "--cwd=/w"]);
  assert.deepEqual(parsePrompt("qac lint", ""), ["lint", "--prefix=qac", "--pretty", "--open"]);
  assert.deepEqual(parsePrompt("QAC lint plugins/launcher", ""), ["lint", "plugins/launcher", "--prefix=qac", "--pretty", "--open"]);
  assert.deepEqual(parsePrompt("qac plugins/shot", ""), ["lint", "plugins/shot", "--prefix=qac", "--pretty", "--open"]);
  assert.equal(parsePrompt("qacx lint", ""), null);
  assert.equal(parsePrompt("please run qac lint", ""), null);
});

test("lint reports existing debt that the edit-time hooks would let stand", () => {
  const root = repo({
    ...PLUGIN,
    "plugins/fixture/src/config/mod.rs": "pub fn paths() {\n    let _ = qol_config::plugin_config_paths(&[ID]);\n}\n",
  });
  const result = lint(root);
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0].hook, "qol-arch-code");
  assert.equal(result.findings[0].file, "plugins/fixture/src/config/mod.rs");
  assert.match(result.findings[0].summary, /raw config file path/);
});

function commitAll(root) {
  const git = args => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: root });
  git(["add", "-A"]);
  git(["commit", "-q", "-m", "base"]);
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
}

test("lint --base judges rules about added code against the base revision", () => {
  const config = "plugins/fixture/src/config/mod.rs";
  const raw = "    let _ = qol_config::plugin_config_paths(&[ID]);\n";
  const root = repo({ ...PLUGIN, [config]: `pub fn paths() {\n${raw}}\n` });
  const base = commitAll(root);
  assert.equal(lint(root, [], { base }).findings.length, 0);

  writeFileSync(path.join(root, config), `pub fn paths() {\n${raw}${raw}}\n`);
  writeFileSync(path.join(root, "plugins/fixture/src/config/fresh.rs"), `pub fn more() {\n${raw}}\n`);
  const files = lint(root, [], { base }).findings.map(finding => finding.file).sort();
  assert.deepEqual(files, ["plugins/fixture/src/config/fresh.rs", config]);
});

test("lint --base still judges rules about the code as it stands on every file", () => {
  const root = repo({
    ...PLUGIN,
    "plugins/fixture/src/feature/mod.rs": "#[cfg(target_os = \"linux\")]\npub fn run() {}\n",
  });
  const base = commitAll(root);
  assert.equal(lint(root, [], { base }).findings.length, 1);
});

test("lint reports a platform tree property once, on the file that owns it", () => {
  const root = repo({
    "libs/fixture/Cargo.toml": "[package]\nname = \"fixture\"\nversion = \"0.1.0\"\n",
    "libs/fixture/src/feature/platform/mod.rs": "#[cfg(target_os = \"linux\")]\nmod linux;\n#[cfg(target_os = \"linux\")]\npub(crate) use linux::run;\n",
    "libs/fixture/src/feature/platform/linux.rs": "pub(crate) fn run() {}\n",
  });
  const files = lint(root).findings.map(finding => finding.file);
  assert.deepEqual(files, ["libs/fixture/src/feature/platform/mod.rs"]);
});

test("lint passes clean files and narrows to the given paths", () => {
  const root = repo({
    ...PLUGIN,
    "plugins/fixture/src/config/mod.rs": "pub fn load() {}\n",
    "plugins/other/src/debug.rs": "fn f() { dbg!(1); }\n",
  });
  assert.equal(lint(root, ["plugins/fixture"]).findings.length, 0);
  assert.equal(lint(root).findings.length, 1);
});

test("lint never consumes a bypass marker", () => {
  const root = repo({
    ...PLUGIN,
    ".claude/bypass-qol-arch-code": "",
    "plugins/fixture/src/config/mod.rs": "pub fn f() { let _ = qol_config::config_dir(); }\n",
  });
  assert.equal(lint(root).findings.length, 1);
  assert.equal(lint(root).findings.length, 1);
});

test("summarize keeps the reason and its bullets on one line", () => {
  const message = "qol-arch-code violation in /x.rs.\n\nThis edit hand-rolls plugin settings:\n\n  - raw config file path\n\nDeclare it.";
  assert.equal(summarize(message), "This edit hand-rolls plugin settings: - raw config file path");
});

function quiet() {
  const events = [];
  return {
    events,
    progress: () => ({ step: (done, total) => events.push(["step", done, total]), finish: (detail, tone) => events.push(["finish", detail, tone]) }),
    write: () => "/tmp/qac/report.html",
    open: file => events.push(["open", file]),
  };
}

test("run returns typed exit codes, reports progress and opens the report", () => {
  const clean = repo({ "README.md": "x\n" });
  const lines = [];
  const io = quiet();
  assert.equal(run(["lint", "--pretty", "--open", `--cwd=${clean}`], { out: line => lines.push(line), ...io }), EXIT.clean);
  assert.equal(lines[0], "qac lint: 1 files, clean\nreport opened: /tmp/qac/report.html");
  assert.deepEqual(io.events.at(-2), ["finish", "clean", "ok"]);
  assert.deepEqual(io.events.at(-1), ["open", "/tmp/qac/report.html"]);
  assert.equal(run(["bogus"], { out: () => {}, ...quiet() }), EXIT.usage);
  const outside = mkdtempSync(path.join(tmpdir(), "qac-none-"));
  const failed = quiet();
  assert.equal(run(["lint", `--cwd=${outside}`], { out: () => {}, ...failed }), EXIT.notRepo);
  assert.deepEqual(failed.events.at(-1), ["finish", "not a git repository", "bad"]);
});

test("findings leave the report closed without --open and warn on the status line", () => {
  const root = repo({ ...PLUGIN, "plugins/fixture/src/config/mod.rs": "pub fn f() { let _ = qol_config::config_dir(); }\n" });
  const io = quiet();
  const lines = [];
  assert.equal(run(["lint", "--pretty", `--cwd=${root}`], { out: line => lines.push(line), ...io }), EXIT.findings);
  assert.match(lines[0], /^qac lint: 3 files, 1 findings \(qol-arch-code 1\)\nreport: /);
  assert.deepEqual(io.events.at(-1), ["finish", "1 findings", "warn"]);
});

test("progressReporter throttles steps but always writes the last one", () => {
  const writes = [];
  let clock = 0;
  const bar = progressReporter("qac", "qac lint", { write: (_, entry) => writes.push(entry), now: () => clock, env: { XDG_RUNTIME_DIR: "/r" } });
  bar.step(0, 10);
  clock = 100;
  bar.step(5, 10);
  bar.step(10, 10);
  bar.finish("clean", "ok");
  assert.deepEqual(writes.map(entry => entry.done), [0, 10, 0]);
  assert.equal(writes.at(-1).finished, true);
  assert.equal(writes.at(-1).tone, "ok");
});

test("splitRule separates the rule from its detail", () => {
  assert.deepEqual(splitRule("The platform facade is incomplete: - missing target coverage: windows"), {
    rule: "The platform facade is incomplete",
    detail: "missing target coverage: windows",
  });
  assert.deepEqual(splitRule("No colon"), { rule: "No colon", detail: "" });
  assert.equal(splitRule("New println! in evprobe.rs: outside a cli module", "tools/x/evprobe.rs").rule, "New println!");
  assert.equal(splitRule("This edit hand-rolls plugin settings: - raw config file path").rule, "Hand-rolls plugin settings");
  assert.equal(splitRule("This edit adds code that breaks the design. Each line says what: x").rule, "Adds code that breaks the design");
});

test("renderReport embeds findings without breaking out of the script tag", () => {
  const html = renderReport({
    root: "/x/qol-monorepo",
    at: "2026-09-30T00:00:00Z",
    files: 1,
    findings: [{ file: "a.rs", hook: "qol-logging", rule: "r", detail: "d", message: "</script><b>x" }],
  }, ["qol-logging"]);
  assert.equal(html.split("</script>").length, 3);
  assert.match(html, /\\u003c\/script>\\u003cb>x/);
});

test("locate prefers explicit line references", () => {
  const message = "Detected:\n\n  line 8: #[cfg(x)]\n  line 9: use a;\n";
  assert.deepEqual(locate(message, "a\nb\n", "src/a.rs"), [8, 9]);
  assert.deepEqual(locate("  - src/a.css:35 font-size: 1rem", "", "src/a.css"), [35]);
});

test("locate finds signal lines from the hook's own locators", () => {
  const content = "fn a() {}\nlet p = qol_config::plugin_config_paths(&[ID]);\n// note\nprintln!(\"x\");\n";
  const locators = [
    { label: "raw config file path", re: /\bplugin_config_paths\b/g },
    { label: "println!", re: /\bprintln!\s*[(\[{]/g },
  ];
  assert.deepEqual(locate("  - raw config file path", content, "a.rs", locators), [2]);
  assert.deepEqual(locate("New println! in a.rs", content, "a.rs", locators), [4]);
  assert.deepEqual(locate("  - helper: consumed only by linux", "pub fn helper() {}\n", "a.rs"), [1]);
  assert.deepEqual(locate("OS-named files must live inside platform/", content, "a.rs", locators), []);
});

test("lint keeps the source of every flagged file and skips vendor/", () => {
  const root = repo({
    ...PLUGIN,
    "plugins/fixture/src/config/mod.rs": "pub fn f() {\n    let _ = qol_config::config_dir();\n}\n",
    "vendor/lib/src/debug.rs": "fn f() { dbg!(1); }\n",
  });
  const result = lint(root);
  assert.equal(result.findings.length, 1);
  assert.deepEqual(result.findings[0].lines, [2]);
  assert.deepEqual(Object.keys(result.sources), ["plugins/fixture/src/config/mod.rs"]);
});

test("browserCommand opens the default web browser, never the text/html handler", () => {
  const exec = () => "firefox.desktop\n";
  const url = pathToFileURL("/r/x.html").href;
  assert.deepEqual(browserCommand("/r/x.html", { platform: "linux", exec }), ["gtk-launch", ["firefox.desktop", url]]);
  assert.deepEqual(browserCommand("/r/x.html", { platform: "linux", exec: () => { throw new Error("no"); } }), ["xdg-open", [url]]);
  assert.deepEqual(browserCommand("/r/x.html", { platform: "darwin" }), ["open", [url]]);
});

test("parsePrompt routes qac fix without opening the report", () => {
  assert.deepEqual(parsePrompt("qac fix plugins/shot", "/w"), ["fix", "plugins/shot", "--prefix=qac", "--pretty", "--cwd=/w"]);
});

test("help lists the verbs without a line about help itself", () => {
  const help = renderHelp();
  assert.match(help, /qac lint/);
  assert.match(help, /qac fix/);
  assert.doesNotMatch(help, /qac help/);
});

test("fixGuidance drops bypass hints", () => {
  const message = "qol-arch-code violation in x.\n\nDo this.\n\nBypass for this edit only:\n  touch .claude/bypass-qol-arch-code";
  assert.equal(fixGuidance(message), "qol-arch-code violation in x.\n\nDo this.");
});

test("fixBrief ranks files by findings and caps the default batch", () => {
  const findings = [];
  for (let file = 0; file < FIX_FILE_LIMIT + 2; file++) {
    for (let n = 0; n <= file; n++) findings.push({ file: `f${file}.rs`, hook: "qol-logging", rule: "New dbg!", lines: [n + 1], message: "New dbg!" });
  }
  const brief = fixBrief({ findings });
  assert.equal(brief.files.length, FIX_FILE_LIMIT);
  assert.equal(brief.files[0], `f${FIX_FILE_LIMIT + 1}.rs`);
  assert.match(brief.text, /more elsewhere/);
  assert.match(brief.text, /Never create a bypass marker/);
  assert.equal(fixBrief({ findings }, { explicit: true }).files.length, FIX_FILE_LIMIT + 2);
});

test("run fix returns the brief, or reports nothing to fix", () => {
  const root = repo({ ...PLUGIN, "plugins/fixture/src/config/mod.rs": "pub fn f() {\n    let _ = qol_config::config_dir();\n}\n" });
  const lines = [];
  assert.equal(run(["fix", "--pretty", `--cwd=${root}`], { out: line => lines.push(line), ...quiet() }), EXIT.findings);
  assert.match(lines[0], /^qac fix: 1 findings in 1 files\./);
  assert.match(lines[0], /## plugins\/fixture\/src\/config\/mod.rs/);
  assert.match(lines[0], /\(line 2\)/);
  const clean = repo({ "README.md": "x\n" });
  const out = [];
  assert.equal(run(["fix", "--pretty", `--cwd=${clean}`], { out: line => out.push(line), ...quiet() }), EXIT.clean);
  assert.equal(out[0], "qac fix: 1 files, nothing to fix");
});

const REMOTE = "git@github.com:o/r.git\n";

function gitDeps(config) {
  const files = new Map();
  return {
    files,
    exec: (command, args) => {
      const key = args.join(" ");
      if (key.startsWith("remote get-url")) return REMOTE;
      if (key.startsWith("show ") && config !== null) return JSON.stringify(config);
      throw new Error(`unexpected git ${key}`);
    },
    read: file => {
      if (!files.has(file)) throw new Error(`ENOENT ${file}`);
      return files.get(file);
    },
    write: (file, text) => files.set(file, text),
    env: { XDG_STATE_HOME: "/state", XDG_CONFIG_HOME: "/cfg" },
    now: () => "2026-10-31T00:00:00.000Z",
  };
}

function collect() {
  const lines = [];
  return { lines, out: line => lines.push(line) };
}

test("EXIT adds the gate codes and agrees with the gate module", () => {
  assert.deepEqual(EXIT, { clean: 0, findings: 1, usage: 2, notRepo: 3, forkFailed: 4, couldNotJudge: 5, flakyOnly: 6 });
  for (const [name, code] of Object.entries(GATE_EXIT)) assert.equal(EXIT[name], code, name);
});

test("parseArgs reads the gate flags in either form and repeats --exclude-finding", () => {
  const args = parseArgs([
    "gate", "--cwd", "/w", "--base=main", "--out", "/o", "--accept", "a.json", "--owned=o.json",
    "--spec", "s.md", "--spec-sha", "abc", "--baseline", "b.json",
    "--exclude-finding", "f1=a.js", "--exclude-finding=f2=b=c.js", "--loop", "k", "--attempt", "2", "--keep", "--pretty",
  ]);
  assert.equal(args.verb, "gate");
  assert.deepEqual(
    [args.cwd, args.base, args.out, args.accept, args.owned, args.spec, args.specSha, args.baseline, args.loop, args.attempt],
    ["/w", "main", "/o", "a.json", "o.json", "s.md", "abc", "b.json", "k", "2"],
  );
  assert.deepEqual(args.excludeFindings, ["f1=a.js", "f2=b=c.js"]);
  assert.equal(args.removedExcludeFlag, false);
  assert.equal(args.keep, true);
  assert.equal(args.exclude, false);
  assert.equal(args.pretty, true);
  assert.deepEqual(parseArgs(["gate"]).excludeFindings, []);
  assert.equal(parseArgs(["gate", "--exclude-fingerprint", "f1"]).removedExcludeFlag, true);
  assert.equal(parseArgs(["gate", "--exclude-fingerprint=f1"]).removedExcludeFlag, true);
  assert.equal(parseArgs(["gate"]).attempt, null);
  const slip = parseArgs(["slip", "--fingerprint", "fp", "--from=v", "--judge", "j", "--rule", "r", "--message", "m x", "--route", "tamper", "--min", "3"]);
  assert.deepEqual([slip.fingerprint, slip.from, slip.judge, slip.rule, slip.message, slip.route, slip.min], ["fp", "v", "j", "r", "m x", "tamper", "3"]);
  assert.equal(parseArgs(["init", "--exclude"]).exclude, true);
  assert.deepEqual(parseArgs(["trust", "approve"]).paths, ["approve"]);
});

test("help lists every verb, flag and exit code", () => {
  const help = renderHelp();
  for (const verb of ["qac gate", "qac trust [approve]", "qac traps", "qac init", "qac slip --fingerprint=<fp>"]) assert.ok(help.includes(verb), verb);
  for (const flag of [
    "--out=<dir>", "--accept=<file>", "--owned=<file>", "--spec=<file>", "--spec-sha=<sha>", "--baseline=<gate.json>",
    "--exclude-finding=<fp>=<file>", "--entry=<id>", "--loop=<key>", "--attempt=<n>", "--keep", "--min=<n>", "--exclude", "--judge=<id>",
    "--rule=<rule>", "--message=<text>", "--route=<route>", "--base=<rev>", "--cwd=<dir>", "--pretty",
  ]) assert.ok(help.includes(flag), flag);
  for (const route of ROUTES) assert.ok(help.includes(route), route);
  assert.match(help, /Exit codes: 0 clean, 1 findings.*2 usage, 3 not a git repository, 4 slip lane could not be forked, 5 could not judge, 6 only flaky/);
  const out = [];
  assert.equal(run(["help"], { out: line => out.push(line) }), EXIT.clean);
  assert.deepEqual(JSON.parse(out[0]).verbs, VERBS);
  assert.deepEqual(VERBS, ["lint", "fix", "slip", "slips", "gate", "trust", "traps", "init"]);
  assert.deepEqual(JSON.parse(out[0]).exit, EXIT);
});

test("run gate maps the flags to runGate options and returns its exit code", async () => {
  const calls = [];
  const verdict = { verdict: "findings", reason: null, judges: [], findings: [], tamper: [], omitted: [] };
  const gateDeps = {
    runGate: async options => {
      calls.push(options);
      return { exit: 1, gate: verdict, path: "/g/gate.json" };
    },
  };
  const { lines, out } = collect();
  const flags = [
    "--cwd=/w", "--base", "main", "--out=/o", "--accept", "a.json", "--owned", "o.json", "--spec", "s.md", "--spec-sha", "abc",
    "--baseline", "b.json", "--exclude-finding", "f1=a.js", "--exclude-finding=f2=", "--loop", "k", "--attempt", "2", "--keep",
  ];
  assert.equal(await run(["gate", ...flags], { out, gateDeps }), 1);
  assert.deepEqual(calls[0], {
    cwd: "/w", base: "main", out: "/o", accept: "a.json", owned: "o.json", spec: "s.md", specSha: "abc", baseline: "b.json",
    excludeFindings: [{ fingerprint: "f1", file: "a.js" }, { fingerprint: "f2", file: "" }], loop: "k", attempt: 2, keep: true,
  });
  assert.deepEqual(JSON.parse(lines[0]), { ...verdict, path: "/g/gate.json" });

  assert.equal(await run(["gate", "--cwd=/w", "--pretty"], { out, gateDeps }), 1);
  assert.deepEqual([calls[1].base, calls[1].attempt, calls[1].keep, calls[1].excludeFindings], ["HEAD", null, false, []]);
  assert.equal(lines[1], "qac gate: findings\ngate: /g/gate.json");
});

test("run gate refuses a malformed --exclude-finding and the removed --exclude-fingerprint", async () => {
  const { lines, out } = collect();
  const gateDeps = { runGate: async () => assert.fail("ran the gate") };
  assert.equal(await run(["gate", "--exclude-finding", "nofile"], { out, gateDeps }), EXIT.usage);
  assert.match(JSON.parse(lines[0]).error, /--exclude-finding must be <fingerprint>=<repo-relative file>/);
  assert.equal(await run(["gate", "--exclude-finding", "=a.js"], { out, gateDeps }), EXIT.usage);
  assert.equal(await run(["gate", "--exclude-fingerprint", "f1"], { out, gateDeps }), EXIT.usage);
  assert.match(JSON.parse(lines[2]).error, /--exclude-fingerprint was removed; use --exclude-finding/);
});

test("run gate prints an index failure instead of dropping it", async () => {
  const verdict = { verdict: "clean", reason: null, judges: [], findings: [], tamper: [], omitted: [] };
  const gateDeps = { runGate: async () => ({ exit: 0, gate: verdict, path: "/g/gate.json", indexError: "could not lock /g/gates.jsonl" }) };
  const { lines, out } = collect();
  assert.equal(await run(["gate"], { out, gateDeps }), 0);
  assert.equal(JSON.parse(lines[0]).index_error, "could not lock /g/gates.jsonl");
  assert.equal(await run(["gate", "--pretty"], { out, gateDeps }), 0);
  assert.equal(lines[1], "qac gate: clean\ngate: /g/gate.json\nindex: could not lock /g/gates.jsonl");
});

test("a throw inside the CLI ends with exit 5 and a JSON error, not Node's exit 1", () => {
  const root = repo({});
  const blocker = path.join(root, "afile");
  writeFileSync(blocker, "x");
  const quiet = mkdtempSync(path.join(tmpdir(), "qac-home-"));
  const result = spawnSync(process.execPath, [QAC_CLI, "gate", `--cwd=${root}`, `--out=${path.join(blocker, "out")}`], {
    encoding: "utf8",
    env: { ...process.env, HOME: quiet, XDG_CONFIG_HOME: quiet, XDG_STATE_HOME: quiet, XDG_DATA_HOME: quiet },
  });
  assert.equal(result.status, EXIT.couldNotJudge);
  assert.ok(JSON.parse(result.stdout.trim()).error.length > 0);
});

test("run gate refuses a bad --attempt and passes through a gate that could not start", async () => {
  const { lines, out } = collect();
  const gateDeps = { runGate: async () => ({ exit: 3, gate: null, path: null, error: "/w is not inside a git repository" }) };
  assert.equal(await run(["gate", "--attempt", "x"], { out, gateDeps }), EXIT.usage);
  assert.equal(await run(["gate", "--attempt=0"], { out, gateDeps }), EXIT.usage);
  assert.match(JSON.parse(lines[0]).error, /--attempt must be a positive integer/);
  assert.equal(await run(["gate", "--cwd=/w"], { out, gateDeps }), EXIT.notRepo);
  assert.deepEqual(JSON.parse(lines[2]), { error: "/w is not inside a git repository" });
  assert.equal(await run(["gate", "--cwd=/w", "--pretty"], { out, gateDeps }), EXIT.notRepo);
  assert.equal(lines[3], "qac gate: /w is not inside a git repository");
});

test("run trust reports untrusted commands, approves them, and then exits 0", async () => {
  const config = { version: 1, judges: [{ id: "fmt", argv: ["cargo", "fmt"] }] };
  const gateDeps = gitDeps(config);
  const { lines, out } = collect();
  assert.equal(await run(["trust", "--cwd=/w"], { out, gateDeps }), EXIT.findings);
  const before = JSON.parse(lines[0]);
  assert.equal(before.trusted, false);
  assert.deepEqual(before.untrusted, [{ source: "judges", argv: ["cargo", "fmt"] }]);

  assert.equal(await run(["trust", "--cwd=/w", "--pretty"], { out, gateDeps }), EXIT.findings);
  assert.match(lines[1], /^qac trust: 1 untrusted; run qac trust approve\n  judges: cargo fmt$/);

  assert.equal(await run(["trust", "approve", "--cwd=/w"], { out, gateDeps }), EXIT.clean);
  const approved = JSON.parse(lines[2]);
  assert.equal(approved.approved, true);
  assert.equal(approved.trusted, true);
  assert.deepEqual(approved.newly_approved, before.untrusted);
  assert.ok(gateDeps.files.has(path.join("/state", "qac", "trust.json")));

  assert.equal(await run(["trust", "--cwd=/w"], { out, gateDeps }), EXIT.clean);
  assert.equal(JSON.parse(lines[3]).trusted, true);
  assert.equal(await run(["trust", "--cwd=/w", "--pretty"], { out, gateDeps }), EXIT.clean);
  assert.equal(lines[4], "qac trust: trusted");
});

test("run trust handles --accept, a missing config, and unknown actions", async () => {
  const { lines, out } = collect();
  const config = { version: 1, judges: [] };
  const gateDeps = gitDeps(config);
  gateDeps.files.set(path.resolve("/w", "acc.json"), JSON.stringify([{ id: "build", argv: ["make", "check"] }]));
  assert.equal(await run(["trust", "--cwd=/w", "--accept", "acc.json"], { out, gateDeps }), EXIT.findings);
  assert.deepEqual(JSON.parse(lines[0]).untrusted, [{ source: "accept", argv: ["make", "check"] }]);
  assert.equal(await run(["trust", "approve", "--cwd=/w", "--accept=acc.json"], { out, gateDeps }), EXIT.clean);
  assert.equal(await run(["trust", "--cwd=/w", "--accept=acc.json"], { out, gateDeps }), EXIT.clean);

  const none = gitDeps(null);
  assert.equal(await run(["trust", "--cwd=/w"], { out, gateDeps: none }), EXIT.findings);
  assert.equal(JSON.parse(lines.at(-1)).error, "no judges: run qac init");
  assert.equal(await run(["trust", "bless"], { out, gateDeps }), EXIT.usage);
  assert.equal(await run(["trust", "--accept=missing.json", "--cwd=/w"], { out, gateDeps }), EXIT.usage);
});

test("run traps passes the repository id and --min to findTraps", async () => {
  const seen = [];
  const gateDeps = {
    ...gitDeps(null),
    gitCommonDir: () => "/repo/.git",
    readGates: dir => {
      seen.push(dir);
      return ["line"];
    },
    findTraps: (gateLines, options) => {
      seen.push(gateLines, options);
      return [{ fingerprint: "fp1", judge: "fmt", rule: "exit", message: "diff\nmore", loops: 2 }];
    },
  };
  const { lines, out } = collect();
  assert.equal(await run(["traps", "--cwd=/w"], { out, gateDeps }), EXIT.clean);
  const id = repoId("/w", gateDeps);
  assert.deepEqual(seen, ["/repo/.git", ["line"], { repoId: id, min: 2 }]);
  assert.deepEqual(JSON.parse(lines[0]).traps.map(trap => trap.fingerprint), ["fp1"]);

  assert.equal(await run(["traps", "--cwd=/w", "--min=3", "--pretty"], { out, gateDeps }), EXIT.clean);
  assert.equal(seen.at(-1).min, 3);
  assert.equal(lines[1], "qac traps: 1\nfp1 fmt exit: diff (2 loops)");

  const empty = { ...gateDeps, findTraps: () => ({ traps: [] }) };
  assert.equal(await run(["traps", "--cwd=/w", "--pretty"], { out, gateDeps: empty }), EXIT.clean);
  assert.equal(lines[2], "qac traps: none seen in 2 loops");
  assert.equal(await run(["traps", "--min=0"], { out, gateDeps }), EXIT.usage);
  assert.equal(await run(["traps", "--min=abc"], { out, gateDeps }), EXIT.usage);
  const outside = { ...gateDeps, gitCommonDir: () => { throw new Error("no repo"); } };
  assert.equal(await run(["traps", "--cwd=/w"], { out, gateDeps: outside }), EXIT.notRepo);
});

test("run init writes through initConfig and reports what it wrote", async () => {
  const calls = [];
  const result = { path: "/w/.qac/judges.json", created: true, config: { judges: [{ id: "qac" }, { id: "fmt" }] } };
  const gateDeps = {
    env: { HOME: "/h" },
    gitCommonDir: () => "/w/.git",
    initConfig: (options) => {
      calls.push(options);
      return result;
    },
  };
  const { lines, out } = collect();
  assert.equal(await run(["init", "--cwd=/w", "--exclude"], { out, gateDeps }), EXIT.clean);
  assert.deepEqual(calls[0], { cwd: "/w", exclude: true, env: { HOME: "/h" } });
  assert.deepEqual(JSON.parse(lines[0]), result);
  assert.equal(await run(["init", "--cwd=/w", "--pretty"], { out, gateDeps }), EXIT.clean);
  assert.equal(calls[1].exclude, false);
  assert.equal(lines[1], "qac init: wrote /w/.qac/judges.json (2 judges: qac, fmt); run qac trust approve to trust them");

  const outside = { ...gateDeps, gitCommonDir: () => { throw new Error("no repo"); } };
  const nothing = { ...gateDeps, initConfig: () => ({ path: "/w/.qac/judges.json", created: false, reason: "no judges detected", config: { judges: [] } }) };
  assert.equal(await run(["init", "--cwd=/w", "--pretty"], { out, gateDeps: nothing }), EXIT.clean);
  assert.equal(lines.at(-1), "qac init: no judges detected; wrote nothing");
  assert.equal(await run(["init", "--cwd=/w"], { out, gateDeps: outside }), EXIT.notRepo);
  const broken = { ...gateDeps, initConfig: () => { throw new Error("cannot write"); } };
  assert.equal(await run(["init", "--cwd=/w"], { out, gateDeps: broken }), EXIT.usage);
  assert.equal(JSON.parse(lines.at(-1)).error, "cannot write");
});

test("run slip --fingerprint records through recordFingerprint with the loop and route", async () => {
  const calls = [];
  const record = input => {
    calls.push(input);
    return { entry: {}, due: false, forked: false, handover: false, brief: null, error: null };
  };
  const ledger = { exec: gitDeps(null).exec, recordFingerprint: record };
  const { lines, out } = collect();
  const flags = ["slip", "--fingerprint", "fp1", "--from", "verdict:k", "--judge", "fmt", "--rule", "exit", "--message", "diff", "--loop", "k", "--route", "judge-revert", "--cwd=/w"];
  assert.equal(await run(flags, { out, ledger }), EXIT.clean);
  assert.deepEqual(calls[0], {
    fingerprint: "fp1", judge: "fmt", rule: "exit", message: "diff", from: "verdict:k", loop: "k", route: "judge-revert",
    repoId: repoId("/w", ledger), cwd: "/w", added: false, infeasible: null,
  });
  assert.equal(JSON.parse(lines[0]).error, null);
  assert.equal(await run([...flags, "--pretty"], { out, ledger }), EXIT.clean);
  assert.equal(lines[1], "qac slip: fingerprint fp1 recorded");
});

test("run slip --fingerprint refuses missing sources and unknown routes, and reports fork failures and handovers", async () => {
  const { lines, out } = collect();
  const base = { exec: gitDeps(null).exec };
  assert.equal(await run(["slip", "--fingerprint", "fp1"], { out, ledger: base }), EXIT.usage);
  assert.match(JSON.parse(lines[0]).error, /--fingerprint needs --from <source>/);
  assert.equal(await run(["slip", "--fingerprint", "fp1", "--from", "x", "--route", "bogus"], { out, ledger: base }), EXIT.usage);
  assert.match(JSON.parse(lines[1]).error, /--route must be one of qac-check, repo-linter, tamper, agent-behaviour, judge-revert/);

  const failing = { ...base, recordFingerprint: () => ({ error: "qol sessions fork failed: x", entry: {} }) };
  assert.equal(await run(["slip", "--fingerprint", "fp1", "--from", "x"], { out, ledger: failing }), EXIT.forkFailed);

  const handover = { ...base, recordFingerprint: () => ({ entry: {}, due: true, forked: false, handover: true, brief: "BRIEF TEXT", error: null }) };
  assert.equal(await run(["slip", "--fingerprint", "fp1", "--from", "x", "--pretty"], { out, ledger: handover }), EXIT.clean);
  assert.equal(lines.at(-1), "qac slip: fingerprint fp1 recorded; qol is not on PATH, hand this brief to a lane\nBRIEF TEXT");

  const forked = { ...base, recordFingerprint: () => ({ entry: {}, due: true, forked: true, handover: false, brief: null, error: null }) };
  assert.equal(await run(["slip", "--fingerprint", "fp1", "--from", "x", "--pretty"], { out, ledger: forked }), EXIT.clean);
  assert.equal(lines.at(-1), "qac slip: fingerprint fp1 recorded; forked a rule lane");
});

test("run slip --fingerprint --added and --infeasible settle the existing entry from another cwd", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qac-settle-"));
  const base = gitDeps(null);
  const exec = (command, args, options) => {
    if (options?.cwd !== "/w") throw new Error("not the origin repo");
    return base.exec(command, args);
  };
  const ledger = { file: path.join(dir, "slips.jsonl"), exec, now: base.now, hasQol: () => true };
  const { lines, out } = collect();
  const record = fingerprint => run(["slip", "--fingerprint", fingerprint, "--from", "verdict:a", "--loop", "a", "--judge", "fmt", "--rule", "exit", "--message", "diff", "--cwd=/w"], { out, ledger });
  assert.equal(await record("fp1"), EXIT.clean);
  assert.equal(await record("fp2"), EXIT.clean);
  const id = `fp-${repoId("/w", { exec })}-fp1`;
  assert.deepEqual(listSlips(ledger).map(entry => entry.id).sort(), [id, `fp-${repoId("/w", { exec })}-fp2`].sort());

  assert.equal(await run(["slip", "--fingerprint", "fp1", "--added", "--cwd=/rules"], { out, ledger }), EXIT.clean);
  assert.equal(JSON.parse(lines.at(-1)).error, null);
  assert.equal(await run(["slip", "--fingerprint", "fp2", "--infeasible", "no deterministic rule", "--cwd=/rules"], { out, ledger }), EXIT.clean);

  const settled = new Map(listSlips(ledger).map(entry => [entry.fingerprint, entry]));
  assert.equal(settled.size, 2);
  assert.equal(settled.get("fp1").id, id);
  assert.equal(settled.get("fp1").status, "rule added");
  assert.equal(settled.get("fp2").status, "infeasible");
  assert.equal(settled.get("fp2").reason, "no deterministic rule");
  assert.equal(settled.get("fp1").repo_id, repoId("/w", { exec }));

  assert.equal(await run(["slip", "--fingerprint", "unknown", "--added", "--cwd=/rules"], { out, ledger }), EXIT.usage);
  assert.match(JSON.parse(lines.at(-1)).error, /no ledger entry for fingerprint unknown/);
});

test("run slip --entry settles exactly that entry when two repositories share a fingerprint", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qac-settle-"));
  const ledger = { file: path.join(dir, "slips.jsonl"), now: () => "2026-10-31T00:00:00.000Z", hasQol: () => true };
  const sighting = repoIdValue => ({ fingerprint: "fpx", judge: "clippy", rule: "r", message: "m", from: "a", loop: "a", repoId: repoIdValue });
  recordFingerprint(sighting("aaaa"), ledger);
  recordFingerprint(sighting("bbbb"), ledger);
  const { lines, out } = collect();
  assert.equal(await run(["slip", "--fingerprint", "fpx", "--entry", "fp-bbbb-fpx", "--added", "--cwd=/rules"], { out, ledger }), EXIT.clean);
  assert.deepEqual(listSlips(ledger).map(entry => [entry.id, entry.status]), [["fp-aaaa-fpx", "open"], ["fp-bbbb-fpx", "rule added"]]);
  assert.equal(await run(["slip", "--fingerprint", "fpx", "--entry", "fp-cccc-fpx", "--added", "--cwd=/rules"], { out, ledger }), EXIT.usage);
  assert.match(JSON.parse(lines.at(-1)).error, /no ledger entry fp-cccc-fpx for fingerprint fpx/);
  assert.equal(listSlips(ledger)[0].status, "open");
});

test("run slip --fingerprint --added forwards the entry's identity and the settle flags to recordFingerprint", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "qac-settle-"));
  const file = path.join(dir, "slips.jsonl");
  writeFileSync(file, `${JSON.stringify({ id: "fp-r-fp9", kind: "fingerprint", fingerprint: "fp9", judge: "fmt", rule: "exit", message: "diff", repo_id: "r", status: "open", first_seen: "t", loops: [] })}\n`);
  const calls = [];
  const ledger = { file, recordFingerprint: input => { calls.push(input); return { entry: {}, error: null }; } };
  const { out } = collect();
  assert.equal(await run(["slip", "--fingerprint", "fp9", "--infeasible", "why", "--cwd=/elsewhere"], { out, ledger }), EXIT.clean);
  assert.equal(calls[0].repoId, "r");
  assert.equal(calls[0].infeasible, "why");
  assert.equal(calls[0].added, false);
  assert.deepEqual([calls[0].judge, calls[0].rule, calls[0].message], ["fmt", "exit", "diff"]);
});

test("slip with a pattern still records a slug and an unknown verb is still a usage error", async () => {
  const { lines, out } = collect();
  assert.equal(run(["slip", "--pretty"], { out }), EXIT.usage);
  assert.match(lines[0], /name the pattern qac missed/);
  assert.equal(run(["bogus"], { out }), EXIT.usage);
});
