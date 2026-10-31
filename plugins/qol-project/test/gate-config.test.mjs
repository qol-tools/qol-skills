import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import {
  CONFIG_PATH, canonicalJson, judgesSha, loadConfig, normalizeConfig, normalizeJudge,
  normalizeRemote, repoId, setupSha, userConfigPath, validateConfig,
} from "../src/gate/config.mjs";

const sha16 = text => createHash("sha256").update(text).digest("hex").slice(0, 16);

const VALID = {
  version: 1,
  setup: [["npm", "ci"]],
  protected: ["docs/**"],
  tests: ["**/test/**"],
  accept_prefixes: [["node", "--test"]],
  defaults: { test_runs_on_red: 2, timeout_s: 30 },
  judges: [
    { id: "qac", builtin: "qac-lint", scope: "changed" },
    { id: "fmt", argv: ["cargo", "fmt", "--check"], parser: "exit-code", scope: "repo", timeout_s: 120 },
    { id: "clippy", argv: ["cargo", "clippy"], parser: "cargo-json", where: "ci", rules_home: "clippy.toml" },
    { id: "unit", argv: ["node", "--test"], parser: "junit", kind: "test", report: "out.xml" },
  ],
  retention: { loops: 7 },
};

function gitFake(answers) {
  const calls = [];
  const exec = (command, args, options) => {
    calls.push({ command, args, cwd: options?.cwd });
    const key = args.join(" ");
    for (const [pattern, value] of Object.entries(answers)) {
      if (key.startsWith(pattern)) {
        if (value instanceof Error) throw value;
        return value;
      }
    }
    throw new Error(`unexpected git ${key}`);
  };
  return { exec, calls };
}

test("canonicalJson sorts keys recursively and keeps array order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalJson({ a: 1, b: 2 }), canonicalJson({ b: 2, a: 1 }));
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
});

test("judgesSha hashes the sorted judges array and ignores key order", () => {
  const a = { judges: [{ id: "x", argv: ["a"] }] };
  const b = { judges: [{ argv: ["a"], id: "x" }] };
  assert.equal(judgesSha(a), judgesSha(b));
  assert.equal(judgesSha(a), createHash("sha256").update('[{"argv":["a"],"id":"x"}]').digest("hex"));
  assert.notEqual(judgesSha(a), judgesSha({ judges: [{ id: "x", argv: ["b"] }] }));
  assert.equal(judgesSha(null), judgesSha({ judges: [] }));
  assert.notEqual(setupSha({ setup: [["npm", "ci"]] }), setupSha({ setup: [] }));
});

test("normalizeRemote turns the url forms of one repository into the same text", () => {
  const forms = [
    "git@github.com:Org/Repo.git",
    "https://github.com/org/repo.git",
    "https://user:token@github.com/org/repo/",
    "ssh://git@github.com/org/repo.git",
    "git://github.com/org/repo",
  ];
  for (const form of forms) assert.equal(normalizeRemote(form), "github.com/org/repo");
  assert.equal(normalizeRemote("ssh://git@host:2222/org/repo.git"), "host:2222/org/repo");
});

test("repoId hashes the origin url, else the main clone path", () => {
  const withRemote = gitFake({ "remote get-url origin": "git@github.com:Org/Repo.git\n" });
  assert.equal(repoId("/w", { exec: withRemote.exec }), sha16("github.com/org/repo"));
  assert.equal(withRemote.calls.length, 1);

  const without = gitFake({
    "remote get-url origin": new Error("no remote"),
    "rev-parse --path-format=absolute --git-common-dir": "/home/me/code/proj/.git\n",
  });
  assert.equal(repoId("/home/me/code/proj/sub", { exec: without.exec }), sha16("/home/me/code/proj"));

  const worktree = gitFake({
    "remote get-url origin": "",
    "rev-parse --path-format=absolute --git-common-dir": "/home/me/code/proj/.git\n",
  });
  assert.equal(repoId("/home/me/worktrees/x", { exec: worktree.exec }), sha16("/home/me/code/proj"));
});

test("userConfigPath follows XDG_CONFIG_HOME, else ~/.config", () => {
  assert.equal(userConfigPath("abc", { XDG_CONFIG_HOME: "/cfg" }), path.join("/cfg", "qac", "judges", "abc.json"));
  assert.equal(userConfigPath("abc", { HOME: "/home/me" }), path.join("/home/me", ".config", "qac", "judges", "abc.json"));
});

test("validateConfig accepts the documented shape", () => {
  assert.deepEqual(validateConfig(VALID), []);
  assert.deepEqual(validateConfig({ version: 1, judges: [] }), []);
});

test("validateConfig names every kind of mistake", () => {
  const cases = [
    [null, /config must be a JSON object/],
    [{ version: 2, judges: [] }, /version must be 1/],
    [{ version: 1 }, /judges must be an array/],
    [{ version: 1, judges: [], setup: [["npm"], []] }, /setup must be an array of non-empty argv arrays/],
    [{ version: 1, judges: [], tests: "x" }, /tests must be an array of glob strings/],
    [{ version: 1, judges: [], protected: [1] }, /protected must be an array of glob strings/],
    [{ version: 1, judges: [], accept_prefixes: [[]] }, /accept_prefixes/],
    [{ version: 1, judges: [], defaults: { test_runs_on_red: 0 } }, /test_runs_on_red must be a positive integer/],
    [{ version: 1, judges: [], defaults: { timeout_s: -1 } }, /defaults.timeout_s/],
    [{ version: 1, judges: [], retention: { loops: 0 } }, /retention.loops/],
    [{ version: 1, judges: ["x"] }, /judges\[0\] must be an object/],
    [{ version: 1, judges: [{ argv: ["a"] }] }, /judges\[0\].id must be a non-empty string/],
    [{ version: 1, judges: [{ id: "a", argv: ["a"] }, { id: "a", argv: ["b"] }] }, /judges\[1\].id "a" is not unique/],
    [{ version: 1, judges: [{ id: "a" }] }, /needs exactly one of argv or builtin/],
    [{ version: 1, judges: [{ id: "a", argv: ["a"], builtin: "qac-lint" }] }, /needs exactly one of argv or builtin/],
    [{ version: 1, judges: [{ id: "a", argv: [] }] }, /argv must be a non-empty argv array/],
    [{ version: 1, judges: [{ id: "a", builtin: "other" }] }, /builtin must be one of qac-lint/],
    [{ version: 1, judges: [{ id: "a", argv: ["a"], parser: "xml" }] }, /parser must be one of/],
    [{ version: 1, judges: [{ id: "a", argv: ["a"], scope: "all" }] }, /scope must be one of changed, repo/],
    [{ version: 1, judges: [{ id: "a", argv: ["a"], where: "cloud" }] }, /where must be one of local, ci/],
    [{ version: 1, judges: [{ id: "a", argv: ["a"], kind: "perf" }] }, /kind must be one of lint, test/],
    [{ version: 1, judges: [{ id: "a", argv: ["a"], timeout_s: 0 }] }, /timeout_s must be a positive number/],
    [{ version: 1, judges: [{ id: "a", argv: ["a"], report: "" }] }, /report must be a non-empty string/],
  ];
  for (const [config, expected] of cases) {
    const errors = validateConfig(config);
    assert.ok(errors.some(error => expected.test(error)), `${JSON.stringify(config)} -> ${errors.join(" | ")}`);
  }
});

test("normalizeConfig fills defaults and always protects .qac/**", () => {
  const config = normalizeConfig({ version: 1, judges: [] });
  assert.deepEqual(config.protected, [".qac/**"]);
  assert.deepEqual(config.defaults, { test_runs_on_red: 3, timeout_s: 600 });
  assert.deepEqual(config.retention, { loops: 50 });
  assert.deepEqual([config.setup, config.tests, config.accept_prefixes], [[], [], []]);
  const filled = normalizeConfig(VALID);
  assert.deepEqual(filled.protected, [".qac/**", "docs/**"]);
  assert.deepEqual(filled.defaults, { test_runs_on_red: 2, timeout_s: 30 });
  assert.equal(filled.retention.loops, 7);
  assert.equal(normalizeConfig({ ...VALID, protected: [".qac/**"] }).protected.length, 1);
});

test("normalizeJudge applies the documented defaults", () => {
  assert.deepEqual(normalizeJudge({ id: "a", argv: ["a"] }, { timeout_s: 9 }), {
    parser: "exit-code", scope: "repo", where: "local", kind: "lint", timeout_s: 9, id: "a", argv: ["a"],
  });
  assert.equal(normalizeJudge({ id: "a", argv: ["a"], timeout_s: 5 }, { timeout_s: 9 }).timeout_s, 5);
  assert.equal(normalizeJudge({ id: "a", argv: ["a"] }).timeout_s, 600);
});

test("loadConfig reads the file at the base revision first", () => {
  const git = gitFake({
    "remote get-url origin": "https://github.com/o/r.git",
    "show main:.qac/judges.json": JSON.stringify(VALID),
  });
  const read = () => {
    throw new Error("the user file must not be read");
  };
  const loaded = loadConfig({ cwd: "/w", base: "main" }, { exec: git.exec, read });
  assert.equal(loaded.source, "base");
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.repoId, sha16("github.com/o/r"));
  assert.equal(loaded.judgesSha, judgesSha(VALID));
  assert.equal(loaded.config.judges.length, 4);
  assert.ok(git.calls.some(call => call.args.join(" ") === `show main:${CONFIG_PATH}`));
});

test("loadConfig defaults the base to HEAD and falls back to the user file", () => {
  const git = gitFake({
    "remote get-url origin": "https://github.com/o/r.git",
    "show HEAD:.qac/judges.json": new Error("path not in HEAD"),
  });
  const files = new Map();
  const id = sha16("github.com/o/r");
  const env = { XDG_CONFIG_HOME: "/cfg" };
  files.set(userConfigPath(id, env), JSON.stringify({ version: 1, judges: [{ id: "a", argv: ["a"] }] }));
  const read = file => {
    if (!files.has(file)) throw new Error("ENOENT");
    return files.get(file);
  };
  const loaded = loadConfig({ cwd: "/w" }, { exec: git.exec, read, env });
  assert.equal(loaded.source, "user");
  assert.equal(loaded.config.judges[0].id, "a");
});

test("loadConfig returns no config when neither source exists, and never reads the working tree", () => {
  const git = gitFake({
    "remote get-url origin": "https://github.com/o/r.git",
    "show HEAD:.qac/judges.json": new Error("missing"),
  });
  const reads = [];
  const read = file => {
    reads.push(file);
    throw new Error("ENOENT");
  };
  const loaded = loadConfig({ cwd: "/w" }, { exec: git.exec, read, env: { XDG_CONFIG_HOME: "/cfg" } });
  assert.deepEqual(loaded, { config: null, source: null, repoId: sha16("github.com/o/r"), judgesSha: null, errors: [] });
  assert.deepEqual(reads, [userConfigPath(loaded.repoId, { XDG_CONFIG_HOME: "/cfg" })]);
  assert.ok(reads.every(file => !file.startsWith("/w")));
});

test("loadConfig reports invalid JSON and invalid shapes as errors with no config", () => {
  const broken = gitFake({ "remote get-url origin": "https://github.com/o/r", "show HEAD:": "{not json" });
  const first = loadConfig({ cwd: "/w" }, { exec: broken.exec });
  assert.equal(first.config, null);
  assert.equal(first.source, "base");
  assert.match(first.errors[0], /HEAD:\.qac\/judges\.json is not valid JSON/);

  const wrong = gitFake({ "remote get-url origin": "https://github.com/o/r", "show HEAD:": JSON.stringify({ version: 1, judges: [{ id: "a" }] }) });
  const second = loadConfig({ cwd: "/w" }, { exec: wrong.exec });
  assert.equal(second.config, null);
  assert.equal(second.judgesSha, null);
  assert.match(second.errors[0], /needs exactly one of argv or builtin/);
});
