import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ALWAYS_PROTECTED } from "./config.mjs";
import { baseRev, changeEntries, diffPatch, matchGlob, runGit, topLevel, treeId } from "./tree.mjs";

const SUPPRESSION = /#!?\[allow\(|#\[ignore|eslint-disable|@ts-ignore|@ts-expect-error|# noqa|# type: ignore|\.only\(|\.skip\(|\bxit\(|pytest\.mark\.skip|\{\s*(?:skip|todo)\s*:\s*true/;
const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };
const HUNK = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const DETAIL_LIMIT = 160;

function anyGlob(globs, file) {
  return globs.some(glob => matchGlob(glob, file));
}

function splitZero(text) {
  return text.split("\0").filter(Boolean);
}

function isOctal(char) {
  return typeof char === "string" && char >= "0" && char <= "7";
}

function decodeQuoted(value) {
  const chars = Array.from(value.length > 1 && value.endsWith('"') ? value.slice(1, -1) : value.slice(1));
  const bytes = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== "\\") {
      bytes.push(...Buffer.from(chars[i]));
    } else if (isOctal(chars[i + 1])) {
      let digits = "";
      while (digits.length < 3 && isOctal(chars[i + 1])) digits += chars[++i];
      bytes.push(parseInt(digits, 8) & 255);
    } else if (Object.hasOwn(C_ESCAPES, chars[i + 1])) {
      bytes.push(C_ESCAPES[chars[++i]]);
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function patchPath(raw) {
  const value = raw.replace(/\t.*$/, "");
  if (value === "/dev/null") return null;
  return (value.startsWith('"') ? decodeQuoted(value) : value).replace(/^b\//, "");
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

function ignoredAtBase(root, base, files, deps) {
  const rev = baseRev(root, base, deps);
  const dir = mkdtempSync(path.join(tmpdir(), "qac-ignore-"));
  try {
    const listed = splitZero(runGit(root, ["ls-tree", "-r", "-z", "--name-only", rev], deps))
      .filter(file => path.posix.basename(file) === ".gitignore");
    for (const file of listed) {
      const target = path.join(dir, ...file.split("/"));
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, runGit(root, ["show", `${rev}:${file}`], deps));
    }
    const gitDir = path.resolve(root, runGit(root, ["rev-parse", "--absolute-git-dir"], deps).trim());
    const out = runGit(
      dir,
      ["check-ignore", "--no-index", "-z", "--stdin"],
      deps,
      { GIT_DIR: gitDir, GIT_WORK_TREE: dir },
      `${files.join("\0")}\0`,
    );
    return new Set(splitZero(out));
  } catch {
    return new Set();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function newlyIgnored(root, base, entries, deps) {
  const dirs = entries
    .filter(entry => entry.status !== "D" && path.posix.basename(entry.path) === ".gitignore")
    .map(entry => path.posix.dirname(entry.path));
  if (dirs.length === 0) return [];
  const ignored = splitZero(runGit(root, ["ls-files", "--others", "--ignored", "--exclude-per-directory=.gitignore", "-z"], deps))
    .filter(file => dirs.some(dir => dir === "." || file.startsWith(`${dir}/`)));
  if (ignored.length === 0) return [];
  const before = ignoredAtBase(root, base, ignored, deps);
  return ignored
    .filter(file => !before.has(file))
    .sort()
    .map(file => ({ kind: "untracked", file, detail: "ignored by a .gitignore added or changed since the base" }));
}

function acceptEdits(entries, accept, root) {
  const named = new Set();
  for (const item of accept ?? []) {
    for (const token of item?.argv ?? []) {
      if (typeof token !== "string" || token.startsWith("-") || !/[/.]/.test(token)) continue;
      const relative = path.isAbsolute(token) ? path.relative(root, token) : token;
      if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      named.add(relative);
    }
  }
  if (named.size === 0) return [];
  return entries
    .filter(entry => entry.status !== "A")
    .map(entry => entry.from ?? entry.path)
    .filter(file => [...named].some(token => matchGlob(token, file)))
    .map(file => ({ kind: "accept-edit", file, detail: "file named in an accept command existed at the base and changed" }));
}

function mutations(root, before, reports, cwd, deps) {
  const after = treeId(root, deps);
  if (after === before) return [];
  const declared = (reports ?? [])
    .map(report => path.relative(root, path.resolve(cwd, String(report))).split(path.sep).join("/"))
    .filter(report => report !== "" && !report.startsWith(".."));
  return splitZero(runGit(root, ["diff-tree", "-r", "--name-only", "-z", before, after], deps))
    .filter(file => !anyGlob(declared, file))
    .sort()
    .map(file => ({ kind: "mutated", file, detail: "changed while the judges ran" }));
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

export function tamperChecks({ cwd, base = "HEAD", config, owned, specPath, specSha, accept, tree, reports }, deps = {}) {
  const root = topLevel(cwd, deps);
  const judged = tree ?? treeId(root, deps);
  const shared = { ...deps, tree: judged };
  const entries = changeEntries(root, base, shared);
  const paths = touched(entries);
  return unique([
    ...suppressions(diffPatch(root, base, shared)),
    ...testRenames(entries, config?.tests ?? []),
    ...acceptEdits(entries, accept, root),
    ...hiddenUntracked(root, shared),
    ...newlyIgnored(root, base, entries, shared),
    ...protectedEdits(paths, [...ALWAYS_PROTECTED, ...(config?.protected ?? [])]),
    ...ownerEdits(paths, owned),
    ...specChecks({ cwd, specPath, specSha }, shared),
    ...(tree ? mutations(root, tree, reports, cwd, deps) : []),
  ]);
}
