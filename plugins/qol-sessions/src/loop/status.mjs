import path from "node:path";
import {
  EXIT,
  LoopError,
  assertKey,
  commonDir,
  loopDir,
  loopsRoot,
  readAttempts,
  readJson,
  readLoop,
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

function phaseOf(closed, question, last) {
  if (closed) return "closed";
  if (question) return "question";
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
  const question = readJson(path.join(dir, "question.json"), deps);
  const baseline = readJson(path.join(dir, "baseline", "gate.json"), deps);
  return {
    key: loop.key,
    phase: phaseOf(closed, question, attempts.at(-1)),
    outcome: closed?.outcome ?? null,
    surface: loop.surface,
    control: Boolean(loop.control),
    base: loop.base,
    implementers: loop.implementers,
    worktrees: loop.worktrees,
    baseline: baseline ? { verdict: baseline.verdict, findings: (baseline.findings ?? []).length } : null,
    attempts: attempts.map(attemptRow),
    question,
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
  const loops = keys.sort().map((name) => summarizeLoop(path.join(loopsRoot(common), name), d)).filter(Boolean);
  return { exit: EXIT.ok, loops };
}
