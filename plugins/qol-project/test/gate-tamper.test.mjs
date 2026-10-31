import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { addedLines, tamperChecks } from "../src/gate/tamper.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function put(root, file, content) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

const BODY = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
const CONFIG = { tests: ["**/test/**", "**/*.test.mjs"], protected: ["docs/locked/**"] };

function makeRepo(extra = {}) {
  const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), "qac-gate-tamper-")));
  const repo = path.join(home, "repo");
  mkdirSync(repo);
  const excludes = path.join(home, "excludes");
  writeFileSync(excludes, "");
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "core.excludesFile", excludes);
  const files = {
    ".gitignore": "ignored.log\n",
    "README.md": "readme\n",
    "src/lib.mjs": `${BODY}\n`,
    "test/a.test.mjs": `${BODY}\n`,
    ".qac/judges.json": "{}\n",
    "docs/locked/spec.md": "locked\n",
    "legacy.py": "value = compute()  # noqa\n",
    ...extra,
  };
  for (const [file, content] of Object.entries(files)) put(repo, file, content);
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "init");
  return { home, repo, excludes };
}

function checks(repo, options = {}, deps = {}) {
  return tamperChecks({ cwd: repo, base: "HEAD", config: CONFIG, ...options }, deps);
}

function ofKind(entries, kind) {
  return entries.filter(entry => entry.kind === kind);
}

test("a clean tree and a plain edit raise nothing", () => {
  const { repo } = makeRepo();
  assert.deepEqual(checks(repo), []);
  appendFileSync(path.join(repo, "README.md"), "more\n");
  put(repo, "src/new.mjs", "export const x = 1;\n");
  assert.deepEqual(checks(repo), []);
});

const SUPPRESSION_CASES = [
  "#[allow(dead_code)]",
  "#[ignore]",
  "// eslint-disable-next-line no-undef",
  "// @ts-ignore",
  "// @ts-expect-error",
  "x = 1  # noqa",
  "y = 2  # type: ignore",
  "it.only('a', () => {});",
  "it.skip('a', () => {});",
  "xit('a', () => {});",
  "@pytest.mark.skip",
];

for (const snippet of SUPPRESSION_CASES) {
  test(`suppression: ${snippet}`, () => {
    const { repo } = makeRepo();
    put(repo, "notes/new.txt", `fine\n${snippet}\n`);
    const found = ofKind(checks(repo), "suppression");
    assert.equal(found.length, 1);
    assert.equal(found[0].file, "notes/new.txt");
    assert.match(found[0].detail, /^line 2: /);
    assert.ok(found[0].detail.includes(snippet.trim()));
  });
}

test("suppression: lines added to a tracked file are reported with the new line number", () => {
  const { repo } = makeRepo();
  appendFileSync(path.join(repo, "src/lib.mjs"), "const a = 1; // eslint-disable-line\n");
  const found = ofKind(checks(repo), "suppression");
  assert.equal(found.length, 1);
  assert.equal(found[0].file, "src/lib.mjs");
  assert.match(found[0].detail, /^line 21: /);
});

test("suppression: removed or untouched suppression lines and process.exit are not reported", () => {
  const { repo } = makeRepo();
  put(repo, "legacy.py", "value = compute()\n");
  put(repo, "src/exit.mjs", "process.exit(1);\n");
  assert.deepEqual(ofKind(checks(repo), "suppression"), []);
  appendFileSync(path.join(repo, "README.md"), "unrelated\n");
  assert.deepEqual(ofKind(checks(repo), "suppression"), []);
});

test("suppression: a staged addition is still seen", () => {
  const { repo } = makeRepo();
  put(repo, "staged.rs", "#[allow(unused)]\nfn f() {}\n");
  git(repo, "add", "staged.rs");
  const found = ofKind(checks(repo), "suppression");
  assert.deepEqual(found.map(entry => entry.file), ["staged.rs"]);
});

test("test-rename: deleting a test file is reported", () => {
  const { repo } = makeRepo();
  rmSync(path.join(repo, "test/a.test.mjs"));
  const found = ofKind(checks(repo), "test-rename");
  assert.deepEqual(found.map(entry => entry.file), ["test/a.test.mjs"]);
});

test("test-rename: moving a test outside the test globs is reported, tracked or not", () => {
  const tracked = makeRepo();
  git(tracked.repo, "mv", "test/a.test.mjs", "src/a.mjs");
  assert.deepEqual(ofKind(checks(tracked.repo), "test-rename").map(entry => entry.file), ["test/a.test.mjs"]);
  const loose = makeRepo();
  renameSync(path.join(loose.repo, "test/a.test.mjs"), path.join(loose.repo, "src/a.mjs"));
  const found = ofKind(checks(loose.repo), "test-rename");
  assert.deepEqual(found.map(entry => entry.file), ["test/a.test.mjs"]);
  assert.match(found[0].detail, /src\/a\.mjs/);
});

test("test-rename: moving a test between test paths is allowed", () => {
  const { repo } = makeRepo();
  renameSync(path.join(repo, "test/a.test.mjs"), path.join(repo, "test/b.test.mjs"));
  assert.deepEqual(ofKind(checks(repo), "test-rename"), []);
});

test("untracked: files hidden only by info/exclude or global excludes are reported", () => {
  const { repo, excludes } = makeRepo();
  appendFileSync(path.join(repo, ".git/info/exclude"), "secret.txt\n");
  writeFileSync(excludes, "*.hidden\n");
  put(repo, "secret.txt", "s\n");
  put(repo, "dir/x.hidden", "h\n");
  put(repo, "ignored.log", "noise\n");
  put(repo, "visible.txt", "v\n");
  const found = ofKind(checks(repo), "untracked");
  assert.deepEqual(found.map(entry => entry.file), ["dir/x.hidden", "secret.txt"]);
});

test("untracked: nothing hidden means nothing reported", () => {
  const { repo } = makeRepo();
  put(repo, "ignored.log", "noise\n");
  assert.deepEqual(ofKind(checks(repo), "untracked"), []);
});

test("protected: .qac/** is always protected and config globs add to it", () => {
  const { repo } = makeRepo();
  put(repo, ".qac/judges.json", '{"version":1}\n');
  put(repo, "docs/locked/spec.md", "edited\n");
  put(repo, "x/.qac/judges.json", "{}\n");
  const files = ofKind(checks(repo), "protected").map(entry => entry.file);
  assert.deepEqual(files.sort(), [".qac/judges.json", "docs/locked/spec.md"]);
  assert.deepEqual(
    ofKind(checks(repo, { config: {} }), "protected").map(entry => entry.file),
    [".qac/judges.json"],
  );
});

test("protected: deleting a protected file is reported", () => {
  const { repo } = makeRepo();
  rmSync(path.join(repo, ".qac/judges.json"));
  assert.deepEqual(ofKind(checks(repo), "protected").map(entry => entry.file), [".qac/judges.json"]);
});

test("owner: only runs with an owned list and flags changes outside it", () => {
  const { repo } = makeRepo();
  appendFileSync(path.join(repo, "src/lib.mjs"), "more\n");
  put(repo, "README.md", "edited\n");
  assert.deepEqual(ofKind(checks(repo), "owner"), []);
  const found = ofKind(checks(repo, { owned: ["src/**"] }), "owner");
  assert.deepEqual(found.map(entry => entry.file), ["README.md"]);
});

test("owner: a rename out of the owned tree is flagged for both paths that fall outside", () => {
  const { repo } = makeRepo();
  git(repo, "mv", "src/lib.mjs", "elsewhere.mjs");
  const found = ofKind(checks(repo, { owned: ["src/**"] }), "owner");
  assert.deepEqual(found.map(entry => entry.file), ["elsewhere.mjs"]);
});

test("spec-sha: matching, mismatching and unreadable specs", () => {
  const { home, repo } = makeRepo();
  const spec = path.join(home, "spec.md");
  writeFileSync(spec, "the spec\n");
  const sha = createHash("sha256").update("the spec\n").digest("hex");
  assert.deepEqual(ofKind(checks(repo, { specPath: spec, specSha: sha }), "spec-sha"), []);
  const wrong = ofKind(checks(repo, { specPath: spec, specSha: "0".repeat(64) }), "spec-sha");
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0].file, spec);
  assert.ok(wrong[0].detail.includes(sha));
  const missing = ofKind(checks(repo, { specPath: path.join(home, "none.md"), specSha: sha }), "spec-sha");
  assert.equal(missing.length, 1);
  assert.match(missing[0].detail, /unreadable/);
  assert.deepEqual(ofKind(checks(repo, { specPath: spec }), "spec-sha"), []);
});

test("entries come out grouped in contract order", () => {
  const { home, repo } = makeRepo();
  const spec = path.join(home, "spec.md");
  writeFileSync(spec, "x");
  put(repo, "src/bad.mjs", "// @ts-ignore\n");
  rmSync(path.join(repo, "test/a.test.mjs"));
  put(repo, ".qac/judges.json", "{}\n\n");
  const kinds = checks(repo, { owned: ["src/**"], specPath: spec, specSha: "0".repeat(64) }).map(entry => entry.kind);
  assert.deepEqual(kinds, ["suppression", "test-rename", "protected", "owner", "owner", "spec-sha"]);
});

test("injected exec and read replace git and the filesystem", () => {
  const calls = [];
  const exec = (command, args) => {
    calls.push(args[0]);
    return "";
  };
  const read = () => "spec text";
  const entries = tamperChecks(
    { cwd: "/nowhere", base: "HEAD", config: {}, specPath: "spec.md", specSha: "0".repeat(64) },
    { exec, read, tree: "deadbeef" },
  );
  assert.deepEqual(entries.map(entry => entry.kind), ["spec-sha"]);
  assert.ok(calls.includes("diff-tree"));
  assert.ok(calls.includes("ls-files"));
});

test("addedLines tracks new-file line numbers across hunks and files", () => {
  const patch = [
    "diff --git a/x.txt b/x.txt",
    "--- a/x.txt",
    "+++ b/x.txt",
    "@@ -1,0 +2,2 @@",
    "+two",
    "+three",
    "@@ -10 +12 @@",
    "-old",
    "+twelve",
    "\\ No newline at end of file",
    "diff --git a/gone.txt b/gone.txt",
    "deleted file mode 100644",
    "--- a/gone.txt",
    "+++ /dev/null",
    "@@ -1 +0,0 @@",
    "-bye",
    "diff --git a/y.txt b/y.txt",
    "--- /dev/null",
    "+++ b/y.txt",
    "@@ -0,0 +1 @@",
    "+++ looks like a header but is content",
  ].join("\n");
  assert.deepEqual(addedLines(patch), [
    { file: "x.txt", line: 2, text: "two" },
    { file: "x.txt", line: 3, text: "three" },
    { file: "x.txt", line: 12, text: "twelve" },
    { file: "y.txt", line: 1, text: "++ looks like a header but is content" },
  ]);
});
