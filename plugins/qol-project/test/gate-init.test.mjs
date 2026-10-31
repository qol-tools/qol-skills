import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ALWAYS_PROTECTED } from "../src/gate/config.mjs";
import { detectConfig, initConfig } from "../src/gate/init.mjs";

function scratch(files = {}) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "qac-gate-init-")));
  const repo = path.join(root, "repo");
  mkdirSync(repo);
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(repo, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return { root, repo };
}

function ids(config) {
  return config.judges.map(judge => judge.id);
}

test("an empty directory detects a valid config with no judges", () => {
  const { repo } = scratch();
  const config = detectConfig(repo);
  assert.equal(config.version, 1);
  assert.deepEqual(config.judges, []);
  assert.deepEqual(config.setup, []);
  assert.deepEqual(config.protected, [...ALWAYS_PROTECTED]);
  assert.deepEqual(config.defaults, { test_runs_on_red: 3, timeout_s: 600 });
  assert.deepEqual(config.retention, { loops: 50 });
  assert.ok(config.tests.includes("**/test/**"));
});

test("cargo detects fmt, clippy and tests", () => {
  const { repo } = scratch({ "Cargo.toml": "[package]\nname = \"x\"\n", "clippy.toml": "" });
  const config = detectConfig(repo);
  assert.deepEqual(ids(config), ["fmt", "clippy", "cargo-test"]);
  const [fmt, clippy, tests] = config.judges;
  assert.deepEqual(fmt.argv, ["cargo", "fmt", "--all", "--check"]);
  assert.equal(fmt.parser, "exit-code");
  assert.equal(clippy.parser, "cargo-json");
  assert.equal(clippy.rules_home, "clippy.toml");
  assert.ok(clippy.argv.includes("--message-format=json"));
  assert.equal(tests.kind, "test");
  assert.deepEqual(config.accept_prefixes, [["cargo", "test"]]);
});

test("clippy rules_home falls back to Cargo.toml", () => {
  const { repo } = scratch({ "Cargo.toml": "[package]\n" });
  assert.equal(detectConfig(repo).judges[1].rules_home, "Cargo.toml");
});

test("npm scripts become lint and test judges and the lockfile picks the setup", () => {
  const { repo } = scratch({
    "package.json": JSON.stringify({ scripts: { lint: "eslint .", test: "mocha" } }),
    "package-lock.json": "{}",
  });
  const config = detectConfig(repo);
  assert.deepEqual(ids(config), ["npm-lint", "npm-test"]);
  assert.deepEqual(config.judges[0].argv, ["npm", "run", "lint"]);
  assert.deepEqual(config.judges[1].argv, ["npm", "test"]);
  assert.equal(config.judges[1].kind, "test");
  assert.deepEqual(config.setup, [["npm", "ci"]]);
  assert.deepEqual(config.accept_prefixes, [["node", "--test"]]);
});

const SETUP_CASES = [
  ["pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"]],
  ["yarn.lock", ["yarn", "install", "--frozen-lockfile"]],
];

for (const [lock, expected] of SETUP_CASES) {
  test(`setup follows ${lock}`, () => {
    const { repo } = scratch({ "package.json": JSON.stringify({ scripts: { test: "x" } }), [lock]: "" });
    assert.deepEqual(detectConfig(repo).setup, [expected]);
  });
}

test("a node --test script uses the tap reporter, a no-op test script is skipped", () => {
  const tap = scratch({ "package.json": JSON.stringify({ scripts: { test: "node --test test/" } }) });
  const judge = detectConfig(tap.repo).judges[0];
  assert.deepEqual(judge.argv, ["npm", "test", "--", "--test-reporter=tap"]);
  assert.equal(judge.parser, "tap");
  const chained = scratch({ "package.json": JSON.stringify({ scripts: { test: "node --test && echo done" } }) });
  assert.equal(detectConfig(chained.repo).judges[0].parser, "exit-code");
  const none = scratch({ "package.json": JSON.stringify({ scripts: { test: "echo \"Error: no test specified\" && exit 1" } }) });
  assert.deepEqual(detectConfig(none.repo).judges, []);
  const broken = scratch({ "package.json": "{not json" });
  assert.deepEqual(detectConfig(broken.repo).judges, []);
});

test("pyproject detects ruff and pytest", () => {
  const { repo } = scratch({ "pyproject.toml": "[tool.ruff]\nline-length = 100\n\n[tool.pytest.ini_options]\n", "uv.lock": "" });
  const config = detectConfig(repo);
  assert.deepEqual(ids(config), ["ruff", "pytest"]);
  assert.equal(config.judges[0].parser, "sarif");
  assert.equal(config.judges[0].rules_home, "pyproject.toml");
  assert.equal(config.judges[1].kind, "test");
  assert.deepEqual(config.setup, [["uv", "sync"]]);
});

test("ruff.toml alone detects ruff only", () => {
  const { repo } = scratch({ "ruff.toml": "" });
  const config = detectConfig(repo);
  assert.deepEqual(ids(config), ["ruff"]);
  assert.equal(config.judges[0].rules_home, "ruff.toml");
});

test("go.mod detects vet and test", () => {
  const { repo } = scratch({ "go.mod": "module x\n" });
  const config = detectConfig(repo);
  assert.deepEqual(ids(config), ["go-vet", "go-test"]);
  assert.deepEqual(config.accept_prefixes, [["go", "test"]]);
});

test("a .qac directory adds the qac-lint builtin", () => {
  const { repo } = scratch({ ".qac/notes.md": "" });
  assert.deepEqual(detectConfig(repo).judges, [{ id: "qac", builtin: "qac-lint", scope: "changed" }]);
});

test("a polyglot repo has unique judge ids and de-duplicated setup", () => {
  const { repo } = scratch({
    "Cargo.toml": "[package]\n",
    "go.mod": "module x\n",
    "package.json": JSON.stringify({ scripts: { lint: "x", test: "y" } }),
    "package-lock.json": "{}",
    "ruff.toml": "",
  });
  const all = ids(detectConfig(repo));
  assert.equal(new Set(all).size, all.length);
  assert.equal(all.length, 8);
});

test("detectConfig reads through injected exists and read", () => {
  const present = new Set([path.join("/fake", "go.mod")]);
  const config = detectConfig("/fake", { exists: file => present.has(file), read: () => { throw new Error("no"); } });
  assert.deepEqual(ids(config), ["go-vet", "go-test"]);
});

test("initConfig writes .qac/judges.json at the repo top level and never overwrites it", () => {
  const { repo } = scratch({ "Cargo.toml": "[package]\n", "sub/keep.txt": "" });
  const exec = () => `${repo}\n`;
  const first = initConfig({ cwd: path.join(repo, "sub"), env: {} }, { exec });
  assert.equal(first.created, true);
  assert.equal(first.path, path.join(repo, ".qac", "judges.json"));
  assert.deepEqual(JSON.parse(readFileSync(first.path, "utf8")), first.config);
  assert.deepEqual(ids(first.config), ["fmt", "clippy", "cargo-test"]);
  writeFileSync(first.path, '{"version":1,"judges":[],"custom":true}\n');
  const second = initConfig({ cwd: repo, env: {} }, { exec });
  assert.equal(second.created, false);
  assert.equal(second.path, first.path);
  assert.deepEqual(second.config, { version: 1, judges: [], custom: true });
  assert.equal(readFileSync(first.path, "utf8"), '{"version":1,"judges":[],"custom":true}\n');
});

test("initConfig with exclude writes the per-user file under XDG_CONFIG_HOME and leaves the repo alone", () => {
  const { root, repo } = scratch({ "go.mod": "module x\n" });
  const xdg = path.join(root, "xdg");
  const deps = { exec: () => `${repo}\n`, repoId: () => "0123456789abcdef" };
  const result = initConfig({ cwd: repo, exclude: true, env: { XDG_CONFIG_HOME: xdg } }, deps);
  assert.equal(result.created, true);
  assert.equal(result.path, path.join(xdg, "qac", "judges", "0123456789abcdef.json"));
  assert.deepEqual(JSON.parse(readFileSync(result.path, "utf8")), result.config);
  assert.equal(existsSync(path.join(repo, ".qac")), false);
  const again = initConfig({ cwd: repo, exclude: true, env: { XDG_CONFIG_HOME: xdg } }, deps);
  assert.equal(again.created, false);
  assert.deepEqual(again.config, result.config);
});

test("initConfig with exclude defaults to ~/.config", () => {
  const { root, repo } = scratch({ "go.mod": "module x\n" });
  const result = initConfig(
    { cwd: repo, exclude: true, env: { HOME: root } },
    { exec: () => `${repo}\n`, repoId: () => "abcdefabcdefabcd" },
  );
  assert.equal(result.path, path.join(root, ".config", "qac", "judges", "abcdefabcdefabcd.json"));
});

test("initConfig refuses to write a config with no judges", () => {
  const { repo } = scratch();
  const result = initConfig({ cwd: repo, env: {} }, { exec: () => `${repo}\n` });
  assert.equal(result.created, false);
  assert.equal(result.reason, "no judges detected");
  assert.equal(existsSync(path.join(repo, ".qac")), false);
});
