import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parsePrompt } from "../hooks/qac-intercept.mjs";
import { lint, splitRule, summarize } from "../src/qac.mjs";
import { progressReporter } from "../src/progress.mjs";
import { renderReport } from "../src/report.mjs";
import { EXIT, run } from "../scripts/qac.mjs";

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
