import path from "node:path";
import { appendRetro, retroLine } from "./retro.mjs";
import {
  EXIT,
  LoopError,
  assertKey,
  commonDir,
  deleteBranch,
  findOnPath,
  loopDir,
  readAttempts,
  readJson,
  readLoop,
  removeWorktree,
  withDefaults,
  writeJson,
} from "./paths.mjs";

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

function removeOthers(loop, kept, d) {
  const targets = loop.worktrees
    .filter((entry) => entry.index !== kept.worktree.index)
    .map((entry) => ({ path: entry.path, branch: entry.branch }));
  for (const target of targets) {
    removeWorktree(loop.repo_root, target.path, d);
    deleteBranch(loop.repo_root, target.branch, d);
  }
  return targets;
}

export function closeLoop(key, options = {}, deps) {
  const d = withDefaults(deps);
  assertKey(key);
  if (!OUTCOMES.includes(options.outcome)) throw new LoopError(`--outcome must be ${OUTCOMES.join(" or ")}`);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const dir = loopDir(commonDir(cwd, d), key);
  const loop = readLoop(dir, d);
  if (!loop) throw new LoopError(`no open loop ${key} under ${dir}`);
  const prior = readJson(path.join(dir, "closed.json"), d);
  if (prior?.receipt) return { exit: EXIT.ok, ...prior.receipt };
  if (!Array.isArray(loop.worktrees) || loop.worktrees.length === 0) throw new LoopError(`loop ${key} has no worktrees`, EXIT.infra);
  const attempts = readAttempts(dir, d);
  const kept = pickKept(loop, attempts, options.keep);
  const gate = gateSummary(kept.attempt);
  if (options.outcome === "accepted" && gate.verdict !== "clean") {
    throw new LoopError(`cannot accept loop ${key}: the gate for implementer ${kept.worktree.index} is ${gate.verdict}, not clean`);
  }
  const rounds = new Set(attempts.map((attempt) => attempt.n)).size;
  const remaining = options.remaining ?? (options.outcome === "accepted" ? "None." : `Paused; resume in ${kept.worktree.path}.`);
  const text = narrative(loop, kept, gate, rounds, remaining);
  const laneCloses = closeLanes(loop, attempts, kept, options.outcome, text, d);
  const now = d.now();
  let retro;
  try {
    retro = { file: appendRetro(retroLine({ loop, attempts, outcome: options.outcome, now }), d) };
  } catch (error) {
    retro = { error: error.message };
  }
  const removed = removeOthers(loop, kept, d);
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
  writeJson(
    path.join(dir, "closed.json"),
    { schema: 1, key, outcome: options.outcome, closed_at: now.toISOString(), kept: kept.worktree, removed, receipt },
    d,
  );
  return { exit: EXIT.ok, ...receipt };
}
