import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export const LANE = { tool: "claude", model: "opus", effort: "high" };
const KEY_SLUG_LIMIT = 40;
const QAC_SOURCE = path.join("plugins", "qol-project", "src", "qac.mjs");

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

export function rulesRepo(cwd, { explicit = null, exec = execFileSync, exists = existsSync } = {}) {
  const isClone = dir => exists(path.join(dir, QAC_SOURCE));
  if (explicit) return isClone(explicit) ? path.resolve(explicit) : null;
  let main;
  try {
    const common = exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    main = path.dirname(path.resolve(common));
  } catch {
    return null;
  }
  return [main, path.join(path.dirname(main), "qol-skills")].find(isClone) ?? null;
}

export function laneBrief(entry, cli) {
  const command = `node ${JSON.stringify(cli)} slip ${JSON.stringify(entry.pattern)}`;
  const sources = entry.sources.length ? entry.sources.join(", ") : "no source given";
  return [
    `qac slip: the pattern ${JSON.stringify(entry.pattern)} slipped past qac (first seen ${entry.first_seen}, from ${sources}).`,
    "Add the qac rule that catches it in plugins/qol-project of this repo: a filter in the owning bin/check-*.cjs hook, reachable through its lintFile so `qac lint` runs it, with fixtures and node:test tests for every branch, and the owning skill section updated.",
    "Load hook-design:incident-guards, qol-workflow:writing-skills-and-help, marketplace-publishing:marketplace-publishing and qol-workflow:commit first. qol-skills commits direct to main.",
    `When the rule is pushed, run: ${command} --added`,
    `If no deterministic rule can catch it, run: ${command} --infeasible "<reason>" and stop. The ledger never forks a lane for it again.`,
    "Report the outcome to the user in this terminal.",
  ].join("\n");
}

export function forkLane(entry, repo, { cli, exec = execFileSync } = {}) {
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
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  try {
    return JSON.parse(output)?.key || key;
  } catch {
    return key;
  }
}

function fresh(id, pattern, at) {
  return { id, pattern, first_seen: at, seen: 0, sources: [], status: "open", lane: null, reason: null, updated: at };
}

export function recordSlip(pattern, options = {}, deps = {}) {
  const file = deps.file ?? ledgerFile(deps.env);
  const at = (deps.now ?? (() => new Date().toISOString()))();
  const id = slugOf(pattern);
  const prior = readSlips(file, deps.read).get(id);
  const entry = { ...(prior ?? fresh(id, pattern, at)), updated: at };
  if (options.infeasible || options.added) {
    entry.status = options.infeasible ? "infeasible" : "rule added";
    entry.reason = options.infeasible || null;
    writeSlip(file, entry, deps.append);
    return { entry, forked: false, error: null };
  }
  entry.seen += 1;
  if (options.from && !entry.sources.includes(options.from)) entry.sources = [...entry.sources, options.from];
  let forked = false;
  let error = null;
  if (entry.status === "open" && !entry.lane) {
    const repo = rulesRepo(options.cwd ?? process.cwd(), { explicit: options.rulesRepo, exec: deps.exec, exists: deps.exists });
    if (repo === null) {
      error = options.rulesRepo
        ? `--rules-repo ${options.rulesRepo} is not a qol-skills clone`
        : `no qol-skills clone found from ${options.cwd ?? process.cwd()}; pass --rules-repo <path>`;
    } else {
      try {
        entry.lane = (deps.fork ?? forkLane)(entry, repo, { cli: options.cli, exec: deps.exec });
        forked = true;
      } catch (failure) {
        error = `qol sessions fork failed: ${String(failure.stderr || failure.message).trim().split("\n")[0]}`;
      }
    }
  }
  writeSlip(file, entry, deps.append);
  return { entry, forked, error };
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
  const { entry, forked, error } = result;
  const head = `${prefix} slip: ${JSON.stringify(entry.pattern)} ${statusText(entry)}, seen ${entry.seen}`;
  if (error) return `${head}; ${error}`;
  return forked ? `${head}; forked lane ${entry.lane} to add the rule` : head;
}

export function renderSlips(entries, prefix = "qac") {
  if (entries.length === 0) return `${prefix} slips: none recorded`;
  const lines = [`${prefix} slips: ${entries.length} patterns`];
  for (const entry of entries) {
    const source = entry.sources.at(-1);
    lines.push(`${entry.pattern} | ${statusText(entry)} | seen ${entry.seen}, first ${entry.first_seen.slice(0, 10)}${source ? ` | ${source}` : ""}`);
  }
  return lines.join("\n");
}
