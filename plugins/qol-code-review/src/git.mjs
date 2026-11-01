import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { toolError } from "./errors.mjs";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const MAX_BUFFER = 512 * 1024 * 1024;

export function commandRunner(program, cwd, { exec = execFileSync, env: baseEnv = process.env } = {}) {
  return (args, { input, env, allowFail = false } = {}) => {
    try {
      return exec(program, args, {
        cwd,
        input,
        env: env ? { ...baseEnv, ...env } : baseEnv,
        encoding: "utf8",
        maxBuffer: MAX_BUFFER,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (error) {
      if (allowFail) return null;
      const stderr = String(error.stderr ?? error.message ?? "").trim();
      throw toolError(`${program} ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`);
    }
  };
}

export function revParse(git, rev) {
  const sha = git(["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { allowFail: true });
  return sha ? sha.trim() : null;
}

export function mergeBase(git, left, right) {
  const sha = git(["merge-base", left, right], { allowFail: true });
  return sha ? sha.trim() : null;
}

export function isAncestor(git, ancestor, descendant) {
  return git(["merge-base", "--is-ancestor", ancestor, descendant], { allowFail: true }) !== null;
}

export function refExists(git, ref) {
  return git(["show-ref", "--verify", "--quiet", ref], { allowFail: true }) !== null;
}

export function objectExists(git, spec) {
  return git(["cat-file", "-e", spec], { allowFail: true }) !== null;
}

export function lines(text) {
  return String(text ?? "").split("\n").filter(Boolean);
}

export function withTempIndex(run) {
  const dir = mkdtempSync(join(tmpdir(), "code-review-engine-index-"));
  try {
    return run(join(dir, "index"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function materializeTree(git, sha, root) {
  const dir = join(root, "trees", sha);
  const done = `${dir}.done`;
  if (existsSync(done) && existsSync(dir)) return dir;
  const staging = `${dir}.partial-${process.pid}`;
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  withTempIndex((index) => {
    const env = { GIT_INDEX_FILE: index };
    git(["read-tree", sha], { env });
    git(["-c", "core.symlinks=false", "-c", "filter.lfs.smudge=", "-c", "filter.lfs.process=", "-c", "filter.lfs.required=false", "checkout-index", "-a", "-f", `--prefix=${staging}/`], { env });
  });
  rmSync(dir, { recursive: true, force: true });
  renameSync(staging, dir);
  writeFileSync(done, `${sha}\n`);
  return dir;
}
