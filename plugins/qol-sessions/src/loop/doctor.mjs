import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveQac, qacTrust } from "./gate.mjs";
import { detectLanes } from "./lanes/index.mjs";
import {
  EXIT,
  LoopError,
  commonDir,
  deleteBranch,
  loopsRoot,
  mainClone,
  readJson,
  removeWorktree,
  withDefaults,
  worktreePath,
} from "./paths.mjs";

const PRUNE_AGE_MS = 3 * 24 * 60 * 60 * 1000;

function defaultPluginRoot() {
  return fileURLToPath(new URL("../../", import.meta.url));
}

function check(name, status, detail, fix) {
  return fix ? { check: name, status, detail, fix } : { check: name, status, detail };
}

function nodeCheck(d) {
  const version = d.nodeVersion ?? process.versions.node;
  const major = Number(String(version).split(".")[0]);
  return major >= 18
    ? check("node", "pass", `node ${version}`)
    : check("node", "fail", `node ${version} is older than 18`, "install Node 18 or newer");
}

function hooksCheck(root, d) {
  const band = path.join(root, "hooks", "answer-band.ts");
  const modules = readJson(path.join(root, "hooks", "prompt-modules.json"), d);
  const listed = Array.isArray(modules?.modules) && modules.modules.some((entry) => /answer-band\.ts$/.test(String(entry)));
  if (d.exists(band) && listed) return check("hooks module", "pass", "answer-band.ts is listed in hooks/prompt-modules.json");
  if (!d.exists(band)) return check("hooks module", "fail", `${band} is missing`, "reinstall the qol-sessions plugin");
  return check("hooks module", "fail", "hooks/prompt-modules.json does not list ./answer-band.ts", "list ./answer-band.ts in hooks/prompt-modules.json");
}

function mcpCheck(root, lanes, d) {
  const mcp = readJson(path.join(root, "mcp.json"), d);
  if (!mcp?.mcpServers?.["qol-sessions"]) {
    return check("mcp", "fail", "mcp.json does not declare the qol-sessions server", "reinstall the qol-sessions plugin");
  }
  return lanes.qol
    ? check("mcp", "pass", "mcp.json declares the qol-sessions server and qol is on PATH")
    : check("mcp", "warn", "mcp.json declares the qol-sessions server, but qol is not on PATH so the qol-sessions MCP will show failed", "install qol, or disable the qol-sessions server in /mcp");
}

function scriptRootCheck(root, d) {
  const missing = ["scripts/loop.mjs", "bin/qols"].filter((rel) => !d.exists(path.join(root, rel)));
  return missing.length === 0
    ? check("script root", "pass", root)
    : check("script root", "fail", `${root} is missing ${missing.join(", ")}`, "reinstall the qol-sessions plugin");
}

function trustCheck(cwd, qac, d) {
  if (!qac) return check("trust", "warn", "skipped: qac is missing");
  try {
    commonDir(cwd, d);
  } catch {
    return check("trust", "warn", `skipped: ${cwd} is not inside a git repository`);
  }
  const trust = qacTrust({ cwd }, d);
  return trust.trusted
    ? check("trust", "pass", "qac trusts this repository's judges")
    : check("trust", "warn", "qac does not trust this repository's judges yet", "run: qac trust approve");
}

function parseWorktrees(text) {
  const entries = [];
  let current = null;
  for (const line of String(text).split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length).trim(), branch: null };
      entries.push(current);
    } else if (line.startsWith("branch ") && current) {
      current.branch = line.slice("branch ".length).trim().replace(/^refs\/heads\//, "");
    }
  }
  return entries;
}

function loopWorktrees(common, repoRoot, d) {
  const live = new Set();
  const recorded = new Map();
  const root = loopsRoot(common);
  let keys = [];
  try {
    keys = d.readdir(root);
  } catch {
    keys = [];
  }
  for (const key of keys) {
    const dir = path.join(root, key);
    const loop = readJson(path.join(dir, "loop.json"), d);
    const closed = readJson(path.join(dir, "closed.json"), d);
    for (const worktree of loop?.worktrees ?? []) recorded.set(worktree.path, worktree.branch ?? null);
    if (closed) {
      if (closed.kept?.path) live.add(closed.kept.path);
      for (const kept of closed.kept_all ?? []) if (kept?.path) live.add(kept.path);
      continue;
    }
    if (!loop) continue;
    for (const worktree of loop.worktrees ?? []) live.add(worktree.path);
    live.add(worktreePath(repoRoot, loop.key ?? key, "control"));
  }
  return { live, recorded };
}

export function pruneOrphans(options, deps) {
  const d = withDefaults(deps);
  const common = commonDir(options.cwd, d);
  const repoRoot = mainClone(common);
  const listed = d.exec(["git", "worktree", "list", "--porcelain"], { cwd: repoRoot });
  if (listed.status !== 0) throw new LoopError(`git worktree list failed: ${String(listed.stderr).trim()}`, EXIT.infra);
  const { live, recorded } = loopWorktrees(common, repoRoot, d);
  const now = d.now().getTime();
  const pruned = [];
  const kept = [];
  for (const entry of parseWorktrees(listed.stdout)) {
    if (!recorded.has(entry.path) || live.has(entry.path)) continue;
    let age = 0;
    try {
      age = now - d.stat(entry.path).mtimeMs;
    } catch {
      age = Number.POSITIVE_INFINITY;
    }
    if (age <= PRUNE_AGE_MS) {
      kept.push({ path: entry.path, branch: entry.branch, reason: "younger than 3 days" });
      continue;
    }
    const status = Number.isFinite(age) ? d.exec(["git", "status", "--porcelain"], { cwd: entry.path }) : { status: 0, stdout: "" };
    if (status.status !== 0 || String(status.stdout ?? "").trim() !== "") {
      kept.push({ path: entry.path, branch: entry.branch, reason: status.status !== 0 ? "could not check for uncommitted changes" : "uncommitted changes" });
      continue;
    }
    removeWorktree(repoRoot, entry.path, d);
    if (entry.branch && entry.branch === recorded.get(entry.path)) deleteBranch(repoRoot, entry.branch, d);
    pruned.push({ path: entry.path, branch: entry.branch });
  }
  return { pruned, kept };
}

export function doctorLoop(options = {}, deps) {
  const d = withDefaults(deps);
  const cwd = options.cwd ?? process.cwd();
  const root = d.pluginRoot ?? defaultPluginRoot();
  const lanes = detectLanes(d);
  const qac = resolveQac(d);
  const checks = [
    nodeCheck(d),
    lanes.qol ? check("qol", "pass", lanes.qol) : check("qol", "warn", "qol is not on PATH, so kitty lanes are unavailable", "install qol"),
    lanes.kitty
      ? check("kitty lanes", "pass", "qol sessions spawn reports receipt_path")
      : check("kitty lanes", "warn", "qol sessions spawn does not report receipt_path", "update qol to a build with silent-wake receipts"),
    lanes.headless
      ? check("headless lanes", "pass", `QOLS_HEADLESS_LANES=1 and claude at ${lanes.claude}`)
      : check("headless lanes", "warn", "needs QOLS_HEADLESS_LANES=1 and claude on PATH", "export QOLS_HEADLESS_LANES=1"),
    qac
      ? check("qac", "pass", `${qac.argv.join(" ")} (${qac.source})`)
      : check("qac", "fail", "qac is not on PATH and no qol-project plugin cache holds scripts/qac.mjs", "install the qol-project plugin"),
    hooksCheck(root, d),
    trustCheck(cwd, qac, d),
    mcpCheck(root, lanes, d),
    scriptRootCheck(root, d),
  ];
  const ok = !checks.some((entry) => entry.status === "fail");
  const result = { exit: ok ? EXIT.ok : EXIT.infra, ok, checks, lanes };
  if (options.prune) result.prune = pruneOrphans({ cwd }, d);
  return result;
}
