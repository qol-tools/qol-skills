import path from "node:path";
import { mkdirSync } from "node:fs";
import { withDefaults, worktreeBranch, worktreePath } from "./paths.mjs";

function fail(message, result) {
  const detail = String(result?.stderr ?? "").trim() || result?.error || `exit ${result?.status}`;
  return new Error(`${message}: ${detail}`);
}

export function addWorktree({ repoRoot, key, index, base }, deps) {
  const d = withDefaults(deps);
  const dir = worktreePath(repoRoot, key, index);
  const branch = worktreeBranch(key, index);
  if (d.exists(path.join(dir, ".git"))) return { path: dir, branch };
  (d.mkdir ?? ((folder) => mkdirSync(folder, { recursive: true })))(path.dirname(dir));
  const known = d.exec(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoRoot, env: d.env });
  const args = known.status === 0 ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, base];
  const added = d.exec(["git", ...args], { cwd: repoRoot, env: d.env });
  if (added.status !== 0) throw fail(`git worktree add failed for ${dir}`, added);
  return { path: dir, branch };
}
