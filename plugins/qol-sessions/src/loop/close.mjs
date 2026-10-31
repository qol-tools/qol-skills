import path from "node:path";
import { gateStale } from "./gate.mjs";
import { appendRetro, retroLine } from "./retro.mjs";
import {
  EXIT,
  LoopError,
  acquireLoopLock,
  assertKey,
  controlDir,
  commonDir,
  deleteBranch,
  findOnPath,
  loopDir,
  readAttempts,
  readJson,
  readLoop,
  removeWorktree,
  withDefaults,
  worktreeBranch,
  worktreePath,
  writeJson,
} from "./paths.mjs";
import { CONTROL_INDEX } from "./control.mjs";

const OUTCOMES = ["accepted", "paused"];

function indexOf(loop, attempt) {
  return attempt.index ?? loop.worktrees[0]?.index ?? 1;
}

function pickKept(loop, attempts, keep) {
  if (keep !== undefined && keep !== null) {
    const worktree = loop.worktrees.find((entry) => entry.index === keep);
    if (!worktree) throw new LoopError(`--keep ${keep} is not an implementer of loop ${loop.key}`);
    const mine = attempts.filter((attempt) => indexOf(loop, attempt) === worktree.index);
    return { worktree, attempt: mine.at(-1) ?? null };
  }
  const green = attempts.filter((attempt) => attempt.gate?.verdict === "clean").at(-1);
  const attempt = green ?? attempts.at(-1) ?? null;
  const index = attempt ? indexOf(loop, attempt) : loop.worktrees[0]?.index;
  const worktree = loop.worktrees.find((entry) => entry.index === index) ?? loop.worktrees[0];
  return { worktree, attempt };
}

function gateSummary(attempt) {
  const gate = attempt?.gate;
  return {
    verdict: gate?.verdict ?? "none",
    attempt: attempt?.n ?? null,
    findings: (gate?.findings ?? []).length,
    tamper: (gate?.tamper ?? []).length,
  };
}

function narrative(loop, kept, gate, rounds, remaining) {
  const changed = (kept.attempt?.gate?.changed ?? []).length;
  return {
    landed: `${changed} changed file${changed === 1 ? "" : "s"} in ${kept.worktree.path} after ${rounds} attempt${rounds === 1 ? "" : "s"}`,
    before: `spec ${loop.spec_sha.slice(0, 12)} on base ${loop.base.slice(0, 12)}`,
    now: `branch ${kept.worktree.branch} holds the result`,
    verification: `qac gate ${gate.verdict}: ${gate.findings} findings, ${gate.tamper} tamper entries`,
    remaining,
  };
}

function laneSessions(attempts, keptAttempt) {
  const bySession = new Map();
  for (const attempt of attempts) {
    const lane = attempt.lane;
    if (lane?.surface === "kitty" && lane.session) bySession.set(lane.session, lane);
  }
  const keptSession = keptAttempt?.lane?.session;
  const sessions = [...bySession.keys()];
  if (keptSession && bySession.has(keptSession)) sessions.sort((a, b) => (a === keptSession ? -1 : b === keptSession ? 1 : 0));
  return sessions.map((session) => ({ session, lane: bySession.get(session) }));
}

function closeLanes(loop, attempts, kept, outcome, text, d) {
  const qol = findOnPath("qol", d) ?? "qol";
  return laneSessions(attempts, kept.attempt).map(({ session, lane }) => {
    if (!lane.completion_marker) return { session, skipped: "lane.json has no completion_marker" };
    const args = [
      qol,
      "sessions",
      "loop-close",
      session,
      "--completion-marker",
      lane.completion_marker,
      "--outcome",
      outcome,
      "--landed",
      text.landed,
      "--before",
      text.before,
      "--now",
      text.now,
      "--verification",
      text.verification,
      "--remaining",
      text.remaining,
    ];
    const result = d.exec(args, { cwd: loop.repo_root });
    return {
      session,
      exit: result.status,
      error: result.status === 0 ? null : String(result.stderr ?? "").trim() || `qol sessions loop-close exited ${result.status}`,
    };
  });
}

function controlOf(dir, loop, key, d) {
  const lane = readJson(path.join(controlDir(dir), "lane.json"), d);
  if (!lane) return { worktree: null, retro: null };
  const gate = readJson(path.join(controlDir(dir), "gate.json"), d);
  return {
    worktree: lane.worktree ? { path: worktreePath(loop.repo_root, key, CONTROL_INDEX), branch: worktreeBranch(key, CONTROL_INDEX) } : null,
    retro: { verdict: gate?.verdict ?? null, cost_usd: lane.cost_usd ?? null },
  };
}

function removeOthers(loop, kept, control, d) {
  const targets = [
    ...loop.worktrees.filter((entry) => entry.index !== kept.worktree.index).map((entry) => ({ path: entry.path, branch: entry.branch })),
    ...(control.worktree ? [control.worktree] : []),
  ];
  for (const target of targets) {
    removeWorktree(loop.repo_root, target.path, d);
    deleteBranch(loop.repo_root, target.branch, d);
  }
  return targets;
}

function assertFresh(key, loop, kept, d) {
  const stale = gateStale(kept.attempt.gate, { loop: key, attempt: kept.attempt.n, base: loop.base, cwd: kept.worktree.path }, d);
  if (stale) throw new LoopError(`cannot accept loop ${key}: ${stale}; run qols loop run ${key} to gate it again`);
}

function closeLocked(key, options, dir, loop, d) {
  const prior = readJson(path.join(dir, "closed.json"), d);
  if (prior?.receipt) {
    if (prior.outcome !== options.outcome) {
      throw new LoopError(`loop ${key} is already closed as ${prior.outcome}; a close cannot be repeated with outcome ${options.outcome}`);
    }
    return { exit: EXIT.ok, ...prior.receipt };
  }
  if (!Array.isArray(loop.worktrees) || loop.worktrees.length === 0) throw new LoopError(`loop ${key} has no worktrees`, EXIT.infra);
  const attempts = readAttempts(dir, d);
  const kept = pickKept(loop, attempts, options.keep);
  const gate = gateSummary(kept.attempt);
  if (options.outcome === "accepted") {
    if (gate.verdict !== "clean") {
      throw new LoopError(`cannot accept loop ${key}: the gate for implementer ${kept.worktree.index} is ${gate.verdict}, not clean`);
    }
    assertFresh(key, loop, kept, d);
  }
  const rounds = new Set(attempts.map((attempt) => attempt.n)).size;
  const remaining = options.remaining ?? (options.outcome === "accepted" ? "None." : `Paused; resume in ${kept.worktree.path}.`);
  const text = narrative(loop, kept, gate, rounds, remaining);
  const laneCloses = closeLanes(loop, attempts, kept, options.outcome, text, d);
  const now = d.now();
  const control = controlOf(dir, loop, key, d);
  let retro;
  try {
    retro = { file: appendRetro(retroLine({ loop, attempts, outcome: options.outcome, now, skillGap: options.skillGap, control: control.retro }), d) };
  } catch (error) {
    retro = { error: error.message };
  }
  const removed = options.outcome === "accepted" ? removeOthers(loop, kept, control, d) : [];
  const receipt = {
    loop_closed: true,
    final_report: {
      outcome: options.outcome,
      key,
      attempts: rounds,
      gate,
      remaining,
      worktree: kept.worktree.path,
    },
    lane_closes: laneCloses,
    removed,
    retro,
  };
  const keptAll = options.outcome === "accepted" ? [kept.worktree] : [...loop.worktrees, ...(control.worktree ? [control.worktree] : [])];
  writeJson(
    path.join(dir, "closed.json"),
    { schema: 1, key, outcome: options.outcome, closed_at: now.toISOString(), kept: kept.worktree, kept_all: keptAll, removed, receipt },
    d,
  );
  return { exit: EXIT.ok, ...receipt };
}

export function closeLoop(key, options = {}, deps) {
  const d = withDefaults(deps);
  assertKey(key);
  if (!OUTCOMES.includes(options.outcome)) throw new LoopError(`--outcome must be ${OUTCOMES.join(" or ")}`);
  if (options.skillGap !== undefined && String(options.skillGap).trim() === "") throw new LoopError("--skill-gap needs text");
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const dir = loopDir(commonDir(cwd, d), key);
  const loop = readLoop(dir, d);
  if (!loop) throw new LoopError(`no open loop ${key} under ${dir}`);
  const release = acquireLoopLock(dir, d);
  try {
    return closeLocked(key, options, dir, loop, d);
  } finally {
    release();
  }
}
