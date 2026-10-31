import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { withDefaults } from "./paths.mjs";

function git(d, args, cwd, env) {
  const result = d.exec(["git", ...args], { cwd, env });
  if (result.status !== 0) {
    const detail = String(result.stderr ?? "").trim() || result.error || `exit ${result.status}`;
    throw new Error(`git ${args[0]} failed in ${cwd}: ${detail}`);
  }
  return String(result.stdout ?? "");
}

export function captureDiff(cwd, base, deps) {
  const d = withDefaults(deps);
  const temp = (d.mkdtemp ?? mkdtempSync)(path.join(os.tmpdir(), "qols-diff-"));
  const env = { ...d.env, GIT_INDEX_FILE: path.join(temp, "index") };
  try {
    git(d, ["read-tree", base], cwd, env);
    git(d, ["add", "-A"], cwd, env);
    return git(d, ["diff", "--cached", "--text", "--no-color", "--no-ext-diff", base], cwd, env);
  } finally {
    (d.rmdir ?? ((dir) => rmSync(dir, { recursive: true, force: true })))(temp);
  }
}

export function changedPaths(patch) {
  const found = new Set();
  for (const line of String(patch ?? "").split(/\r?\n/)) {
    const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (match) found.add(match[2]);
  }
  return [...found].sort();
}
