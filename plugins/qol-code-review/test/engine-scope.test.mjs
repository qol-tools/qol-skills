import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after } from "node:test";
import { EXIT } from "../src/errors.mjs";
import { REFERENCES, RUBRIC, privateDir } from "../src/run.mjs";
import { runScope, scopeSummary } from "../src/scope.mjs";
import { catching, commit, depsFor, fakeGh, makeRepo, numbered, readJson, sh, tempRoot, test } from "./engine-helpers.mjs";

const root = tempRoot();
after(() => fs.rmSync(root, { recursive: true, force: true }));

function fixture(name, files = { "src/app.js": numbered(20) }) {
  const dir = makeRepo(root, name);
  const base = commit(dir, files, "base");
  return { dir, base, out: path.join(root, `${name}-out`) };
}

const short = (sha) => sha.slice(0, 7);

test("scope writes the run directory for a commit", () => {
  const { dir, base, out } = fixture("Run Files");
  const head = commit(dir, { "src/app.js": numbered(60) }, "grow");
  const gh = fakeGh();
  const scope = runScope(head, {}, depsFor(dir, out, gh));
  assert.equal(scope.run_id, `run-files-${short(head)}-${short(base)}-standard`);
  assert.equal(scope.run_dir, path.join(out, "runs", scope.run_id));
  assert.deepEqual(scope.target, { kind: "commit", input: head });
  assert.deepEqual(scope.level, { used: "standard", suggested: "standard", forced: false, trivial: false, reasons: ["no high-risk file across 40 changed lines"] });
  for (const file of ["scope.json", "diff.patch", "intent-sources.md", "chunks/c01.patch", ...scope.plan.jobs.map((job) => `jobs/${job.id}.json`)]) {
    assert.ok(fs.existsSync(path.join(scope.run_dir, file)), file);
  }
  assert.equal(fs.existsSync(path.join(scope.run_dir, "rules.md")), false);
  assert.equal(fs.existsSync(path.join(scope.run_dir, "context.json")), false);
  assert.deepEqual(readJson(path.join(scope.run_dir, "scope.json")), JSON.parse(JSON.stringify(scope)));
  assert.equal(fs.readFileSync(path.join(scope.tree, "src/app.js"), "utf8"), numbered(60));
  assert.ok(fs.existsSync(path.join(out, "trees", `${head}.done`)));
  assert.match(fs.readFileSync(path.join(scope.run_dir, "chunks/c01.patch"), "utf8"), /^diff --git a\/src\/app\.js b\/src\/app\.js\n/);
  const descriptor = readJson(path.join(scope.run_dir, "jobs", "c01-correctness-p1.json"));
  assert.deepEqual(
    { kind: descriptor.kind, lenses: descriptor.lenses, pass: descriptor.pass, instructions: descriptor.instructions, lens_guide: descriptor.lens_guide, output: descriptor.output, limits: descriptor.limits, chunk: descriptor.chunk.id, patch: descriptor.chunk.patch, ledger: descriptor.inputs.ledger, rules: descriptor.inputs.rules, context: descriptor.inputs.context },
    {
      kind: "finder",
      lenses: ["correctness"],
      pass: 1,
      instructions: path.join(REFERENCES, "engine-finder-prompt.md"),
      lens_guide: path.join(REFERENCES, "engine-lenses.md"),
      output: path.join(scope.run_dir, "finds", "c01-correctness-p1.json"),
      limits: { candidates: 15, words: 60 },
      chunk: "c01",
      patch: path.join(scope.run_dir, "chunks", "c01.patch"),
      ledger: null,
      rules: null,
      context: null,
    },
  );
  assert.equal(descriptor.base_tree, scope.base_tree);
  assert.equal(descriptor.rubric, RUBRIC);
  assert.equal(fs.readFileSync(path.join(scope.base_tree, "src/app.js"), "utf8"), numbered(20));
  assert.deepEqual(scope.shallow, { scanned: 0, entries: [] });
  assert.equal(gh.calls.length, 0);
  const summary = scopeSummary(scope);
  assert.equal(summary.next, `next ${scope.run_dir}`);
  assert.deepEqual(summary.plan, { solo: false, lenses: ["correctness", "security", "contracts", "tests"], passes: 1, finder_jobs: 4, reductions: [], ledger: false, hunt: false, verify: "agent" });
});

test("the run id is stable and the options that change the plan change it", () => {
  const { dir, base, out } = fixture("ids", { "src/app.js": numbered(20), "lib/b.js": numbered(5) });
  const head = commit(dir, { "src/app.js": numbered(30), "lib/b.js": numbered(9) }, "edit");
  const deps = depsFor(dir, out);
  const first = runScope(head, {}, deps);
  const again = runScope(head, {}, deps);
  assert.equal(again.run_id, first.run_id);
  assert.deepEqual(again, first);
  const stem = `ids-${short(head)}-${short(base)}`;
  assert.equal(first.run_id, `${stem}-quick`);
  const hash = createHash("sha1").update(["src", "lib/b.js"].join("\0")).digest("hex").slice(0, 6);
  const narrowed = runScope(head, { paths: ["src", "lib/b.js"] }, deps);
  assert.equal(narrowed.run_id, `${stem}-quick-${hash}`);
  assert.deepEqual(narrowed.paths, ["src", "lib/b.js"]);
  const onlySrc = runScope(head, { paths: ["src"] }, deps);
  assert.deepEqual(onlySrc.files.map((file) => file.path), ["src/app.js"]);
  assert.equal(runScope(head, { level: "standard", solo: true, maxJobs: 7 }, deps).run_id, `${stem}-standard-solo-j7`);
  assert.equal(runScope(head, { level: "quick", solo: true }, deps).run_id, `${stem}-quick-solo`);
  const forced = runScope(head, { level: "deep" }, deps);
  assert.deepEqual([forced.level.used, forced.level.suggested, forced.level.forced], ["deep", "quick", true]);
  assert.ok(fs.existsSync(path.join(forced.run_dir, "context.json")));
});

test("scope refuses a diff over the changed-line limit, empty diffs and folders outside git", () => {
  const { dir, out } = fixture("big");
  const head = commit(dir, { "src/huge.js": numbered(8001), "docs/a.md": numbered(3) }, "huge");
  const big = catching(() => runScope(head, {}, depsFor(dir, out)));
  assert.equal(big.code, EXIT.input);
  assert.equal(big.message, "the diff has 8004 reviewable changed lines, over the 8000-line limit; review it in parts with --paths (largest: src (8001), docs (3))");
  assert.equal(runScope(head, { paths: ["docs"] }, depsFor(dir, out)).stats.reviewable_changed, 3);
  const empty = catching(() => runScope(head, { paths: ["nothing-here"] }, depsFor(dir, out)));
  assert.equal(empty.code, EXIT.input);
  assert.equal(empty.message, `nothing to review: ${head} has no changes against ${head}^ under nothing-here`);
  const plain = path.join(root, "not-a-repo");
  fs.mkdirSync(plain);
  const outside = catching(() => runScope("auto", {}, depsFor(plain, out)));
  assert.equal(outside.code, EXIT.input);
  assert.equal(outside.message, `${plain} is not inside a git repository`);
});

test("scope refuses a diff of only excluded files", () => {
  const { dir, out } = fixture("excluded-only", { "src/app.js": numbered(20), "yarn.lock": "old\n", "dist/app.min.js": "x\n" });
  const head = commit(dir, { "yarn.lock": "lock\n", "dist/app.min.js": "y\n" }, "deps");
  const error = catching(() => runScope(head, {}, depsFor(dir, out)));
  assert.equal(error.code, EXIT.input);
  assert.equal(error.message, "nothing to review: every changed file is excluded (dist/app.min.js: generated file, yarn.lock: lockfile)");
});

test("scope refuses a plan over the job cap", () => {
  const { dir, out } = fixture("cap", { "src/a.js": numbered(1), "src/b.js": numbered(1) });
  const head = commit(dir, { "src/a.js": numbered(301), "src/b.js": numbered(301) }, "two chunks");
  const error = catching(() => runScope(head, { level: "standard", maxJobs: 1 }, depsFor(dir, out)));
  assert.equal(error.code, EXIT.input);
  assert.equal(error.message, "the standard plan needs more than 1 finder jobs even with every lens in one job per chunk; raise --max-jobs or narrow --paths");
});

test("rules come from the base ref, never from the change", () => {
  const { dir, base, out } = fixture("rules", {
    "CLAUDE.md": "base root rule\n",
    "src/AGENTS.md": "base src rule\n",
    "other/REVIEW.md": "unrelated rule\n",
    "src/app.js": numbered(20),
  });
  const head = commit(dir, { "CLAUDE.md": "head root rule\n", "src/app.js": numbered(25), "src/REVIEW.md": "new head rule\n" }, "edit rules");
  const scope = runScope(head, {}, depsFor(dir, out));
  assert.deepEqual(scope.rules, [{ path: "CLAUDE.md", applies_to: "**" }, { path: "src/AGENTS.md", applies_to: "src/**" }]);
  assert.deepEqual(scope.rules_changed, ["CLAUDE.md", "src/REVIEW.md"]);
  const rules = fs.readFileSync(path.join(scope.run_dir, "rules.md"), "utf8");
  assert.match(rules, new RegExp(`^# Review rules from the base ref \\(${head}\\^ at ${base.slice(0, 12)}\\)`));
  assert.match(rules, /base root rule/);
  assert.match(rules, /base src rule/);
  assert.doesNotMatch(rules, /head root rule|new head rule|unrelated rule/);
  assert.equal(readJson(path.join(scope.run_dir, "jobs", `${scope.plan.jobs[0].id}.json`)).inputs.rules, path.join(scope.run_dir, "rules.md"));
});

test("files carry head hunks, exclusions and classification", () => {
  const lines = numbered(20).split("\n");
  const { dir, out } = fixture("hunks", { "src/app.js": numbered(20), "src/gone.js": numbered(4, "gone"), "gen/api.js": "// Code generated by gen. DO NOT EDIT.\nexport const a = 0;\n" });
  lines[4] = "changed 5";
  lines[14] = "changed 15";
  const head = commit(dir, {
    "src/app.js": lines.join("\n"),
    "src/gone.js": null,
    "src/new.js": numbered(3, "fresh"),
    "gen/api.js": "// Code generated by gen. DO NOT EDIT.\nexport const a = 1;\n",
    "yarn.lock": "lock\n",
  }, "mixed");
  const scope = runScope(head, {}, depsFor(dir, out));
  const byPath = Object.fromEntries(scope.files.map((file) => [file.path, file]));
  assert.deepEqual(byPath["src/app.js"].head_hunks, [[2, 8], [12, 18]]);
  assert.deepEqual(byPath["src/gone.js"].head_hunks, []);
  assert.deepEqual(byPath["src/new.js"].head_hunks, [[1, 3]]);
  assert.deepEqual([byPath["gen/api.js"].excluded, byPath["gen/api.js"].exclude_reason], [true, "generated file"]);
  assert.deepEqual([byPath["yarn.lock"].excluded, byPath["yarn.lock"].exclude_reason], [true, "lockfile"]);
  assert.deepEqual([byPath["src/gone.js"].status, byPath["src/new.js"].status], ["D", "A"]);
  assert.deepEqual(scope.stats, { files: 5, reviewable_files: 3, excluded_files: 2, added: 7, removed: 7, reviewable_changed: 11, tiers: { high: 0, medium: 3, low: 2 } });
  assert.deepEqual(scope.chunks[0].files.map((file) => file.path).sort(), ["src/app.js", "src/gone.js", "src/new.js"]);
});

const [gitMajor, gitMinor] = sh(root, "--version").match(/(\d+)\.(\d+)/).slice(1).map(Number);

test("linguist attributes at the base exclude generated and vendored files", { skip: gitMajor < 2 || (gitMajor === 2 && gitMinor < 40) ? "git check-attr --source needs git 2.40" : false }, () => {
  const { dir, out } = fixture("linguist", { ".gitattributes": "gen/** linguist-generated\nthird/** linguist-vendored=true\nkeep/** linguist-generated=false\n", "src/app.js": numbered(5), "gen/a.js": numbered(5), "third/b.js": numbered(5), "keep/c.js": numbered(5) });
  const head = commit(dir, {
    "src/app.js": numbered(6),
    "gen/a.js": numbered(6),
    "third/b.js": numbered(6),
    "keep/c.js": numbered(6),
  }, "attributes");
  const scope = runScope(head, {}, depsFor(dir, out));
  const reasons = Object.fromEntries(scope.files.map((file) => [file.path, file.exclude_reason]));
  assert.deepEqual(reasons, { "gen/a.js": "generated file", "keep/c.js": null, "src/app.js": null, "third/b.js": "vendored code" });
});

test("a worktree review includes untracked files through the snapshot", () => {
  const { dir, base, out } = fixture("worktree-scope");
  fs.writeFileSync(path.join(dir, "src/app.js"), numbered(22));
  fs.writeFileSync(path.join(dir, "notes.txt"), "untracked\n");
  const scope = runScope("worktree", {}, depsFor(dir, out));
  assert.deepEqual([scope.target.kind, scope.base.sha, scope.head.ref, scope.head.snapshot], ["worktree", base, "worktree", true]);
  assert.deepEqual(scope.files.map((file) => [file.path, file.status]), [["notes.txt", "A"], ["src/app.js", "M"]]);
  assert.equal(fs.readFileSync(path.join(scope.tree, "notes.txt"), "utf8"), "untracked\n");
  assert.equal(scope.intent.commits, 0);
  assert.match(fs.readFileSync(path.join(scope.run_dir, "intent-sources.md"), "utf8"), /No pull request text or commit messages exist for this target\./);
  assert.equal(sh(dir, "status", "--porcelain"), "M src/app.js\n?? notes.txt");
});

test("deep scopes collect blame for removed lines and the blast radius of changed symbols", () => {
  const session = "export function checkToken(token) {\n  const size = token ? token.length : 0;\n  const limit = 8;\n  const label = \"token\";\n  if (!token) throw new Error(\"no token\");\n  return size > limit && label.length > 0;\n}\n";
  const { dir, base, out } = fixture("context", { "src/auth/session.js": session, "src/app.js": "import { checkToken } from \"./auth/session.js\";\nexport const ok = checkToken(process.argv[2]);\n" });
  const head = commit(dir, { "src/auth/session.js": session.replace("  if (!token) throw new Error(\"no token\");\n", "") }, "loosen");
  const scope = runScope(head, {}, depsFor(dir, out));
  assert.equal(scope.level.used, "deep");
  const context = readJson(path.join(scope.run_dir, "context.json"));
  assert.deepEqual(context.blame, [{ file: "src/auth/session.js", base_lines: "5", commits: [{ sha: base, summary: "base", date: context.blame[0].commits[0].date }] }]);
  assert.match(context.blame[0].commits[0].date, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(context.blast_radius, [{ symbol: "checkToken", defined_in: "src/auth/session.js", references: 3, files: 2, other_files: 1, sample: ["src/app.js:1", "src/app.js:2"] }]);
});

test("the shallow-wrapper detector runs over the added lines and its entries reach the job files", () => {
  const rust = "pub fn real(value: &str) -> usize {\n    let size = value.len();\n    size + 1\n}\n";
  const { dir, out } = fixture("shallow", { "src/lib.rs": rust });
  const head = commit(dir, { "src/lib.rs": `${rust}\npub fn normalize(value: &str) -> String {\n    other::normalize(value)\n}\n` }, "wrapper");
  const scope = runScope(head, {}, depsFor(dir, out));
  assert.deepEqual(scope.shallow, { scanned: 1, entries: [{ file: "src/lib.rs", line: 6, name: "normalize", callee: "other::normalize" }] });
  assert.equal(readJson(path.join(scope.run_dir, "shallow-wrappers.json")).count, 1);
  assert.equal(readJson(path.join(scope.run_dir, "jobs", `${scope.plan.jobs[0].id}.json`)).inputs.shallow_wrappers, path.join(scope.run_dir, "shallow-wrappers.json"));
});

test("a file that becomes a symlink is one type-changed file", () => {
  const { dir, out } = fixture("typechange", { "src/app.js": numbered(20), "src/link": numbered(2, "plain") });
  fs.rmSync(path.join(dir, "src/link"));
  fs.symlinkSync("app.js", path.join(dir, "src/link"));
  const head = commit(dir, { "src/app.js": numbered(22) }, "symlink");
  const scope = runScope(head, {}, depsFor(dir, out));
  const link = scope.files.find((file) => file.path === "src/link");
  assert.deepEqual([link.status, link.signals.includes("type-change"), link.added, link.removed, link.head_hunks], ["T", true, 1, 2, [[1, 1]]]);
  const patch = fs.readFileSync(scope.chunks[0].patch, "utf8");
  assert.match(patch, /deleted file mode 100644[\s\S]*new file mode 120000[\s\S]*-plain 2\n[\s\S]*\+app\.js/);
});

test("a symlink in the head reaches the tree as a plain file that holds its target", () => {
  const { dir, out } = fixture("symlink-tree");
  const secret = path.join(root, "symlink-secret.txt");
  fs.writeFileSync(secret, "private key\n");
  fs.mkdirSync(path.join(dir, "docs"));
  fs.symlinkSync(secret, path.join(dir, "docs/notes.md"));
  const head = commit(dir, { "src/app.js": numbered(22) }, "link");
  const scope = runScope(head, {}, depsFor(dir, out));
  const copy = path.join(scope.tree, "docs/notes.md");
  assert.deepEqual([fs.lstatSync(copy).isFile(), fs.readFileSync(copy, "utf8")], [true, secret]);
});

test("only closing issues of the pull request's own repository are fetched", () => {
  const { dir, base, out } = fixture("linked-issues");
  sh(dir, "checkout", "-q", "-b", "feature");
  const head = commit(dir, { "src/app.js": numbered(24) }, "feature");
  sh(dir, "checkout", "-q", "main");
  const own = "https://github.com/o/r/issues/5";
  const other = "https://github.com/o/rr/issues/9";
  const view = JSON.stringify({ number: 7, url: "https://github.com/o/r/pull/7", title: "Grow", body: "", baseRefName: "main", baseRefOid: base, headRefName: "feature", headRefOid: head, isDraft: false, state: "OPEN", closingIssuesReferences: [{ number: 9, url: other }, { number: 5, url: own }] });
  const gh = fakeGh((args) => {
    if (args[0] === "pr") return view;
    if (args[0] === "issue") return JSON.stringify({ number: Number(args[2].split("/").at(-1)), title: "Issue", body: `body of ${args[2]}` });
    return null;
  });
  const scope = runScope("feature", {}, depsFor(dir, out, gh));
  assert.deepEqual(scope.pr.closing_issues, [other, own]);
  assert.deepEqual(gh.calls.filter((call) => call.args[0] === "issue").map((call) => call.args[2]), [own]);
  const sources = fs.readFileSync(path.join(scope.run_dir, "intent-sources.md"), "utf8");
  assert.match(sources, /## Linked issue #5: Issue\n\n[\s\S]*body of https:\/\/github\.com\/o\/r\/issues\/5/);
  assert.doesNotMatch(sources, /body of https:\/\/github\.com\/o\/rr/);
});

test("the default run root must be a folder only the user can open", () => {
  const fresh = path.join(root, "private-fresh");
  assert.equal(privateDir(fresh), fresh);
  assert.equal(fs.statSync(fresh).mode & 0o777, 0o700);
  assert.equal(privateDir(fresh), fresh);
  const open = path.join(root, "private-open");
  fs.mkdirSync(open);
  fs.chmodSync(open, 0o755);
  const link = path.join(root, "private-link");
  fs.symlinkSync(fresh, link);
  const file = path.join(root, "private-file");
  fs.writeFileSync(file, "");
  for (const target of [open, link, file]) {
    const error = catching(() => privateDir(target));
    assert.deepEqual([error.code, error.message], [EXIT.input, `${target} is not a folder only you can open; remove it, or set CODE_REVIEW_ENGINE_DIR to another folder`]);
  }
});

test("a branch with an open pull request records it, a closed one does not", () => {
  const { dir, base, out } = fixture("branch-pr");
  sh(dir, "checkout", "-q", "-b", "feature");
  const head = commit(dir, { "src/app.js": numbered(24) }, "feature");
  sh(dir, "checkout", "-q", "main");
  const view = (state, headRefOid = head) => JSON.stringify({ number: 7, url: "https://github.com/o/r/pull/7", title: "Grow", body: "secret body", baseRefName: "main", baseRefOid: base, headRefName: "feature", headRefOid, isDraft: true, state, closingIssuesReferences: [] });
  const openGh = fakeGh((args) => (args[0] === "pr" ? view("OPEN") : null));
  const scope = runScope("feature", {}, depsFor(dir, out, openGh));
  assert.deepEqual(JSON.parse(JSON.stringify(scope.pr)), { number: 7, url: "https://github.com/o/r/pull/7", title: "Grow", draft: true, state: "OPEN", base_ref: "main", head_ref: "feature", head_sha: head, closing_issues: [], head_matches: true });
  assert.equal(readJson(path.join(scope.run_dir, "scope.json")).pr.body, undefined);
  assert.deepEqual(openGh.calls.map((call) => call.args.slice(0, 3)), [["pr", "view", "feature"]]);
  assert.match(fs.readFileSync(path.join(scope.run_dir, "intent-sources.md"), "utf8"), /secret body/);
  const moved = runScope("feature", {}, depsFor(dir, out, fakeGh((args) => (args[0] === "pr" ? view("OPEN", "f".repeat(40)) : null))));
  assert.equal(moved.pr.head_matches, false);
  assert.equal(runScope("feature", {}, depsFor(dir, out, fakeGh((args) => (args[0] === "pr" ? view("CLOSED") : null)))).pr, null);
  const quiet = fakeGh();
  assert.equal(runScope("feature", { lookupPr: false }, depsFor(dir, out, quiet)).pr, null);
  assert.equal(quiet.calls.length, 0);
});
