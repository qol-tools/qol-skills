import assert from "node:assert/strict";
import { test } from "node:test";
import { baseRange, changedLines, headRange, pairSections, parseNameStatus, parseSection, runs, sectionText, splitPatch } from "../src/diff.mjs";

const PATCH = [
  "diff --git a/src/app.js b/src/app.js",
  "index 1111111..2222222 100644",
  "--- a/src/app.js",
  "+++ b/src/app.js",
  "@@ -1,3 +1,4 @@ function main() {",
  " const a = 1;",
  "-const b = 2;",
  "+const b = 3;",
  "+const c = 4;",
  " const d = 5;",
  "@@ -10 +11 @@",
  "-old",
  "+new",
  "\\ No newline at end of file",
  "diff --git a/img/logo.png b/img/logo.png",
  "index 3333333..4444444 100644",
  "Binary files a/img/logo.png and b/img/logo.png differ",
  "diff --git a/run.sh b/run.sh",
  "old mode 100644",
  "new mode 100755",
  "",
  "",
].join("\n");

test("parseNameStatus reads modified, added, deleted, renamed and copied entries", () => {
  const entries = parseNameStatus(["M", "src/app.js", "A", "new.txt", "D", "gone.txt", "R087", "old/name.js", "new/name.js", "C100", "a.js", "b.js", "T", "link", ""].join("\0"));
  assert.deepEqual(entries, [
    { status: "M", score: null, old_path: "src/app.js", path: "src/app.js" },
    { status: "A", score: null, old_path: null, path: "new.txt" },
    { status: "D", score: null, old_path: "gone.txt", path: "gone.txt" },
    { status: "R", score: 87, old_path: "old/name.js", path: "new/name.js" },
    { status: "C", score: 100, old_path: "a.js", path: "b.js" },
    { status: "T", score: null, old_path: "link", path: "link" },
  ]);
  assert.deepEqual(parseNameStatus(""), []);
});

test("splitPatch cuts at diff headers and trims trailing blank lines", () => {
  const sections = splitPatch(PATCH);
  assert.equal(sections.length, 3);
  assert.equal(sections[0][0], "diff --git a/src/app.js b/src/app.js");
  assert.deepEqual(sections[2], ["diff --git a/run.sh b/run.sh", "old mode 100644", "new mode 100755"]);
});

test("parseSection counts hunk lines and keeps the no-newline marker inside its hunk", () => {
  const [first] = splitPatch(PATCH);
  const section = parseSection(first);
  assert.equal(section.header.length, 4);
  assert.equal(section.hunks.length, 2);
  const [one, two] = section.hunks;
  assert.deepEqual(
    { old_start: one.old_start, old_count: one.old_count, new_start: one.new_start, new_count: one.new_count, added: one.added, removed: one.removed, context: one.context },
    { old_start: 1, old_count: 3, new_start: 1, new_count: 4, added: 2, removed: 1, context: "function main() {" },
  );
  assert.deepEqual({ old_count: two.old_count, new_count: two.new_count, added: two.added, removed: two.removed }, { old_count: 1, new_count: 1, added: 1, removed: 1 });
  assert.deepEqual(two.lines, ["-old", "+new", "\\ No newline at end of file"]);
  assert.equal(section.binary, false);
  assert.equal(section.mode_change, false);
});

test("parseSection detects binary files and mode changes", () => {
  const [, image, script] = splitPatch(PATCH);
  assert.equal(parseSection(image).binary, true);
  assert.deepEqual(parseSection(image).hunks, []);
  const mode = parseSection(script);
  assert.equal(mode.mode_change, true);
  assert.deepEqual(mode.mode, { old: "100644", new: "100755" });
  assert.equal(parseSection(["diff --git a/x b/x", "GIT binary patch", "literal 10"]).binary, true);
});

test("pairSections joins name-status entries with patch sections and refuses a count mismatch", () => {
  const entries = parseNameStatus(["M", "src/app.js", "M", "img/logo.png", "M", "run.sh", ""].join("\0"));
  const files = pairSections(entries, PATCH);
  assert.deepEqual(files.map((file) => [file.path, file.hunks.length, file.binary, file.mode_change]), [
    ["src/app.js", 2, false, false],
    ["img/logo.png", 0, true, false],
    ["run.sh", 0, false, true],
  ]);
  assert.equal(pairSections(entries.slice(0, 2), PATCH), null);
});

test("pairSections joins the deletion and creation git prints for a type change", () => {
  const patch = [
    "diff --git a/f b/f",
    "deleted file mode 100644",
    "index 422c2b7..0000000",
    "--- a/f",
    "+++ /dev/null",
    "@@ -1,2 +0,0 @@",
    "-a",
    "-b",
    "diff --git a/f b/f",
    "new file mode 120000",
    "index 0000000..1de5659",
    "--- /dev/null",
    "+++ b/f",
    "@@ -0,0 +1 @@",
    "+target",
    "\\ No newline at end of file",
    "diff --git a/g b/g",
    "index 1111111..2222222 100644",
    "--- a/g",
    "+++ b/g",
    "@@ -1 +1 @@",
    "-x",
    "+y",
    "",
  ].join("\n");
  const files = pairSections(parseNameStatus(["T", "f", "M", "g", ""].join("\0")), patch);
  assert.deepEqual(files.map((file) => [file.path, file.status, file.hunks.map(headRange)]), [["f", "T", [null, [1, 1]]], ["g", "M", [[1, 1]]]]);
  const lines = patch.split("\n");
  assert.equal(sectionText(files[0]), [...lines.slice(0, 5), ...lines.slice(8, 13), ...lines.slice(5, 8), ...lines.slice(13, 16)].join("\n"));
  assert.equal(pairSections(parseNameStatus(["M", "f", "M", "g", ""].join("\0")), patch), null);
});

test("sectionText rebuilds the header with all or picked hunks", () => {
  const [file] = pairSections(parseNameStatus(["M", "src/app.js", "M", "img/logo.png", "M", "run.sh", ""].join("\0")), PATCH);
  const all = sectionText(file).split("\n");
  assert.equal(all[0], "diff --git a/src/app.js b/src/app.js");
  assert.equal(all.filter((line) => line.startsWith("@@")).length, 2);
  const picked = sectionText(file, [1]).split("\n");
  assert.deepEqual(picked.slice(4), ["@@ -10 +11 @@", "-old", "+new", "\\ No newline at end of file"]);
});

test("changedLines numbers added lines on the head and removed lines on the base", () => {
  const [first] = splitPatch(PATCH);
  const [one, two] = parseSection(first).hunks;
  assert.deepEqual(changedLines(one), { added: [{ line: 2, text: "const b = 3;" }, { line: 3, text: "const c = 4;" }], removed: [{ line: 2, text: "const b = 2;" }] });
  assert.deepEqual(changedLines(two), { added: [{ line: 11, text: "new" }], removed: [{ line: 10, text: "old" }] });
});

test("headRange and baseRange cover a hunk's lines and are null for an empty side", () => {
  const hunk = { old_start: 5, old_count: 3, new_start: 6, new_count: 4 };
  assert.deepEqual(headRange(hunk), [6, 9]);
  assert.deepEqual(baseRange(hunk), [5, 7]);
  assert.equal(headRange({ new_start: 0, new_count: 0 }), null);
  assert.equal(baseRange({ old_start: 0, old_count: 0 }), null);
});

test("runs collapses numbers into sorted consecutive ranges", () => {
  assert.deepEqual(runs([5, 1, 2, 3, 7, 8, 8]), [[1, 3], [5, 5], [7, 8]]);
  assert.deepEqual(runs([]), []);
});
