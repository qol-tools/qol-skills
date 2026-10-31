import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const MAX_BUFFER = 256 * 1024 * 1024;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export function runGit(cwd, args, deps = {}, env = {}, input = undefined) {
  const exec = deps.exec ?? execFileSync;
  try {
    return String(exec("git", args, {
      cwd,
      encoding: "utf8",
      env: { ...(deps.env ?? process.env), ...env },
      stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
      maxBuffer: MAX_BUFFER,
      ...(input === undefined ? {} : { input }),
    }) ?? "");
  } catch (error) {
    const stderr = String(error?.stderr ?? "").trim();
    throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${stderr || error?.message}`);
  }
}

function hasHead(cwd, deps) {
  try {
    runGit(cwd, ["rev-parse", "--verify", "-q", "HEAD"], deps);
    return true;
  } catch {
    return false;
  }
}

function splitZero(text) {
  return text.split("\0").filter(Boolean);
}

export function gitCommonDir(cwd, deps = {}) {
  const out = runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], deps).trim();
  return path.resolve(cwd, out);
}

export function topLevel(cwd, deps = {}) {
  const out = runGit(cwd, ["rev-parse", "--show-toplevel"], deps).trim();
  return out ? path.resolve(out) : path.resolve(cwd);
}

export function treeId(cwd, deps = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "qac-index-"));
  const env = { GIT_INDEX_FILE: path.join(dir, "index") };
  try {
    if (hasHead(cwd, deps)) runGit(cwd, ["read-tree", "HEAD"], deps, env);
    runGit(cwd, ["add", "-A"], deps, env);
    return runGit(cwd, ["write-tree"], deps, env).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function baseRev(cwd, base, deps) {
  return base === "HEAD" && !hasHead(cwd, deps) ? EMPTY_TREE : base;
}

export function changeEntries(cwd, base = "HEAD", deps = {}) {
  const tree = deps.tree ?? treeId(cwd, deps);
  const tokens = splitZero(runGit(cwd, ["diff-tree", "-r", "-M", "--name-status", "-z", baseRev(cwd, base, deps), tree], deps));
  const entries = [];
  for (let i = 0; i < tokens.length;) {
    const status = tokens[i++];
    const kind = status[0];
    if (kind === "R" || kind === "C") {
      const from = tokens[i++];
      entries.push({ status: kind, path: tokens[i++], from });
    } else {
      entries.push({ status: kind, path: tokens[i++], from: null });
    }
  }
  return entries;
}

export function diffPatch(cwd, base = "HEAD", deps = {}) {
  const tree = deps.tree ?? treeId(cwd, deps);
  return runGit(cwd, [
    "-c", "core.quotePath=false",
    "diff-tree", "-p", "-r", "-M", "-U0", "--text", "--no-color", "--no-ext-diff", "--no-textconv",
    "--src-prefix=a/", "--dst-prefix=b/", baseRev(cwd, base, deps), tree,
  ], deps);
}

export function changedFiles(cwd, base = "HEAD", deps = {}) {
  const files = changeEntries(cwd, base, deps).filter(entry => entry.status !== "D").map(entry => entry.path);
  return [...new Set(files)].sort();
}

function expandBraces(glob) {
  const open = glob.indexOf("{");
  if (open < 0) return [glob];
  let depth = 0;
  let close = -1;
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === "{") depth++;
    else if (glob[i] === "}" && --depth === 0) {
      close = i;
      break;
    }
  }
  if (close < 0) return [glob];
  const parts = [];
  let nested = 0;
  let start = open + 1;
  for (let i = open + 1; i < close; i++) {
    if (glob[i] === "{") nested++;
    else if (glob[i] === "}") nested--;
    else if (glob[i] === "," && nested === 0) {
      parts.push(glob.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(glob.slice(start, close));
  const head = glob.slice(0, open);
  const tail = glob.slice(close + 1);
  return parts.flatMap(part => expandBraces(`${head}${part}${tail}`));
}

function globRegExp(glob) {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i];
    if (char === "*" && glob[i + 1] === "*" && glob[i + 2] === "/") {
      source += "(?:.*/)?";
      i += 2;
    } else if (char === "*" && glob[i + 1] === "*") {
      source += ".*";
      i += 1;
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function cleanPath(value) {
  return value.replace(/\\/g, "/").replace(/^\.\//, "");
}

function matchOne(glob, file) {
  const target = cleanPath(file);
  const pattern = cleanPath(glob).replace(/\/$/, "");
  if (!/[*?]/.test(pattern)) return target === pattern || target.startsWith(`${pattern}/`);
  if (!pattern.includes("/")) return globRegExp(pattern).test(target.split("/").pop());
  return globRegExp(pattern).test(target);
}

export function matchGlob(glob, file) {
  return expandBraces(String(glob)).some(expanded => matchOne(expanded, String(file)));
}
