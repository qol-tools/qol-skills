import assert from "node:assert/strict";
import { test } from "node:test";
import { HIGH_SIGNALS, classifyFile, generatedMarker, language } from "../src/classify.mjs";

function hunkOf(added = [], removed = [], start = 1) {
  return {
    header: `@@ -${start},${removed.length} +${start},${added.length} @@`,
    old_start: start,
    old_count: removed.length,
    new_start: start,
    new_count: added.length,
    context: "",
    lines: [...removed.map((text) => `-${text}`), ...added.map((text) => `+${text}`)],
    added: added.length,
    removed: removed.length,
  };
}

function fileOf(path, { status = "M", added = [], removed = [], hunks, ...extra } = {}) {
  return {
    path,
    status,
    old_path: status === "A" ? null : path,
    hunks: hunks ?? (added.length || removed.length ? [hunkOf(added, removed)] : []),
    binary: false,
    mode_change: false,
    ...extra,
  };
}

const plain = (count, prefix) => Array.from({ length: count }, (_, index) => `${prefix} value ${index}`);

test("kinds follow the priority order from binary down to source", () => {
  const cases = [
    ["package-lock.json", { binary: true }, "binary"],
    ["Cargo.lock", {}, "lockfile"],
    ["vendor/lib/a.js", {}, "vendored"],
    ["tests/vendor/a.js", {}, "vendored"],
    ["dist/app.min.js", {}, "generated"],
    ["api/__generated__/types.ts", {}, "generated"],
    [".github/workflows/ci.yml", {}, "ci"],
    ["db/migrations/001_init.sql", {}, "migration"],
    ["src/app.test.js", {}, "test"],
    ["tests/helpers.js", {}, "test"],
    ["CLAUDE.md", {}, "prompt"],
    ["skills/x/SKILL.md", {}, "prompt"],
    ["skills/x/references/guide.md", {}, "prompt"],
    ["docs/guide.md", {}, "docs"],
    ["CHANGELOG.md", {}, "docs"],
    ["LICENSE", {}, "docs"],
    ["img/logo.png", {}, "asset"],
    ["package.json", {}, "manifest"],
    ["Dockerfile", {}, "build"],
    ["tsconfig.json", {}, "build"],
    ["config/app.yaml", {}, "config"],
    [".eslintrc", {}, "config"],
    ["src/app.js", {}, "source"],
  ];
  for (const [path, extra, kind] of cases) assert.equal(classifyFile({ ...fileOf(path, { added: ["x"] }), ...extra }).kind, kind, path);
});

test("binary, lockfile, vendored and generated files are excluded with a reason", () => {
  const cases = [
    [{ ...fileOf("img/x.bin"), binary: true }, "binary file"],
    [fileOf("yarn.lock", { added: ["a"] }), "lockfile"],
    [{ ...fileOf("lib/x.js", { added: ["a"] }), vendored: true }, "vendored code"],
    [{ ...fileOf("src/schema.js", { added: ["a"] }), generated: true }, "generated file"],
    [fileOf("third_party/zlib/inflate.c", { added: ["a"] }), "vendored code"],
  ];
  for (const [file, reason] of cases) {
    const result = classifyFile(file);
    assert.equal(result.excluded, true, file.path);
    assert.equal(result.exclude_reason, reason, file.path);
    assert.equal(result.tier, "low", file.path);
  }
  const lock = classifyFile(fileOf("package-lock.json", { added: ['"token": "abcdefghijklmnop"'] }));
  assert.equal(lock.signals.includes("possible-secret"), false);
  assert.equal(classifyFile(fileOf("src/app.js", { added: ["a"] })).excluded, false);
});

test("possible-secret forces the high tier, even in docs", () => {
  const result = classifyFile(fileOf("docs/setup.md", { added: ['password = "hunter2hunter2"'] }));
  assert.equal(result.kind, "docs");
  assert.ok(result.signals.includes("possible-secret"));
  assert.equal(result.tier, "high");
  assert.equal(classifyFile(fileOf("src/aws.js", { added: ["const key = 'AKIAABCDEFGHIJKLMNOP';"] })).tier, "high");
});

test("docs and assets are low, prompts are medium and plain source is medium", () => {
  assert.equal(classifyFile(fileOf("README.md", { added: ["more words"] })).tier, "low");
  assert.equal(classifyFile(fileOf("img/logo.svg", { added: ["<svg/>"] })).tier, "low");
  assert.equal(classifyFile(fileOf("CLAUDE.md", { added: ["new rule"] })).tier, "medium");
  assert.equal(classifyFile(fileOf("src/app.js", { added: ["const a = 1;"] })).tier, "medium");
});

test("a pure rename is low and a rename with edits is a refactor", () => {
  const pure = classifyFile({ ...fileOf("src/b.js", { status: "R" }), old_path: "src/a.js" });
  assert.deepEqual([pure.tier, pure.signals, pure.old_path], ["low", ["rename"], "src/a.js"]);
  const edited = classifyFile({ ...fileOf("src/b.js", { status: "R", added: ["x"], removed: ["y"] }), old_path: "src/a.js" });
  assert.ok(edited.signals.includes("refactor"));
  assert.equal(edited.tier, "high");
});

test("test files are low unless tests were removed", () => {
  assert.equal(classifyFile(fileOf("src/app.test.js", { added: plain(3, "assert"), removed: plain(1, "old") })).tier, "low");
  const removing = classifyFile(fileOf("src/app.test.js", { added: plain(1, "assert"), removed: plain(3, "old") }));
  assert.ok(removing.signals.includes("test-removal"));
  assert.equal(removing.tier, "medium");
  const deleted = classifyFile(fileOf("tests/app.test.js", { status: "D", removed: plain(2, "old") }));
  assert.ok(deleted.signals.includes("test-removal"));
  assert.ok(deleted.signals.includes("deleted"));
});

test("content signals mark refactors, removed validation, api changes and concurrency", () => {
  const refactor = classifyFile(fileOf("src/app.js", { added: plain(25, "new"), removed: plain(25, "old") }));
  assert.ok(refactor.signals.includes("refactor"));
  assert.equal(refactor.tier, "high");
  assert.equal(classifyFile(fileOf("src/app.js", { added: plain(25, "new"), removed: plain(5, "old") })).signals.includes("refactor"), false);
  const validation = classifyFile(fileOf("src/app.js", { removed: ['if (!user) throw new Error("no user");'] }));
  assert.ok(validation.signals.includes("removed-validation"));
  assert.equal(validation.tier, "high");
  const removal = classifyFile(fileOf("src/lib.js", { removed: ["export function parse(text) {"] }));
  assert.ok(removal.signals.includes("api-removal"));
  assert.equal(removal.tier, "high");
  const change = classifyFile(fileOf("src/lib.js", { added: ["export function parse(text) {"] }));
  assert.deepEqual([change.signals.includes("api-change"), change.signals.includes("api-removal"), change.tier], [true, false, "medium"]);
  const locks = classifyFile(fileOf("src/pool.js", { added: ["const lock = new Mutex();"] }));
  assert.ok(locks.signals.includes("concurrency"));
  assert.equal(locks.tier, "high");
  const errors = classifyFile(fileOf("src/io.js", { added: ["try {"] }));
  assert.deepEqual([errors.signals.includes("error-handling"), errors.tier], [true, "medium"]);
});

test("docs, prompt and test files drop code-only content signals", () => {
  const result = classifyFile(fileOf("src/pool.test.js", { added: ["const lock = new Mutex();", "export function helper() {", "try {"] }));
  for (const signal of ["concurrency", "api-change", "error-handling"]) assert.equal(result.signals.includes(signal), false, signal);
  const docs = classifyFile(fileOf("docs/auth.md", { removed: ["if (!user) throw new Error('x');"] }));
  assert.equal(docs.signals.includes("removed-validation"), false);
  assert.equal(docs.signals.includes("security-path"), false);
});

test("path and status signals cover security paths, ci, build, manifests, migrations, new files and mode changes", () => {
  const signalsOf = (file) => classifyFile(file).signals;
  assert.ok(signalsOf(fileOf("src/auth/login.js", { added: ["a"] })).includes("security-path"));
  assert.ok(signalsOf(fileOf("src/userSession.js", { added: ["a"] })).includes("security-path"));
  assert.ok(signalsOf(fileOf(".github/workflows/ci.yml", { added: ["a"] })).includes("ci-config"));
  assert.ok(signalsOf(fileOf("Dockerfile", { added: ["a"] })).includes("build-config"));
  assert.ok(signalsOf(fileOf("package.json", { added: ["a"] })).includes("dependency-manifest"));
  assert.ok(signalsOf(fileOf("db/migrations/002.sql", { added: ["a"] })).includes("migration"));
  assert.ok(signalsOf(fileOf("src/new.js", { status: "A", added: ["a"] })).includes("new-file"));
  assert.ok(signalsOf({ ...fileOf("run.sh"), mode_change: true }).includes("mode-change"));
  const ci = classifyFile(fileOf(".github/workflows/ci.yml", { added: ["a"] }));
  assert.equal(ci.tier, "high");
  assert.deepEqual(ci.signals, [...ci.signals].sort());
});

test("every high signal is a known signal name", () => {
  assert.deepEqual(HIGH_SIGNALS, ["security-path", "migration", "possible-secret", "removed-validation", "api-removal", "refactor", "ci-config", "concurrency", "text-to-binary"]);
});

test("classifyFile reports counts and drops an old path equal to the path", () => {
  const result = classifyFile(fileOf("src/app.js", { added: ["a", "b"], removed: ["c"] }));
  assert.deepEqual(
    { path: result.path, old_path: result.old_path, status: result.status, language: result.language, added: result.added, removed: result.removed, binary: result.binary },
    { path: "src/app.js", old_path: null, status: "M", language: "javascript", added: 2, removed: 1, binary: false },
  );
});

test("language maps extensions and special file names", () => {
  assert.equal(language("src/a.ts"), "typescript");
  assert.equal(language("Dockerfile.dev"), "docker");
  assert.equal(language("GNUmakefile"), "make");
  assert.equal(language("x.unknown"), null);
  assert.equal(language(".bashrc"), null);
});

test("generatedMarker looks only at the first five lines", () => {
  assert.equal(generatedMarker("// Code generated by protoc-gen-go. DO NOT EDIT.\npackage x"), true);
  assert.equal(generatedMarker("/* @generated */"), true);
  assert.equal(generatedMarker("# auto-generated file"), true);
  assert.equal(generatedMarker("1\n2\n3\n4\n5\n// DO NOT EDIT"), false);
  assert.equal(generatedMarker(null), false);
});
