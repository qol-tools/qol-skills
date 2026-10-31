import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LANE = { tool: "claude", model: "opus", effort: "high" };
const KEY_SLUG_LIMIT = 40;
const QAC_SOURCE = path.join("plugins", "qol-project", "src", "qac.mjs");
const DEFAULT_CLI = fileURLToPath(new URL("../scripts/qac.mjs", import.meta.url));
const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10000;
const LOCK_POLL_MS = 25;
const FINGERPRINT_LOOPS = 2;

export const ROUTES = ["qac-check", "repo-linter", "tamper", "agent-behaviour", "judge-revert"];
export const DEFAULT_ROUTE = "qac-check";
const ROUTE_HOME = {
  "qac-check": "skills-clone",
  "repo-linter": "origin",
  tamper: "skills-clone",
  "agent-behaviour": null,
  "judge-revert": null,
};

export function ledgerFile(env = process.env) {
  if (env.QAC_LEDGER_DATA) return path.join(env.QAC_LEDGER_DATA, "slips.jsonl");
  const data = env.XDG_DATA_HOME || path.join(homedir(), ".local", "share");
  return path.join(data, "qac-ledger", "slips.jsonl");
}

export function slugOf(pattern) {
  return pattern.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

export function laneKey(id) {
  return `qac-rule-${id.slice(0, KEY_SLUG_LIMIT).replace(/-+$/, "")}`;
}

export function readSlips(file, read = readFileSync) {
  let text;
  try {
    text = read(file, "utf8");
  } catch {
    return new Map();
  }
  const slips = new Map();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.id) slips.set(entry.id, entry);
    } catch {
      continue;
    }
  }
  return slips;
}

export function writeSlip(file, entry, append = appendFileSync) {
  mkdirSync(path.dirname(file), { recursive: true });
  append(file, `${JSON.stringify(entry)}\n`);
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function quietly(action) {
  try {
    action();
  } catch {
    return false;
  }
  return true;
}

export function withLock(file, fn, deps = {}) {
  const lock = `${file}.lock`;
  const nowMs = deps.nowMs ?? Date.now;
  const sleep = deps.sleep ?? sleepSync;
  const create = deps.createLock ?? (target => writeFileSync(target, String(process.pid), { flag: "wx" }));
  const age = deps.lockAge ?? (target => nowMs() - statSync(target).mtimeMs);
  const remove = deps.removeLock ?? unlinkSync;
  mkdirSync(path.dirname(file), { recursive: true });
  const deadline = nowMs() + LOCK_WAIT_MS;
  for (;;) {
    try {
      create(lock);
      break;
    } catch (failure) {
      if (failure.code !== "EEXIST") throw failure;
    }
    let stale = false;
    const aged = quietly(() => {
      stale = age(lock) > LOCK_STALE_MS;
    });
    if (aged && stale && quietly(() => remove(lock))) continue;
    if (nowMs() >= deadline) throw Object.assign(new Error(`could not lock ${file}`), { code: "ELOCK" });
    if (aged) sleep(LOCK_POLL_MS);
  }
  try {
    return fn();
  } finally {
    quietly(() => remove(lock));
  }
}

export function qolOnPath(env = process.env, exists = existsSync) {
  const names = process.platform === "win32" ? ["qol.exe", "qol.cmd", "qol"] : ["qol"];
  return (env.PATH ?? "").split(path.delimiter).filter(Boolean).some(dir => names.some(name => exists(path.join(dir, name))));
}

function mainClone(cwd, exec) {
  try {
    const common = exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return path.dirname(path.resolve(common));
  } catch {
    return null;
  }
}

export function rulesRepo(cwd, { explicit = null, exec = execFileSync, exists = existsSync, route = DEFAULT_ROUTE } = {}) {
  const home = ROUTE_HOME[route];
  if (home === null) return null;
  if (home === "origin") {
    if (explicit) return exists(path.join(explicit, ".git")) ? path.resolve(explicit) : null;
    return mainClone(cwd, exec);
  }
  const isClone = dir => exists(path.join(dir, QAC_SOURCE));
  if (explicit) return isClone(explicit) ? path.resolve(explicit) : null;
  const main = mainClone(cwd, exec);
  if (main === null) return null;
  return [main, path.join(path.dirname(main), "qol-skills")].find(isClone) ?? null;
}

function subject(entry) {
  if (entry.kind === "fingerprint") {
    const loops = entry.loops.length ? `, seen in loops ${entry.loops.join(", ")}` : "";
    return `the finding ${JSON.stringify(entry.message ?? entry.pattern)} (judge ${entry.judge}, rule ${entry.rule}, fingerprint ${entry.fingerprint}) slipped past the local gate (first seen ${entry.first_seen}${loops}`;
  }
  return `the pattern ${JSON.stringify(entry.pattern)} slipped past qac (first seen ${entry.first_seen}`;
}

function settleCommand(entry, cli) {
  const target = entry.kind === "fingerprint" ? `--fingerprint ${entry.fingerprint}` : JSON.stringify(entry.pattern);
  return `node ${JSON.stringify(cli)} slip ${target}`;
}

const ROUTE_STEPS = {
  "qac-check": [
    "Add the qac rule that catches it in plugins/qol-project of this repo: a filter in the owning bin/check-*.cjs hook, reachable through its lintFile so `qac lint` runs it, with fixtures and node:test tests for every branch, and the owning skill section updated.",
    "Load hook-design:incident-guards, qol-workflow:writing-skills-and-help, marketplace-publishing:marketplace-publishing and qol-workflow:commit first. qol-skills commits direct to main.",
  ],
  "repo-linter": [
    "The miss came from this repository, and its own linter can express the rule: add it to the rules home of the judge that should have caught it (clippy.toml, the eslint config, ruff settings), with a fixture that trips it.",
    "Work in a new git worktree of this repository on a branch named after the lane key, never in the main checkout and never on the default branch.",
    "Land it only as a draft pull request (`gh pr create --draft`). Never mark it ready and never merge it: the repository's owners decide.",
  ],
  tamper: [
    "Add the tamper check that catches it to `qac gate` in plugins/qol-project of this repo: a new entry kind or a new match in the existing suppression, test-rename, untracked, protected or owner checks, with fixtures and node:test tests for every branch.",
    "Load hook-design:incident-guards, qol-workflow:writing-skills-and-help, marketplace-publishing:marketplace-publishing and qol-workflow:commit first. qol-skills commits direct to main.",
  ],
};

export function laneBrief(entry, cli = DEFAULT_CLI) {
  const route = entry.route ?? DEFAULT_ROUTE;
  const command = settleCommand(entry, cli);
  const sources = entry.sources.length ? entry.sources.join(", ") : "no source given";
  const where = route === "repo-linter" ? "Report the outcome, with the draft pull request link, to the user in this terminal." : "Report the outcome to the user in this terminal.";
  return [
    `qac slip: ${subject(entry)}, from ${sources}).`,
    ...ROUTE_STEPS[route],
    `When the rule is ${route === "repo-linter" ? "in the draft pull request" : "pushed"}, run: ${command} --added`,
    `If no deterministic rule can catch it, run: ${command} --infeasible "<reason>" and stop. The ledger never forks a lane for it again.`,
    where,
  ].join("\n");
}

export function suggestionBrief(entry) {
  const sources = entry.sources.length ? entry.sources.join(", ") : "no source given";
  const what = entry.kind === "fingerprint" ? entry.message ?? entry.pattern : entry.pattern;
  return [
    `qac slip: ${JSON.stringify(what)} is agent behaviour, a command or tool use rather than code (from ${sources}), so no rule lane is forked.`,
    `Suggest a mistake-ledger rule at warn that names the behaviour: ${JSON.stringify(what)}.`,
    "Only the user raises a mistake-ledger rule to block.",
  ].join("\n");
}

export function forkLane(entry, repo, { cli = DEFAULT_CLI, exec = execFileSync } = {}) {
  const key = laneKey(entry.id);
  const output = exec("qol", [
    "sessions", "fork",
    "--tool", LANE.tool,
    "--model", LANE.model,
    "--effort", LANE.effort,
    "--cwd", repo,
    "--key", key,
    "--no-chat",
    "--brief", laneBrief(entry, cli),
  ], { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    return JSON.parse(output)?.key || key;
  } catch {
    return key;
  }
}

function fresh(id, pattern, at, extra) {
  return {
    id, pattern, kind: "slug", route: DEFAULT_ROUTE, repo_id: null, loops: [],
    first_seen: at, seen: 0, sources: [], status: "open", lane: null, reason: null, updated: at,
    ...extra,
  };
}

function noLane(error = null) {
  return { due: false, forked: false, handover: false, brief: null, error };
}

function missingRepo(route, cwd, explicit) {
  const noun = ROUTE_HOME[route] === "origin" ? "git repository" : "qol-skills clone";
  return explicit ? `--rules-repo ${explicit} is not a ${noun}` : `no ${noun} found from ${cwd}; pass --rules-repo <path>`;
}

function dispatch(entry, { cwd, explicit, cli }, deps) {
  const route = entry.route;
  const due = entry.status === "open" && !entry.lane && route !== "judge-revert"
    && (entry.kind !== "fingerprint" || entry.loops.length >= FINGERPRINT_LOOPS);
  if (!due) return noLane();
  const base = { ...noLane(), due: true };
  if (ROUTE_HOME[route] === null) return { ...base, brief: suggestionBrief(entry) };
  const repo = rulesRepo(cwd, { explicit, exec: deps.exec, exists: deps.exists, route });
  if (repo === null) return { ...base, error: missingRepo(route, cwd, explicit) };
  const handover = !deps.fork && !(deps.hasQol ?? (() => qolOnPath(deps.env ?? process.env)))();
  if (handover) return { ...base, handover: true, brief: `Open a session in ${repo} and give it this brief:\n${laneBrief(entry, cli)}` };
  try {
    entry.lane = (deps.fork ?? forkLane)(entry, repo, { cli, exec: deps.exec });
    return { ...base, forked: true };
  } catch (failure) {
    return { ...base, error: `qol sessions fork failed: ${String(failure.stderr || failure.message).trim().split("\n")[0]}` };
  }
}

function sighted(entry, { from, loop }) {
  entry.seen += 1;
  if (from && !entry.sources.includes(from)) entry.sources = [...entry.sources, from];
  const token = loop ?? from;
  if (token && !entry.loops.includes(token)) entry.loops = [...entry.loops, token];
}

function record({ id, pattern, extra, options }, deps) {
  const file = deps.file ?? ledgerFile(deps.env);
  const route = options.route || null;
  if (route !== null && !ROUTES.includes(route)) throw new Error(`unknown route ${route}; routes: ${ROUTES.join(", ")}`);
  return withLock(file, () => {
    const at = (deps.now ?? (() => new Date().toISOString()))();
    const prior = readSlips(file, deps.read).get(id);
    const entry = { ...fresh(id, pattern, at, extra), ...(prior ?? {}), updated: at };
    if (route) entry.route = route;
    if (options.repoId) entry.repo_id = options.repoId;
    if (options.infeasible || options.added) {
      entry.status = options.infeasible ? "infeasible" : "rule added";
      entry.reason = options.infeasible || null;
      writeSlip(file, entry, deps.append);
      return { entry, ...noLane() };
    }
    sighted(entry, options);
    const outcome = dispatch(entry, { cwd: options.cwd ?? process.cwd(), explicit: options.rulesRepo, cli: options.cli ?? DEFAULT_CLI }, deps);
    writeSlip(file, entry, deps.append);
    return { entry, ...outcome };
  }, deps);
}

export function recordSlip(pattern, options = {}, deps = {}) {
  return record({ id: slugOf(pattern), pattern, extra: {}, options }, deps);
}

export function recordFingerprint(input, deps = {}) {
  const { fingerprint, judge = null, rule = null, message = null, repoId = null } = input;
  if (!fingerprint) throw new TypeError("recordFingerprint needs a fingerprint");
  const id = repoId ? `fp-${repoId}-${fingerprint}` : `fp-${fingerprint}`;
  const pattern = message ?? `${judge} ${rule}`;
  const extra = { kind: "fingerprint", fingerprint, judge, rule, message };
  return record({ id, pattern, extra, options: input }, deps);
}

export function listSlips(deps = {}) {
  const file = deps.file ?? ledgerFile(deps.env);
  return [...readSlips(file, deps.read).values()].sort((a, b) => a.first_seen.localeCompare(b.first_seen) || a.id.localeCompare(b.id));
}

export function statusText(entry) {
  if (entry.status === "infeasible") return `infeasible: ${entry.reason}`;
  if (entry.status === "rule added") return entry.lane ? `rule added by ${entry.lane}` : "rule added";
  return entry.lane ? `open, lane ${entry.lane}` : "open, no lane";
}

export function renderSlip(result, prefix = "qac") {
  const { entry, forked, error, handover, brief } = result;
  const head = `${prefix} slip: ${JSON.stringify(entry.pattern)} ${statusText(entry)}, seen ${entry.seen}`;
  if (error) return `${head}; ${error}`;
  if (handover) return `${head}; qol is not on PATH, so no lane was forked. Hand this to a session:\n${brief}`;
  if (brief) return `${head}; no lane for ${entry.route ?? DEFAULT_ROUTE}:\n${brief}`;
  return forked ? `${head}; forked lane ${entry.lane} to add the rule` : head;
}

export function renderSlips(entries, prefix = "qac") {
  if (entries.length === 0) return `${prefix} slips: none recorded`;
  const lines = [`${prefix} slips: ${entries.length} patterns`];
  for (const entry of entries) {
    const source = entry.sources.at(-1);
    const route = entry.route && entry.route !== DEFAULT_ROUTE ? ` | ${entry.route}` : "";
    lines.push(`${entry.pattern} | ${statusText(entry)} | seen ${entry.seen}, first ${entry.first_seen.slice(0, 10)}${route}${source ? ` | ${source}` : ""}`);
  }
  return lines.join("\n");
}
