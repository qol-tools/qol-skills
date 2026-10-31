import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

export const EXIT = Object.freeze({ ok: 0, usage: 2, infra: 10, needsTrust: 11, escalation: 12, question: 13, handover: 14 });

export const SURFACES = Object.freeze(["kitty", "headless", "handover"]);

export const KEY_PATTERN =/^[a-z0-9][a-z0-9-]{0,63}$/;

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

function defaultExec(argv, options = {}) {
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
  const extensions = (d.platform ?? process.platform) === "win32"
    ? String(d.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [];
  for (const dir of String(d.env.PATH ?? d.env.Path ?? "").split(path.delimiter)) {
    if (!dir) continue;
    const base = path.join(dir, name);
    for (const candidate of [...extensions.map((extension) => `${base}${extension}`), base]) {
      if (d.exists(candidate)) return candidate;
    }
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

export function questionFile(dir, slot) {
  return path.join(dir, slot === undefined || slot === null ? "question.json" : `question-${slot}.json`);
}

export function readQuestions(dir, slots, deps) {
  return slots
    .map((slot) => readJson(questionFile(dir, slot), deps))
    .filter(Boolean);
}

export function isArmed(dir, deps) {
  const baseline = readJson(path.join(dir, "baseline", "gate.json"), deps);
  return Boolean(baseline) && baseline.verdict !== "could_not_judge";
}

function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

function createExclusive(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { flag: "wx" });
}

export function acquireLoopLock(dir, deps) {
  const d = withDefaults(deps);
  const file = path.join(dir, "run.lock");
  const alive = d.pidAlive ?? processAlive;
  const pid = d.pid ?? process.pid;
  const body = `${JSON.stringify({ pid, at: d.now().toISOString() })}\n`;
  for (let tries = 0; tries < 3; tries += 1) {
    try {
      (d.createExclusive ?? createExclusive)(file, body);
      return () => {
        if (readJson(file, d)?.pid === pid) d.remove(file);
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const holder = Number(readJson(file, d)?.pid);
    if (Number.isInteger(holder) && holder > 0 && alive(holder)) {
      throw new LoopError(`loop ${path.basename(dir)} is already being run or closed by pid ${holder}`);
    }
    d.remove(file);
  }
  throw new LoopError(`cannot take the lock ${file}`, EXIT.infra);
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
