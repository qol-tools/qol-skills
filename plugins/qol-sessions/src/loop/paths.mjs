import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const EXIT = Object.freeze({ ok: 0, usage: 2, infra: 10, needsTrust: 11, escalation: 12, question: 13, handover: 14 });

export const KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const RESERVED_SUFFIX = /-(\d+|control)$/;

export class LoopError extends Error {
  constructor(message, exit = EXIT.usage, result = null) {
    super(message);
    this.name = "LoopError";
    this.exit = exit;
    this.result = result;
  }
}

export function assertKey(key) {
  if (typeof key !== "string" || !KEY_PATTERN.test(key)) {
    throw new LoopError(`invalid loop key ${JSON.stringify(key)}: use [a-z0-9][a-z0-9-]{0,63}`);
  }
  if (RESERVED_SUFFIX.test(key)) {
    throw new LoopError(`invalid loop key ${JSON.stringify(key)}: a key may not end in -<digits> or -control, those suffixes name implementer and control worktrees`);
  }
  return key;
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function defaultExec(argv, options = {}) {
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: options.cwd,
    env: options.env ?? process.env,
    input: options.input,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 0,
    maxBuffer: 256 * 1024 * 1024,
  });
  return {
    status: result.status,
    signal: result.signal ?? null,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    error: result.error ? result.error.code ?? result.error.message : null,
  };
}

function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text);
  fs.renameSync(temp, file);
}

export function withDefaults(deps = {}) {
  return {
    ...deps,
    exec: deps.exec ?? defaultExec,
    read: deps.read ?? ((file) => fs.readFileSync(file, "utf8")),
    write: deps.write ?? writeAtomic,
    exists: deps.exists ?? ((file) => fs.existsSync(file)),
    env: deps.env ?? process.env,
    now: deps.now ?? (() => new Date()),
    readdir: deps.readdir ?? ((dir) => fs.readdirSync(dir)),
    stat: deps.stat ?? ((file) => fs.statSync(file)),
    append: deps.append ?? ((file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, text);
    }),
    remove: deps.remove ?? ((target) => fs.rmSync(target, { recursive: true, force: true })),
    execPath: deps.execPath ?? process.execPath,
  };
}

export function findOnPath(name, deps) {
  const d = withDefaults(deps);
  for (const dir of String(d.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    if (d.exists(candidate)) return candidate;
  }
  return null;
}

export function commonDir(cwd, deps) {
  const d = withDefaults(deps);
  const result = d.exec(["git", "rev-parse", "--git-common-dir"], { cwd });
  const out = String(result.stdout ?? "").trim();
  if (result.status !== 0 || out === "") throw new LoopError(`${cwd} is not inside a git repository`);
  return path.resolve(cwd, out);
}

export function mainClone(common) {
  return path.dirname(common);
}

export function loopsRoot(common) {
  return path.join(common, "qol-sessions", "loops");
}

export function loopDir(common, key) {
  return path.join(loopsRoot(common), assertKey(key));
}

export function attemptDir(dir, n, index) {
  const suffix = index === undefined || index === null ? "" : `-${index}`;
  return path.join(dir, `attempt-${n}${suffix}`);
}

export function controlDir(dir) {
  return path.join(dir, "control");
}

export function listAttempts(dir, deps) {
  const d = withDefaults(deps);
  let names;
  try {
    names = d.readdir(dir);
  } catch {
    return [];
  }
  const found = [];
  for (const name of names) {
    const match = /^attempt-(\d+)(?:-(\d+))?$/.exec(String(name));
    if (!match) continue;
    found.push({ name: match[0], n: Number(match[1]), index: match[2] === undefined ? null : Number(match[2]), dir: path.join(dir, match[0]) });
  }
  found.sort((a, b) => a.n - b.n || (a.index ?? 0) - (b.index ?? 0));
  return found;
}

export function worktreePath(repoRoot, key, index) {
  assertKey(key);
  const suffix = index === undefined || index === null ? "" : `-${index}`;
  return path.join(path.dirname(repoRoot), "worktrees", `loop-${key}${suffix}`, path.basename(repoRoot));
}

export function worktreeBranch(key, index) {
  const suffix = index === undefined || index === null ? "" : `-${index}`;
  return `loop-${key}${suffix}`;
}

export function readJson(file, deps) {
  const d = withDefaults(deps);
  try {
    return JSON.parse(d.read(file));
  } catch {
    return null;
  }
}

export function writeJson(file, value, deps) {
  const d = withDefaults(deps);
  d.write(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

export function readLoop(dir, deps) {
  return readJson(path.join(dir, "loop.json"), deps);
}

export function writeLoop(dir, loop, deps) {
  return writeJson(path.join(dir, "loop.json"), loop, deps);
}

export function readAttempts(dir, deps) {
  return listAttempts(dir, deps).map((attempt) => ({
    ...attempt,
    gate: readJson(path.join(attempt.dir, "gate.json"), deps),
    lane: readJson(path.join(attempt.dir, "lane.json"), deps),
    verdict: readJson(path.join(attempt.dir, "verdict.json"), deps),
  }));
}

export function removeWorktree(repoRoot, dir, deps) {
  const d = withDefaults(deps);
  const removed = d.exec(["git", "worktree", "remove", "--force", "--force", dir], { cwd: repoRoot });
  if (removed.status !== 0) {
    d.remove(dir);
    d.exec(["git", "worktree", "prune"], { cwd: repoRoot });
  }
  return removed.status === 0;
}

export function deleteBranch(repoRoot, branch, deps) {
  const d = withDefaults(deps);
  return d.exec(["git", "branch", "-D", branch], { cwd: repoRoot }).status === 0;
}
