import path from "node:path";
import { mkdirSync } from "node:fs";
import { withDefaults, worktreeBranch, worktreePath } from "./paths.mjs";

function fail(message, result) {
  const detail = String(result?.stderr ?? "").trim() || result?.error || `exit ${result?.status}`;
  return new Error(`${message}: ${detail}`);
}

function target(first, second, third, fourth) {
  if (typeof first === "string") return { repoRoot: first, path: second, base: third, branch: fourth };
  return {
    repoRoot: first.repoRoot,
    path: worktreePath(first.repoRoot, first.key, first.index),
    base: first.base,
    branch: worktreeBranch(first.key, first.index),
  };
}

export function addWorktree(first, second, third, fourth, fifth) {
  const legacy = typeof first === "string";
  const deps = legacy ? fifth : second;
  const d = withDefaults(deps);
  const { repoRoot, path: dir, base, branch } = target(first, second, third, fourth);
  if (d.exists(path.join(dir, ".git"))) return { path: dir, branch };
  (d.mkdir ?? ((folder) => mkdirSync(folder, { recursive: true })))(path.dirname(dir));
  const known = d.exec(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { cwd: repoRoot, env: d.env });
  const args = known.status === 0 ? ["worktree", "add", dir, branch] : ["worktree", "add", "-b", branch, dir, base];
  const added = d.exec(["git", ...args], { cwd: repoRoot, env: d.env });
  if (added.status !== 0) throw fail(`git worktree add failed for ${dir}`, added);
  return { path: dir, branch };
}

export function removeWorktree(dir, deps) {
  const d = withDefaults(deps);
  if (!d.exists(dir)) return { removed: false, branch: null };
  const common = d.exec(["git", "rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: dir, env: d.env });
  if (common.status !== 0) throw fail(`cannot find the repository of ${dir}`, common);
  const gitDir = String(common.stdout).trim();
  const head = d.exec(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd: dir, env: d.env });
  const branch = head.status === 0 ? String(head.stdout).trim() : null;
  const host = path.basename(gitDir) === ".git" ? path.dirname(gitDir) : gitDir;
  const gitArgs = path.basename(gitDir) === ".git" ? [] : ["--git-dir", gitDir];
  const removed = d.exec(["git", ...gitArgs, "worktree", "remove", "--force", "--force", dir], { cwd: host, env: d.env });
  if (removed.status !== 0) throw fail(`git worktree remove failed for ${dir}`, removed);
  const owned = branch !== null && branch.startsWith("loop-");
  if (owned) d.exec(["git", ...gitArgs, "branch", "-D", branch], { cwd: host, env: d.env });
  return { removed: true, branch: owned ? branch : null };
}
