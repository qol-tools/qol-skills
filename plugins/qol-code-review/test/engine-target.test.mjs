import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after } from "node:test";
import { EXIT } from "../src/errors.mjs";
import { commandRunner } from "../src/git.mjs";
import { EMPTY_TREE } from "../src/git.mjs";
import { parseTarget, resolveTarget } from "../src/target.mjs";
import { ENV, catching, commit, fakeGh, makeRepo, numbered, sh, tempRoot, write, test } from "./engine-helpers.mjs";

const root = tempRoot();
after(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture(name) {
  const dir = makeRepo(root, name);
  const base = commit(dir, { "src/app.js": numbered(20) }, "base");
  return { dir, base, git: commandRunner("git", dir, { env: ENV }) };
}

function prView(overrides) {
  return { number: 7, url: "https://github.com/o/r/pull/7", title: "Add things", body: "Body", baseRefName: "main", headRefName: "feature", isDraft: false, state: "OPEN", closingIssuesReferences: [], ...overrides };
}

const resolve = (git, input, options = {}) => resolveTarget(parseTarget(input), { git, gh: options.gh ?? fakeGh(), base: options.base ?? null });

test("parseTarget recognizes every target form", () => {
  assert.deepEqual(parseTarget(""), { kind: "auto", input: "auto" });
  assert.deepEqual(parseTarget("auto"), { kind: "auto", input: "auto" });
  assert.deepEqual(parseTarget("staged"), { kind: "staged", input: "staged" });
  assert.deepEqual(parseTarget("#12"), { kind: "pr", input: "#12", number: 12, slug: null });
  assert.deepEqual(parseTarget("pr:12"), { kind: "pr", input: "pr:12", number: 12, slug: null });
  assert.deepEqual(parseTarget("PR#12"), { kind: "pr", input: "PR#12", number: 12, slug: null });
  assert.deepEqual(parseTarget("https://github.com/o/r/pull/9/files"), { kind: "pr", input: "https://github.com/o/r/pull/9/files", number: 9, slug: "o/r" });
  assert.deepEqual(parseTarget("main..feature"), { kind: "range", input: "main..feature", from: "main", to: "feature", symmetric: false });
  assert.deepEqual(parseTarget("main...feature"), { kind: "range", input: "main...feature", from: "main", to: "feature", symmetric: true });
  assert.deepEqual(parseTarget("..feature"), { kind: "range", input: "..feature", from: "HEAD", to: "feature", symmetric: false });
  assert.deepEqual(parseTarget("12"), { kind: "number", input: "12" });
  assert.deepEqual(parseTarget("v1.2"), { kind: "rev", input: "v1.2", rev: "v1.2" });
});

test("auto reviews the current branch against the default base", () => {
  const { dir, git, base } = fixture("auto-branch");
  sh(dir, "checkout", "-q", "-b", "feature");
  const head = commit(dir, { "src/app.js": numbered(21) }, "feature");
  const target = resolve(git, "auto");
  assert.deepEqual(target, {
    kind: "branch",
    input: "auto",
    base: { ref: "main", tip: base, sha: base },
    head: { ref: "feature", sha: head, snapshot: false, dirty: false },
    notes: [],
  });
  write(dir, "src/app.js", numbered(22));
  const dirty = resolve(git, "auto");
  assert.equal(dirty.head.snapshot, true);
  assert.notEqual(dirty.head.sha, head);
  assert.deepEqual(dirty.notes, ["uncommitted changes are included through a snapshot commit"]);
});

test("auto reviews uncommitted changes on the default branch and refuses a clean one", () => {
  const { dir, git, base } = fixture("auto-worktree");
  const clean = catching(() => resolve(git, "auto"));
  assert.equal(clean.code, EXIT.input);
  assert.match(clean.message, /nothing to review on a clean default branch/);
  write(dir, "src/app.js", numbered(22));
  const target = resolve(git, "auto");
  assert.deepEqual({ kind: target.kind, input: target.input, base: target.base, ref: target.head.ref, snapshot: target.head.snapshot }, { kind: "worktree", input: "auto", base: { ref: "HEAD", tip: base, sha: base }, ref: "worktree", snapshot: true });
});

test("auto on the default branch of a clone reviews the uncommitted changes alone", () => {
  const source = makeRepo(root, "clone-source");
  const base = commit(source, { "src/app.js": numbered(20) }, "base");
  const dir = path.join(root, "clone");
  sh(root, "clone", "-q", source, dir);
  const git = commandRunner("git", dir, { env: ENV });
  assert.match(catching(() => resolve(git, "auto")).message, /nothing to review on a clean default branch/);
  const local = commit(dir, { "src/app.js": numbered(21) }, "unpushed");
  assert.match(catching(() => resolve(git, "auto")).message, /nothing to review on a clean default branch/);
  write(dir, "src/app.js", numbered(22));
  const dirty = resolve(git, "auto");
  assert.deepEqual([dirty.kind, dirty.base.sha], ["worktree", local]);
  sh(dir, "checkout", "-q", "-b", "feature");
  const feature = resolve(git, "auto");
  assert.deepEqual([feature.kind, feature.base.ref, feature.base.sha], ["branch", "origin/main", base]);
});

test("worktree snapshots are deterministic, include untracked files and leave the index alone", () => {
  const { dir, git } = fixture("worktree");
  write(dir, "src/app.js", numbered(25));
  write(dir, "notes/new.txt", "untracked\n");
  const one = resolve(git, "worktree");
  const two = resolve(git, "worktree");
  assert.equal(one.head.sha, two.head.sha);
  assert.equal(sh(dir, "show", `${one.head.sha}:notes/new.txt`), "untracked");
  assert.equal(sh(dir, "log", "-1", "--format=%an %ae %at", one.head.sha), "code-review-engine code-review-engine@localhost 946684800");
  assert.match(sh(dir, "status", "--porcelain"), /\?\? notes\//);
  assert.equal(sh(dir, "diff", "--cached", "--name-only"), "");
});

test("staged snapshots hold only the index", () => {
  const { dir, git } = fixture("staged");
  const nothing = catching(() => resolve(git, "staged"));
  assert.equal(nothing.code, EXIT.input);
  assert.match(nothing.message, /nothing is staged/);
  write(dir, "src/app.js", numbered(21));
  sh(dir, "add", "src/app.js");
  write(dir, "src/app.js", numbered(30));
  write(dir, "loose.txt", "loose\n");
  const target = resolve(git, "staged");
  assert.equal(target.head.ref, "index");
  assert.equal(sh(dir, "show", `${target.head.sha}:src/app.js`), numbered(21).trim());
  assert.throws(() => sh(dir, "cat-file", "-e", `${target.head.sha}:loose.txt`));
  assert.equal(resolve(git, "staged").head.sha, target.head.sha);
});

test("ranges start at the left side, or at the merge base when it is not an ancestor", () => {
  const { dir, git, base } = fixture("ranges");
  sh(dir, "checkout", "-q", "-b", "feature");
  const feature = commit(dir, { "src/feature.js": "a\n" }, "feature");
  sh(dir, "checkout", "-q", "main");
  const plain = resolve(git, "main..feature");
  assert.deepEqual({ base: plain.base, head: plain.head.sha, notes: plain.notes }, { base: { ref: "main", tip: base, sha: base }, head: feature, notes: [] });
  const moved = commit(dir, { "src/main.js": "m\n" }, "main moves");
  const diverged = resolve(git, "main..feature");
  assert.deepEqual({ tip: diverged.base.tip, sha: diverged.base.sha }, { tip: moved, sha: base });
  assert.deepEqual(diverged.notes, ["main is not an ancestor of feature; the diff starts at their merge base"]);
  const symmetric = resolve(git, "main...feature");
  assert.deepEqual({ sha: symmetric.base.sha, notes: symmetric.notes }, { sha: base, notes: [] });
  assert.equal(catching(() => resolve(git, "nope..feature")).code, EXIT.input);
});

test("a commit is reviewed against its parent, a root commit against the empty tree", () => {
  const { dir, git, base } = fixture("commits");
  const root = resolve(git, base);
  assert.deepEqual({ kind: root.kind, base: root.base }, { kind: "commit", base: { ref: `${base}^`, tip: EMPTY_TREE, sha: EMPTY_TREE } });
  const next = commit(dir, { "src/app.js": numbered(21) }, "next");
  const target = resolve(git, next.slice(0, 10));
  assert.deepEqual({ kind: target.kind, base: target.base.sha, head: target.head.sha, notes: target.notes }, { kind: "commit", base, head: next, notes: [] });
  sh(dir, "checkout", "-q", "-b", "side", base);
  commit(dir, { "side.txt": "s\n" }, "side");
  sh(dir, "checkout", "-q", "main");
  sh(dir, "merge", "-q", "--no-ff", "--no-edit", "side");
  assert.deepEqual(resolve(git, "HEAD").notes, ["merge commit; the diff is against its first parent"]);
});

test("a branch name is reviewed against the default base or --base", () => {
  const { dir, git, base } = fixture("branch-name");
  sh(dir, "checkout", "-q", "-b", "dev");
  const dev = commit(dir, { "dev.txt": "d\n" }, "dev");
  sh(dir, "checkout", "-q", "-b", "feature");
  const feature = commit(dir, { "src/f.js": "f\n" }, "feature");
  sh(dir, "checkout", "-q", "main");
  const target = resolve(git, "feature");
  assert.deepEqual({ kind: target.kind, base: target.base, head: target.head }, { kind: "branch", base: { ref: "main", tip: base, sha: base }, head: { ref: "feature", sha: feature, snapshot: false, dirty: false } });
  assert.equal(resolve(git, "feature", { base: "dev" }).base.sha, dev);
  assert.equal(catching(() => resolve(git, "branch", { base: "missing" })).code, EXIT.input);
});

test("bare digits are a pull request unless they resolve as a commit", () => {
  const { dir, git, base } = fixture("digits");
  sh(dir, "checkout", "-q", "-b", "feature");
  const feature = commit(dir, { "src/f.js": "f\n" }, "feature");
  sh(dir, "checkout", "-q", "main");
  const gh = fakeGh((args) => (args[0] === "pr" && args[1] === "view" && args[2] === "34" ? JSON.stringify(prView({ number: 34, baseRefOid: base, headRefOid: feature })) : null));
  const target = resolve(git, "34", { gh });
  assert.deepEqual({ kind: target.kind, number: target.pr.number, input: target.input }, { kind: "pr", number: 34, input: "34" });
  sh(dir, "tag", "12");
  const ambiguous = catching(() => resolve(git, "12", { gh }));
  assert.equal(ambiguous.code, EXIT.usage);
  assert.match(ambiguous.message, /12 is ambiguous; use #12 for a pull request/);
});

test("a pull request target resolves through gh without fetching objects it already has", () => {
  const { dir, git, base } = fixture("pull");
  sh(dir, "checkout", "-q", "-b", "feature");
  const feature = commit(dir, { "src/f.js": "f\n" }, "feature");
  sh(dir, "checkout", "-q", "main");
  const tip = commit(dir, { "src/m.js": "m\n" }, "main moves");
  const view = prView({ baseRefOid: tip, headRefOid: feature, closingIssuesReferences: [{ number: 5, url: "https://github.com/o/r/issues/5" }] });
  const gh = fakeGh((args) => (args[0] === "pr" && args[1] === "view" ? JSON.stringify(view) : null));
  const target = resolve(git, "#7", { gh });
  assert.deepEqual(target, {
    kind: "pr",
    input: "#7",
    base: { ref: "main", tip, sha: base },
    head: { ref: "feature", sha: feature, snapshot: false, dirty: false },
    pr: { number: 7, url: "https://github.com/o/r/pull/7", title: "Add things", body: "Body", draft: false, state: "OPEN", base_ref: "main", head_ref: "feature", head_sha: feature, closing_issues: ["https://github.com/o/r/issues/5"] },
    notes: [],
  });
  assert.deepEqual(gh.calls[0].args.slice(0, 3), ["pr", "view", "7"]);
  resolve(git, "https://github.com/o/r/pull/7", { gh });
  assert.equal(gh.calls.at(-1).args[2], "https://github.com/o/r/pull/7");
  const failed = catching(() => resolve(git, "#8", { gh: fakeGh() }));
  assert.equal(failed.code, EXIT.tool);
});

test("a pull request whose commits are missing locally is fetched from the remote", () => {
  const source = makeRepo(root, "pr-source");
  const base = commit(source, { "src/app.js": numbered(20) }, "base");
  const dir = path.join(root, "pr-clone");
  sh(root, "clone", "-q", source, dir);
  sh(source, "checkout", "-q", "-b", "pr");
  const head = commit(source, { "src/app.js": numbered(22) }, "pr change");
  sh(source, "update-ref", "refs/pull/7/head", head);
  sh(source, "checkout", "-q", "main");
  sh(source, "branch", "-q", "-D", "pr");
  const tip = commit(source, { "src/main.js": "m\n" }, "main moves");
  const git = commandRunner("git", dir, { env: ENV });
  const view = JSON.stringify(prView({ baseRefOid: tip, headRefOid: head }));
  const target = resolve(git, "#7", { gh: fakeGh((args) => (args[0] === "pr" ? view : null)) });
  assert.deepEqual([target.base.tip, target.base.sha, target.head.sha], [tip, base, head]);
  const lonely = makeRepo(root, "pr-no-remote");
  commit(lonely, { "a.txt": "a\n" }, "base");
  const error = catching(() => resolve(commandRunner("git", lonely, { env: ENV }), "#7", { gh: fakeGh((args) => (args[0] === "pr" ? view : null)) }));
  assert.deepEqual([error.code, error.message], [EXIT.input, "this repository has no remote to fetch the pull request from"]);
});
