import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { changeEntries, diffPatch, matchGlob, runGit, topLevel, treeId } from "./tree.mjs";

const SUPPRESSION = /#\[allow\(|#\[ignore\]|eslint-disable|@ts-ignore|@ts-expect-error|# noqa|# type: ignore|\.only\(|\.skip\(|\bxit\(|pytest\.mark\.skip/;
const ALWAYS_PROTECTED = [".qac/**"];
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DETAIL_LIMIT = 160;

function anyGlob(globs, file) {
  return globs.some(glob => matchGlob(glob, file));
}

function splitZero(text) {
  return text.split("\0").filter(Boolean);
}

function patchPath(raw) {
  let value = raw.replace(/\t.*$/, "");
  if (value === "/dev/null") return null;
  if (value.startsWith('"')) {
    try {
      value = JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value.replace(/^b\//, "");
}

export function addedLines(patch) {
  const added = [];
  let file = null;
  let line = 0;
  let inHunk = false;
  for (const raw of String(patch ?? "").split("\n")) {
    if (raw.startsWith("diff --git ")) {
      inHunk = false;
      file = null;
      continue;
    }
    const hunk = inHunk && raw.startsWith("+") ? null : HUNK.exec(raw);
    if (hunk) {
      inHunk = true;
      line = Number(hunk[1]);
    } else if (!inHunk) {
      if (raw.startsWith("+++ ")) file = patchPath(raw.slice(4));
    } else if (raw.startsWith("+")) {
      added.push({ file, line, text: raw.slice(1) });
      line++;
    } else if (raw.startsWith(" ")) {
      line++;
    }
  }
  return added;
}

function suppressions(patch) {
  return addedLines(patch)
    .filter(add => add.file && SUPPRESSION.test(add.text))
    .map(add => ({
      kind: "suppression",
      file: add.file,
      detail: `line ${add.line}: ${add.text.trim().slice(0, DETAIL_LIMIT)}`,
    }));
}

function testRenames(entries, tests) {
  return entries.flatMap(entry => {
    if (entry.status === "D" && anyGlob(tests, entry.path)) {
      return [{ kind: "test-rename", file: entry.path, detail: "test file deleted" }];
    }
    if (entry.status === "R" && anyGlob(tests, entry.from) && !anyGlob(tests, entry.path)) {
      return [{ kind: "test-rename", file: entry.from, detail: `test file renamed outside test paths to ${entry.path}` }];
    }
    return [];
  });
}

function hiddenUntracked(root, deps) {
  const perDirectory = splitZero(runGit(root, ["ls-files", "--others", "--exclude-per-directory=.gitignore", "-z"], deps));
  const visible = new Set(splitZero(runGit(root, ["ls-files", "--others", "--exclude-standard", "-z"], deps)));
  return perDirectory
    .filter(file => !visible.has(file))
    .sort()
    .map(file => ({ kind: "untracked", file, detail: "hidden by .git/info/exclude or global excludes" }));
}

function touched(entries) {
  return [...new Set(entries.flatMap(entry => [entry.path, entry.from]).filter(Boolean))];
}

function protectedEdits(paths, globs) {
  return paths
    .filter(file => anyGlob(globs, file))
    .map(file => ({ kind: "protected", file, detail: "protected path changed" }));
}

function ownerEdits(paths, owned) {
  if (!Array.isArray(owned)) return [];
  return paths
    .filter(file => !anyGlob(owned, file))
    .map(file => ({ kind: "owner", file, detail: "changed file is outside the owned globs" }));
}

function specChecks({ cwd, specPath, specSha }, deps) {
  if (!specPath || !specSha) return [];
  const read = deps.read ?? readFileSync;
  let actual;
  try {
    actual = createHash("sha256").update(read(path.resolve(cwd, specPath))).digest("hex");
  } catch (error) {
    return [{ kind: "spec-sha", file: specPath, detail: `spec unreadable: ${error.message}` }];
  }
  if (actual === String(specSha).toLowerCase()) return [];
  return [{ kind: "spec-sha", file: specPath, detail: `sha256 ${actual} does not match expected ${specSha}` }];
}

function unique(items) {
  const seen = new Set();
  return items.filter(item => {
    const key = JSON.stringify([item.kind, item.file, item.detail]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function tamperChecks({ cwd, base = "HEAD", config, owned, specPath, specSha }, deps = {}) {
  const root = topLevel(cwd, deps);
  const shared = { ...deps, tree: deps.tree ?? treeId(root, deps) };
  const entries = changeEntries(root, base, shared);
  const paths = touched(entries);
  return unique([
    ...suppressions(diffPatch(root, base, shared)),
    ...testRenames(entries, config?.tests ?? []),
    ...hiddenUntracked(root, shared),
    ...protectedEdits(paths, [...ALWAYS_PROTECTED, ...(config?.protected ?? [])]),
    ...ownerEdits(paths, owned),
    ...specChecks({ cwd, specPath, specSha }, shared),
  ]);
}
