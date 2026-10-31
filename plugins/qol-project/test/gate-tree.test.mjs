import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { changeEntries, changedFiles, gitCommonDir, matchGlob, treeId } from "../src/gate/tree.mjs";

function git(cwd, ...args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function put(root, file, content) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
}

function makeRepo(files = {}) {
  const home = realpathSync.native(mkdtempSync(path.join(tmpdir(), "qac-gate-tree-")));
  const repo = path.join(home, "repo");
  mkdirSync(repo);
  put(home, "excludes", "");
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "t@example.com");
  git(repo, "config", "user.name", "t");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "core.excludesFile", path.join(home, "excludes"));
  for (const [file, content] of Object.entries(files)) put(repo, file, content);
  if (Object.keys(files).length) {
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "init");
  }
  return { home, repo };
}

const BODY = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");

test("gitCommonDir resolves the shared .git from the main clone, a subdirectory and a linked worktree", () => {
  const { home, repo } = makeRepo({ "a.txt": "a\n", "sub/b.txt": "b\n" });
  const common = realpathSync.native(path.join(repo, ".git"));
  assert.equal(gitCommonDir(repo), common);
  assert.equal(gitCommonDir(path.join(repo, "sub")), common);
  const linked = path.join(home, "linked");
  git(repo, "worktree", "add", "-q", "-b", "linked", linked);
  assert.equal(gitCommonDir(linked), common);
});

test("changedFiles lists staged, unstaged and untracked files sorted, skipping deleted and ignored ones", () => {
  const { repo } = makeRepo({ ".gitignore": "ignored.log\n", "a.txt": "a\n", "b.txt": "b\n", "gone.txt": "g\n", "sub/c.txt": "c\n" });
  put(repo, "a.txt", "a changed\n");
  put(repo, "b.txt", "b changed\n");
  git(repo, "add", "b.txt");
  rmSync(path.join(repo, "gone.txt"));
  put(repo, "z-new.txt", "new\n");
  put(repo, "sub/deep/new.txt", "new\n");
  put(repo, "ignored.log", "noise\n");
  assert.deepEqual(changedFiles(repo, "HEAD"), ["a.txt", "b.txt", "sub/deep/new.txt", "z-new.txt"]);
});

test("changedFiles reports committed changes against an older base and nothing when clean", () => {
  const { repo } = makeRepo({ "a.txt": "a\n" });
  assert.deepEqual(changedFiles(repo, "HEAD"), []);
  put(repo, "b.txt", "b\n");
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", "second");
  assert.deepEqual(changedFiles(repo, "HEAD"), []);
  assert.deepEqual(changedFiles(repo, "HEAD~1"), ["b.txt"]);
});

test("changedFiles works from a subdirectory and returns repo-relative paths", () => {
  const { repo } = makeRepo({ "sub/a.txt": "a\n" });
  put(repo, "sub/a.txt", "changed\n");
  put(repo, "top.txt", "t\n");
  assert.deepEqual(changedFiles(path.join(repo, "sub"), "HEAD"), ["sub/a.txt", "top.txt"]);
});

test("changeEntries detects renames, including a rename whose target is untracked", () => {
  const { repo } = makeRepo({ "test/a.test.mjs": BODY, "keep.txt": "k\n", "old.txt": "completely different\n" });
  renameSync(path.join(repo, "test/a.test.mjs"), path.join(repo, "src-a.mjs"));
  rmSync(path.join(repo, "old.txt"));
  put(repo, "fresh.txt", "fresh and unrelated\n");
  const entries = changeEntries(repo, "HEAD");
  const rename = entries.find(entry => entry.status === "R");
  assert.equal(rename.from, "test/a.test.mjs");
  assert.equal(rename.path, "src-a.mjs");
  assert.ok(entries.some(entry => entry.status === "D" && entry.path === "old.txt"));
  assert.ok(entries.some(entry => entry.status === "A" && entry.path === "fresh.txt"));
});

test("treeId matches git add -A plus write-tree without touching the real index", () => {
  const { repo } = makeRepo({ "a.txt": "a\n" });
  put(repo, "a.txt", "changed\n");
  put(repo, "new.txt", "new\n");
  const before = git(repo, "status", "--porcelain");
  const id = treeId(repo);
  assert.match(id, /^[0-9a-f]{40}$/);
  assert.equal(git(repo, "status", "--porcelain"), before);
  assert.equal(git(repo, "diff", "--cached", "--name-only"), "");
  git(repo, "add", "-A");
  assert.equal(git(repo, "write-tree").trim(), id);
});

test("treeId changes with content, ignores ignored files and is stable across calls", () => {
  const { repo } = makeRepo({ ".gitignore": "ignored.log\n", "a.txt": "a\n" });
  const first = treeId(repo);
  assert.equal(treeId(repo), first);
  put(repo, "ignored.log", "noise\n");
  assert.equal(treeId(repo), first);
  put(repo, "a.txt", "changed\n");
  assert.notEqual(treeId(repo), first);
});

test("treeId on a clean checkout equals the HEAD tree", () => {
  const { repo } = makeRepo({ "a.txt": "a\n" });
  assert.equal(treeId(repo), git(repo, "rev-parse", "HEAD^{tree}").trim());
});

test("treeId and changedFiles work in a repository with no commits", () => {
  const { repo } = makeRepo();
  put(repo, "first.txt", "1\n");
  assert.match(treeId(repo), /^[0-9a-f]{40}$/);
  assert.deepEqual(changedFiles(repo, "HEAD"), ["first.txt"]);
});

test("treeId leaves no temporary index directory behind", () => {
  const { repo } = makeRepo({ "a.txt": "a\n" });
  const dirs = [];
  const exec = (command, args, options) => {
    if (options.env.GIT_INDEX_FILE) dirs.push(path.dirname(options.env.GIT_INDEX_FILE));
    return execFileSync(command, args, options);
  };
  treeId(repo, { exec });
  assert.ok(dirs.length > 0);
  for (const dir of dirs) assert.throws(() => realpathSync(dir));
});

const GLOB_CASES = [
  ["**/test/**", "test/a.mjs", true],
  ["**/test/**", "plugins/x/test/deep/a.mjs", true],
  ["**/test/**", "contest/a.mjs", false],
  ["**/*.test.mjs", "a.test.mjs", true],
  ["**/*.test.mjs", "plugins/x/a.test.mjs", true],
  ["**/*.test.mjs", "plugins/x/a.test.js", false],
  [".qac/**", ".qac/judges.json", true],
  [".qac/**", ".qac/sub/deep.json", true],
  [".qac/**", "x/.qac/judges.json", false],
  ["plugins/x/**", "plugins/x/src/a.rs", true],
  ["plugins/x/**", "plugins/xy/src/a.rs", false],
  ["src/*.rs", "src/a.rs", true],
  ["src/*.rs", "src/deep/a.rs", false],
  ["src/?.rs", "src/a.rs", true],
  ["src/?.rs", "src/ab.rs", false],
  ["src/{a,b}.rs", "src/b.rs", true],
  ["src/{a,b}.rs", "src/c.rs", false],
  ["{src,lib}/**/*.{rs,toml}", "lib/x/y/z.toml", true],
  ["{src,lib}/**/*.{rs,toml}", "lib/z.rs", true],
  ["{src,lib}/**/*.{rs,toml}", "bin/z.rs", false],
  ["a/{b,c{d,e}}/f", "a/ce/f", true],
  ["a/{b,c{d,e}}/f", "a/cf/f", false],
  ["*.test.*", "deep/dir/a.test.mjs", true],
  ["Cargo.lock", "Cargo.lock", true],
  ["Cargo.lock", "sub/Cargo.lock", false],
  ["docs", "docs/readme.md", true],
  ["./src/**", "src/a.rs", true],
  ["src/**", "src\\a.rs", true],
];

for (const [glob, file, expected] of GLOB_CASES) {
  test(`matchGlob ${glob} vs ${file} is ${expected}`, () => {
    assert.equal(matchGlob(glob, file), expected);
  });
}
