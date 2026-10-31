import path from "node:path";
import { chooseSurface, detectLanes } from "./doctor.mjs";
import { gateFailure, qacTrust, runGate } from "./gate.mjs";
import {
  EXIT,
  LoopError,
  assertKey,
  commonDir,
  loopDir,
  mainClone,
  sha256,
  withDefaults,
  worktreeBranch,
  worktreePath,
  writeJson,
  writeLoop,
} from "./paths.mjs";
import { parseSpec, validateFront } from "./spec.mjs";
import { addWorktree } from "./worktree.mjs";

export function controlApplies(key, env, headless) {
  if (!headless || env.QOLS_CONTROL === "0") return false;
  return parseInt(sha256(key).slice(0, 8), 16) % 5 === 0;
}

function errorList(result) {
  if (Array.isArray(result)) return result.map(String);
  if (result && typeof result === "object" && Array.isArray(result.errors)) {
    return result.ok === false || result.errors.length > 0 ? result.errors.map(String) : [];
  }
  return [];
}

function readFront(text, d) {
  const parse = d.parseSpec ?? parseSpec;
  const validate = d.validateFront ?? validateFront;
  let parsed;
  try {
    parsed = parse(text);
  } catch (error) {
    throw new LoopError(`spec invalid: ${error.message}`);
  }
  const parseErrors = errorList(parsed);
  if (parseErrors.length > 0) throw new LoopError(`spec invalid: ${parseErrors.join("; ")}`);
  const front = parsed?.front ?? parsed?.spec ?? null;
  if (!front || typeof front !== "object") throw new LoopError("spec invalid: no loop block");
  const errors = errorList(validate(front));
  if (errors.length > 0) throw new LoopError(`spec invalid: ${errors.join("; ")}`);
  return front;
}

function resolveBase(cwd, base, d) {
  const result = d.exec(["git", "rev-parse", "--verify", `${base}^{commit}`], { cwd });
  const sha = String(result.stdout ?? "").trim();
  if (result.status !== 0 || sha === "") throw new LoopError(`cannot resolve base ${base}`);
  return sha;
}

function untrustedList(trust, accept) {
  if (Array.isArray(trust.untrusted) && trust.untrusted.length > 0) return trust.untrusted;
  return accept.map((entry) => ({ id: entry.id, argv: entry.argv }));
}

export function openLoop(key, options, deps) {
  const d = withDefaults(deps);
  assertKey(key);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  if (!options.spec) throw new LoopError("open needs --spec FILE");
  const specFile = path.resolve(cwd, options.spec);
  let specText;
  try {
    specText = d.read(specFile);
  } catch {
    throw new LoopError(`cannot read spec ${specFile}`);
  }
  const front = readFront(specText, d);
  const common = commonDir(cwd, d);
  const repoRoot = mainClone(common);
  const dir = loopDir(common, key);
  if (d.exists(path.join(dir, "baseline", "gate.json"))) throw new LoopError(`loop ${key} is already armed at ${dir}`);
  const base = resolveBase(cwd, options.base ?? "HEAD", d);
  const specSha = sha256(specText);
  const lanes = detectLanes(d);
  const surface = chooseSurface(lanes);
  const accept = front.accept ?? [];
  const owned = front.owned ?? [];
  const implementers = front.implementers ?? 1;
  const control = controlApplies(key, d.env, lanes.headless);
  d.write(path.join(dir, "spec.md"), specText);
  const acceptFile = writeJson(path.join(dir, "accept.json"), accept, d);
  const ownedFile = writeJson(path.join(dir, "owned.json"), owned, d);
  const worktrees = [];
  for (let index = 1; index <= implementers; index += 1) {
    const slot = implementers === 1 ? null : index;
    worktrees.push({ index, path: worktreePath(repoRoot, key, slot), branch: worktreeBranch(key, slot) });
  }
  const loop = {
    schema: 1,
    key,
    repo_root: repoRoot,
    base,
    spec_sha: specSha,
    lane: front.lane,
    owned,
    accept,
    implementers,
    budget_usd: front.budget_usd ?? null,
    worktrees,
    surface,
    control,
    created_at: d.now().toISOString(),
  };
  writeLoop(dir, loop, d);
  const trust = qacTrust({ cwd, accept: acceptFile }, d);
  if (!trust.trusted) {
    const untrusted = untrustedList(trust, accept);
    return {
      exit: EXIT.needsTrust,
      loop_armed: false,
      needs_trust: true,
      key,
      untrusted,
      approve: `qac trust approve --cwd ${cwd} --accept ${acceptFile}`,
    };
  }
  for (const worktree of worktrees) {
    if (d.exists(worktree.path)) continue;
    try {
      (d.addWorktree ?? addWorktree)(repoRoot, worktree.path, base, worktree.branch);
    } catch (error) {
      throw new LoopError(`cannot create worktree ${worktree.path}: ${error.message}`, EXIT.infra);
    }
  }
  const baselineOut = path.join(dir, "baseline");
  const run = runGate({ cwd: worktrees[0].path, base, out: baselineOut, loop: key }, d);
  const failure = gateFailure(run);
  if (failure) throw new LoopError(`baseline gate could not judge: ${failure}`, EXIT.infra);
  return {
    exit: EXIT.ok,
    loop_armed: true,
    key,
    loop_dir: dir,
    base,
    spec_sha: specSha,
    surface,
    control,
    implementers,
    worktrees,
    baseline: { verdict: run.gate.verdict, findings: (run.gate.findings ?? []).length },
  };
}
