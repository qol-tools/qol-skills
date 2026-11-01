import { copyFileSync, existsSync } from "node:fs";
import { inputError, toolError, usageError } from "./errors.mjs";
import { EMPTY_TREE, isAncestor, lines, mergeBase, objectExists, refExists, revParse, withTempIndex } from "./git.mjs";
import { PULL_REQUEST_URL, pullRequestInfo, repoOfPullRequest, viewPullRequest } from "./github.mjs";

const SNAPSHOT_ENV = {
  GIT_AUTHOR_NAME: "code-review-engine",
  GIT_AUTHOR_EMAIL: "code-review-engine@localhost",
  GIT_AUTHOR_DATE: "2000-01-01T00:00:00+0000",
  GIT_COMMITTER_NAME: "code-review-engine",
  GIT_COMMITTER_EMAIL: "code-review-engine@localhost",
  GIT_COMMITTER_DATE: "2000-01-01T00:00:00+0000",
};

export function parseTarget(input) {
  const text = String(input ?? "").trim();
  if (!text || text === "auto") return { kind: "auto", input: "auto" };
  if (["worktree", "staged", "branch"].includes(text)) return { kind: text, input: text };
  const url = PULL_REQUEST_URL.exec(text);
  if (url) return { kind: "pr", input: text, number: Number(url[3]), slug: `${url[1]}/${url[2]}` };
  const numbered = /^(?:#|pr[:/#]?)(\d+)$/i.exec(text);
  if (numbered) return { kind: "pr", input: text, number: Number(numbered[1]), slug: null };
  const symmetric = text.indexOf("...");
  if (symmetric >= 0) return { kind: "range", input: text, from: text.slice(0, symmetric) || "HEAD", to: text.slice(symmetric + 3) || "HEAD", symmetric: true };
  const plain = text.indexOf("..");
  if (plain >= 0) return { kind: "range", input: text, from: text.slice(0, plain) || "HEAD", to: text.slice(plain + 2) || "HEAD", symmetric: false };
  if (/^\d+$/.test(text)) return { kind: "number", input: text };
  return { kind: "rev", input: text, rev: text };
}

export function branchName(git, ref) {
  return ref && refExists(git, `refs/remotes/${ref}`) ? ref.slice(ref.indexOf("/") + 1) : ref;
}

export function currentBranch(git) {
  const name = git(["symbolic-ref", "--quiet", "--short", "HEAD"], { allowFail: true });
  return name ? name.trim() : null;
}

export function defaultBase(git) {
  const remoteHead = git(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"], { allowFail: true });
  if (remoteHead) return remoteHead.trim().replace(/^refs\/remotes\//, "");
  for (const name of ["main", "master", "trunk", "develop"]) {
    if (refExists(git, `refs/remotes/origin/${name}`)) return `origin/${name}`;
    if (refExists(git, `refs/heads/${name}`)) return name;
  }
  return null;
}

export function snapshot(git, mode) {
  const parent = revParse(git, "HEAD");
  const indexPath = git(["rev-parse", "--path-format=absolute", "--git-path", "index"]).trim();
  return withTempIndex((temp) => {
    if (existsSync(indexPath)) copyFileSync(indexPath, temp);
    const env = { GIT_INDEX_FILE: temp };
    if (mode === "worktree") git(["add", "-A", "--", "."], { env });
    const tree = git(["write-tree"], { env }).trim();
    const parentTree = parent ? git(["rev-parse", `${parent}^{tree}`]).trim() : EMPTY_TREE;
    if (tree === parentTree) return { sha: parent, snapshot: false, dirty: false };
    const args = ["-c", "commit.gpgSign=false", "commit-tree", tree, "--no-gpg-sign", "-m", `code-review-engine ${mode} snapshot`];
    if (parent) args.splice(4, 0, "-p", parent);
    const sha = git(args, { env: SNAPSHOT_ENV }).trim();
    return { sha, snapshot: true, dirty: true };
  });
}

function localTarget(git, kind) {
  const state = snapshot(git, kind === "staged" ? "staged" : "worktree");
  if (!state.snapshot) throw inputError(kind === "staged" ? "nothing is staged" : "the working tree has no uncommitted changes");
  const parent = revParse(git, "HEAD");
  return {
    kind,
    base: { ref: "HEAD", tip: parent ?? EMPTY_TREE, sha: parent ?? EMPTY_TREE },
    head: { ref: kind === "staged" ? "index" : "worktree", sha: state.sha, snapshot: true, dirty: true },
    notes: [],
  };
}

function branchTarget(git, kind, baseOverride, headRev = null) {
  const baseRef = baseOverride ?? defaultBase(git);
  if (!baseRef) throw inputError("no default branch found; pass --base <ref>");
  const tip = revParse(git, baseRef);
  if (!tip) throw inputError(`base ref ${baseRef} does not resolve to a commit`);
  let head;
  let ref;
  if (headRev) {
    head = { sha: revParse(git, headRev), snapshot: false, dirty: false };
    ref = headRev;
  } else {
    if (!revParse(git, "HEAD")) throw inputError("HEAD has no commits yet");
    head = snapshot(git, "worktree");
    ref = currentBranch(git) ?? "HEAD";
  }
  const from = mergeBase(git, tip, head.sha);
  if (!from) throw inputError(`${baseRef} and ${ref} share no history`);
  return {
    kind,
    base: { ref: baseRef, tip, sha: from },
    head: { ref, sha: head.sha, snapshot: head.snapshot, dirty: head.dirty },
    notes: head.snapshot ? ["uncommitted changes are included through a snapshot commit"] : [],
  };
}

function remoteFor(git, slug) {
  const remotes = lines(git(["remote", "-v"], { allowFail: true }));
  if (slug) {
    const match = remotes.find((line) => line.toLowerCase().includes(slug.toLowerCase()));
    if (match) return match.split(/\s+/)[0];
  }
  return remotes.some((line) => line.startsWith("origin\t")) ? "origin" : remotes[0]?.split(/\s+/)[0] ?? null;
}

function prTarget(git, gh, target) {
  const view = viewPullRequest(gh, target.slug ? target.input : target.number);
  if (!view) throw toolError(`gh pr view ${target.number} failed; check gh auth and that the pull request exists`);
  const remote = remoteFor(git, target.slug ?? repoOfPullRequest(view.url));
  if (!objectExists(git, `${view.headRefOid}^{commit}`)) {
    if (!remote) throw inputError("this repository has no remote to fetch the pull request from");
    git(["fetch", "--quiet", "--no-tags", remote, `refs/pull/${view.number}/head`]);
  }
  if (!objectExists(git, `${view.baseRefOid}^{commit}`)) git(["fetch", "--quiet", "--no-tags", remote ?? "origin", `refs/heads/${view.baseRefName}`]);
  if (!objectExists(git, `${view.headRefOid}^{commit}`)) throw inputError(`pull request head ${view.headRefOid} is not in this repository`);
  const from = mergeBase(git, view.baseRefOid, view.headRefOid);
  if (!from) throw inputError(`pull request #${view.number} shares no history with ${view.baseRefName}`);
  return {
    kind: "pr",
    base: { ref: view.baseRefName, tip: view.baseRefOid, sha: from },
    head: { ref: view.headRefName, sha: view.headRefOid, snapshot: false, dirty: false },
    pr: pullRequestInfo(view),
    notes: [],
  };
}

function rangeTarget(git, target) {
  const fromSha = revParse(git, target.from);
  const toSha = revParse(git, target.to);
  if (!fromSha) throw inputError(`${target.from} does not resolve to a commit`);
  if (!toSha) throw inputError(`${target.to} does not resolve to a commit`);
  const notes = [];
  let from = fromSha;
  if (target.symmetric || !isAncestor(git, fromSha, toSha)) {
    from = mergeBase(git, fromSha, toSha);
    if (!from) throw inputError(`${target.from} and ${target.to} share no history`);
    if (!target.symmetric) notes.push(`${target.from} is not an ancestor of ${target.to}; the diff starts at their merge base`);
  }
  return {
    kind: "range",
    base: { ref: target.from, tip: fromSha, sha: from },
    head: { ref: target.to, sha: toSha, snapshot: false, dirty: false },
    notes,
  };
}

function revTarget(git, rev, baseOverride) {
  const sha = revParse(git, rev);
  if (!sha) throw inputError(`${rev} does not resolve to a commit`);
  if (refExists(git, `refs/heads/${rev}`) || refExists(git, `refs/remotes/${rev}`)) return branchTarget(git, "branch", baseOverride, rev);
  const parent = revParse(git, `${sha}^`);
  return {
    kind: "commit",
    base: { ref: `${rev}^`, tip: parent ?? EMPTY_TREE, sha: parent ?? EMPTY_TREE },
    head: { ref: rev, sha, snapshot: false, dirty: false },
    notes: parent && revParse(git, `${sha}^2`) ? ["merge commit; the diff is against its first parent"] : [],
  };
}

export function resolveTarget(target, { git, gh, base = null }) {
  switch (target.kind) {
    case "auto": {
      const branch = currentBranch(git);
      const baseRef = base ?? defaultBase(git);
      if (branch && baseRef && branch !== branchName(git, baseRef)) return { ...branchTarget(git, "branch", base), input: "auto" };
      if (git(["status", "--porcelain=v1", "-z", "--untracked-files=normal"]).length > 0) return { ...localTarget(git, "worktree"), input: "auto" };
      throw inputError("nothing to review on a clean default branch; pass a pull request, range, commit or branch");
    }
    case "worktree":
    case "staged":
      return { ...localTarget(git, target.kind), input: target.input };
    case "branch":
      return { ...branchTarget(git, "branch", base), input: target.input };
    case "pr":
      return { ...prTarget(git, gh, target), input: target.input };
    case "number":
      if (revParse(git, target.input)) throw usageError(`${target.input} is ambiguous; use #${target.input} for a pull request or a longer commit sha`);
      return { ...prTarget(git, gh, { ...target, kind: "pr", number: Number(target.input), slug: null }), input: target.input };
    case "range":
      return { ...rangeTarget(git, target), input: target.input };
    default:
      return { ...revTarget(git, target.rev, base), input: target.input };
  }
}
