import os from "node:os";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { EXIT, LoopError, findOnPath, readJson, withDefaults } from "./paths.mjs";

export const QAC_EXIT = Object.freeze({ clean: 0, findings: 1, usage: 2, notRepo: 3, forkFailed: 4, couldNotJudge: 5, flakyOnly: 6 });

function listNames(dir, d) {
  try {
    return d.readdir(dir);
  } catch {
    return [];
  }
}

function mtimeOf(file, d) {
  try {
    return d.stat(file).mtimeMs ?? 0;
  } catch {
    return 0;
  }
}

export function resolveQac(deps) {
  const d = withDefaults(deps);
  const onPath = findOnPath("qac", d);
  if (onPath) return { argv: [onPath], source: "path" };
  const home = d.env.HOME ?? os.homedir();
  const cache = path.join(home, ".claude", "plugins", "cache");
  const scripts = [];
  for (const market of listNames(cache, d)) {
    const plugin = path.join(cache, market, "qol-project");
    for (const version of listNames(plugin, d)) {
      const script = path.join(plugin, version, "scripts", "qac.mjs");
      if (d.exists(script)) scripts.push({ script, version, mtime: mtimeOf(script, d) });
    }
  }
  scripts.sort((a, b) => b.mtime - a.mtime || b.version.localeCompare(a.version, undefined, { numeric: true }));
  if (scripts.length === 0) return null;
  return { argv: [d.execPath, scripts[0].script], source: "cache" };
}

export function requireQac(deps) {
  const qac = resolveQac(deps);
  if (!qac) throw new LoopError("qac not found: install the qol-project plugin or put qac on PATH", EXIT.infra);
  return qac;
}

export function gateArgs(qac, options) {
  const args = [...qac.argv, "gate", "--cwd", options.cwd, "--out", options.out];
  const pairs = [
    ["--base", options.base],
    ["--accept", options.accept],
    ["--owned", options.owned],
    ["--spec", options.spec],
    ["--spec-sha", options.specSha],
    ["--baseline", options.baseline],
    ["--loop", options.loop],
  ];
  for (const [flag, value] of pairs) {
    if (value !== undefined && value !== null && value !== "") args.push(flag, String(value));
  }
  for (const entry of options.excludeFindings ?? []) args.push("--exclude-finding", `${entry.fingerprint}=${entry.file}`);
  if (options.attempt !== undefined && options.attempt !== null) args.push("--attempt", String(options.attempt));
  if (options.keep) args.push("--keep");
  return args;
}

export function runGate(options, deps) {
  const d = withDefaults(deps);
  if (!options?.cwd || !options?.out) throw new LoopError("runGate needs cwd and out");
  const qac = requireQac(d);
  const result = d.exec(gateArgs(qac, options), { cwd: options.cwd, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) });
  const gate = readJson(path.join(options.out, "gate.json"), d);
  return {
    exit: result.status === null || result.status === undefined ? -1 : result.status,
    gate,
    stderr: String(result.stderr ?? ""),
    error: result.error ?? null,
  };
}

function treeFail(cwd, args, result) {
  const detail = String(result.stderr ?? "").trim() || result.error || `exit ${result.status}`;
  return new Error(`git ${args[0]} failed in ${cwd}: ${detail}`);
}

export function worktreeTree(cwd, deps) {
  const d = withDefaults(deps);
  const temp = (d.mkdtemp ?? mkdtempSync)(path.join(os.tmpdir(), "qols-tree-"));
  const env = { ...d.env, GIT_INDEX_FILE: path.join(temp, "index") };
  try {
    for (const args of [["read-tree", "HEAD"], ["add", "-A"]]) {
      const result = d.exec(["git", ...args], { cwd, env });
      if (result.status !== 0) throw treeFail(cwd, args, result);
    }
    const written = d.exec(["git", "write-tree"], { cwd, env });
    if (written.status !== 0) throw treeFail(cwd, ["write-tree"], written);
    return String(written.stdout ?? "").trim();
  } finally {
    (d.rmdir ?? ((dir) => rmSync(dir, { recursive: true, force: true })))(temp);
  }
}

export function gateStale(gate, expected, deps) {
  const d = withDefaults(deps);
  const mismatched = [
    ["loop", expected.loop],
    ["attempt", expected.attempt],
    ["base", expected.base],
  ].find(([field, value]) => String(gate?.[field] ?? "") !== String(value ?? ""));
  if (mismatched) return `gate.json ${mismatched[0]} is ${JSON.stringify(gate?.[mismatched[0]] ?? null)}, not ${JSON.stringify(mismatched[1])}`;
  if (typeof gate.tree !== "string" || gate.tree === "") return "gate.json records no tree";
  const fresh = (d.worktreeTree ?? worktreeTree)(expected.cwd, d);
  return fresh === gate.tree ? null : `the worktree changed since the gate judged it (tree ${gate.tree.slice(0, 12)} then, ${String(fresh).slice(0, 12)} now)`;
}

export function gateFailure(run) {
  if (run.exit === QAC_EXIT.couldNotJudge || run.gate?.verdict === "could_not_judge") {
    return run.gate?.reason ?? (run.stderr.trim() || "could not judge");
  }
  if (run.exit < 0 || run.exit === QAC_EXIT.usage || run.exit === QAC_EXIT.notRepo || run.exit === QAC_EXIT.forkFailed) {
    return run.stderr.trim() || `qac gate exited ${run.exit}`;
  }
  if (!run.gate) return `qac gate exited ${run.exit} without writing gate.json`;
  return null;
}

export function qacTrust(options, deps) {
  const d = withDefaults(deps);
  const qac = requireQac(d);
  const args = [...qac.argv, "trust", "--cwd", options.cwd];
  if (options.accept) args.push("--accept", options.accept);
  const result = d.exec(args, { cwd: options.cwd });
  let untrusted = null;
  try {
    const parsed = JSON.parse(result.stdout);
    if (Array.isArray(parsed?.untrusted)) untrusted = parsed.untrusted;
  } catch {
    untrusted = null;
  }
  return { trusted: result.status === 0, exit: result.status, untrusted, stderr: String(result.stderr ?? "") };
}

export function fetchTraps(cwd, deps) {
  const d = withDefaults(deps);
  const qac = resolveQac(d);
  if (!qac) return [];
  const result = d.exec([...qac.argv, "traps", "--cwd", cwd], { cwd });
  if (result.status !== 0) return [];
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed?.traps) ? parsed.traps : [];
  } catch {
    return [];
  }
}
