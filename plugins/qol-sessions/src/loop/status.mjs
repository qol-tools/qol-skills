import path from "node:path";
import {
  EXIT,
  LoopError,
  assertKey,
  commonDir,
  controlDir,
  loopDir,
  loopsRoot,
  readAttempts,
  readJson,
  readLoop,
  readQuestions,
  withDefaults,
} from "./paths.mjs";

function attemptRow(attempt) {
  return {
    name: attempt.name,
    n: attempt.n,
    index: attempt.index,
    gate: attempt.gate?.verdict ?? null,
    findings: (attempt.gate?.findings ?? []).length,
    tamper: (attempt.gate?.tamper ?? []).length,
    blame: attempt.verdict?.blame ?? null,
    lane: attempt.lane
      ? { surface: attempt.lane.surface ?? null, session: attempt.lane.session ?? null, exit: attempt.lane.exit ?? null, cost_usd: attempt.lane.cost_usd ?? null }
      : null,
  };
}

function costOf(attempts, control) {
  const spent = [...attempts.map((attempt) => attempt.lane?.cost_usd), control?.cost_usd].reduce((sum, value) => sum + (Number(value) || 0), 0);
  return Math.round(spent * 10000) / 10000;
}

function phaseOf(closed, questions, last) {
  if (closed) return "closed";
  if (questions.length > 0) return "question";
  if (!last) return "armed";
  if (last.verdict?.blame) return `verdict:${last.verdict.blame}`;
  if (last.gate) return `gate:${last.gate.verdict}`;
  return "running";
}

export function summarizeLoop(dir, deps) {
  const loop = readLoop(dir, deps);
  if (!loop) return null;
  const attempts = readAttempts(dir, deps);
  const closed = readJson(path.join(dir, "closed.json"), deps);
  const questions = readQuestions(dir, loop.implementers === 2 ? [1, 2] : [null], deps);
  const control = readJson(path.join(controlDir(dir), "lane.json"), deps);
  const baseline = readJson(path.join(dir, "baseline", "gate.json"), deps);
  return {
    key: loop.key,
    phase: phaseOf(closed, questions, attempts.at(-1)),
    outcome: closed?.outcome ?? null,
    surface: loop.surface,
    control: Boolean(loop.control),
    base: loop.base,
    implementers: loop.implementers,
    worktrees: loop.worktrees,
    baseline: baseline ? { verdict: baseline.verdict, findings: (baseline.findings ?? []).length } : null,
    attempts: attempts.map(attemptRow),
    questions,
    cost_usd: costOf(attempts, control),
    loop_dir: dir,
  };
}

export function statusLoop(key, options = {}, deps) {
  const d = withDefaults(deps);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const common = commonDir(cwd, d);
  if (key) {
    assertKey(key);
    const summary = summarizeLoop(loopDir(common, key), d);
    if (!summary) throw new LoopError(`no loop ${key} under ${loopsRoot(common)}`);
    return { exit: EXIT.ok, loop: summary };
  }
  let keys = [];
  try {
    keys = d.readdir(loopsRoot(common));
  } catch {
    keys = [];
  }
  const loops = keys
    .sort()
    .map((name) => summarizeLoop(path.join(loopsRoot(common), name), d))
    .filter((loop) => loop && (options.all || loop.phase !== "closed"));
  return { exit: EXIT.ok, loops };
}
