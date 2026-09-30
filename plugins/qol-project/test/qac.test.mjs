import test from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parsePrompt } from "../hooks/qac-intercept.mjs";
import { lint, renderLint, summarize } from "../src/qac.mjs";
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
  assert.deepEqual(parsePrompt("qac lint", ""), ["lint", "--prefix=qac", "--pretty"]);
  assert.deepEqual(parsePrompt("QAC lint plugins/launcher", ""), ["lint", "plugins/launcher", "--prefix=qac", "--pretty"]);
  assert.deepEqual(parsePrompt("qac plugins/shot", ""), ["lint", "plugins/shot", "--prefix=qac", "--pretty"]);
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

test("run returns typed exit codes and renders pretty output", () => {
  const clean = repo({ "README.md": "x\n" });
  const lines = [];
  assert.equal(run(["lint", "--pretty", `--cwd=${clean}`], { out: line => lines.push(line) }), EXIT.clean);
  assert.match(lines[0], /^qac lint: 1 files, 0 findings$/);
  assert.equal(run(["bogus"], { out: () => {} }), EXIT.usage);
  const outside = mkdtempSync(path.join(tmpdir(), "qac-none-"));
  assert.equal(run(["lint", `--cwd=${outside}`], { out: () => {} }), EXIT.notRepo);
});

test("renderLint groups findings by hook", () => {
  const text = renderLint({
    files: 2,
    findings: [{ file: "a.rs", hook: "qol-logging", summary: "New dbg!" }],
  });
  assert.equal(text, "qac lint: 2 files, 1 findings\n\nqol-logging (1)\n  a.rs  New dbg!");
});
