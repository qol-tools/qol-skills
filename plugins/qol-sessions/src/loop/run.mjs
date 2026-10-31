import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  EXIT,
  LoopError,
  SURFACES,
  acquireLoopLock,
  attemptDir,
  commonDir,
  controlDir,
  isArmed,
  listAttempts,
  loopDir,
  questionFile,
  readJson,
  readLoop,
  withDefaults,
  writeJson,
} from "./paths.mjs";
import { fetchTraps, gateStale, runGate } from "./gate.mjs";
import { parseSpec } from "./spec.mjs";
import { buildBrief } from "./brief.mjs";
import { addWorktree } from "./worktree.mjs";
import { captureDiff } from "./diff.mjs";
import { compareImplementers } from "./probe.mjs";
import { CONTROL_INDEX, CONTROL_LANE, isControlLoop } from "./control.mjs";
import { detectLanes, pickSurface, runLane } from "./lanes/index.mjs";

const MAX_ATTEMPTS = 2;
const MAX_ATTEMPTS_AFTER_IMPL_VERDICT = 3;

const QAC_JUDGED = [0, 1, 5, 6];
const UNTRUSTED = /untrusted|not trusted|qac trust/i;

function reply(exit, result) {
  return { exit, result };
}

function usage(error, extra = {}) {
  return reply(EXIT.usage, { state: "usage", error, ...extra });
}

function resolveDeps(deps = {}) {
  const d = withDefaults(deps);
  return {
    ...d,
    runGate: d.runGate ?? runGate,
    fetchTraps: d.fetchTraps ?? fetchTraps,
    runLane: d.runLane ?? runLane,
    pickSurface: d.pickSurface ?? pickSurface,
    detectLanes: d.detectLanes ?? detectLanes,
    captureDiff: d.captureDiff ?? captureDiff,
    addWorktree: d.addWorktree ?? addWorktree,
    uuid: d.uuid ?? randomUUID,
  };
}

function slotsOf(loop) {
  const two = loop.implementers === 2;
  return (loop.worktrees ?? []).map((entry) => ({ index: entry.index, slot: two ? entry.index : null, path: entry.path, branch: entry.branch }));
}

function attemptsFor(c, slot) {
  return listAttempts(c.dir, c.d)
    .filter((entry) => (entry.index ?? null) === slot.slot)
    .sort((a, b) => a.n - b.n);
}

function excludedBy(verdict) {
  return verdict?.blame === "judge" && verdict.fingerprint && verdict.file ? { fingerprint: verdict.fingerprint, file: verdict.file } : null;
}

function gateFindings(gate, excluded = null) {
  const found = (gate?.findings ?? [])
    .filter((finding) => !finding.baseline && !(excluded && finding.fingerprint === excluded.fingerprint && finding.file === excluded.file))
    .map((finding) => ({ id: finding.id, judge: finding.judge, rule: finding.rule, file: finding.file, line: finding.line, message: finding.message }));
  const tamper = (gate?.tamper ?? []).map((entry) => ({ id: entry.id, judge: "tamper", rule: entry.kind, file: entry.file, message: entry.detail }));
  return [...found, ...tamper];
}

function previousOf(c, slot, n) {
  const previous = attemptsFor(c, slot).find((entry) => entry.n === n - 1);
  if (!previous) return { findings: [], verdict: null };
  const gate = readJson(path.join(previous.dir, "gate.json"), c.d);
  const verdict = readJson(path.join(previous.dir, "verdict.json"), c.d);
  const findings = gate?.verdict === "findings" ? gateFindings(gate, excludedBy(verdict)) : [];
  return { findings, verdict: verdict?.blame === "impl" ? verdict : null };
}

function sessionFor(c, slot, n) {
  const earlier = attemptsFor(c, slot).filter((entry) => entry.n <= n).reverse();
  for (const entry of earlier) {
    const lane = readJson(path.join(entry.dir, "lane.json"), c.d);
    if (lane && lane.exit === 0 && lane.session && lane.surface === c.surface) return lane.session;
  }
  return null;
}

function answerFor(c, slot, n) {
  const question = c.questions.get(slot.slot);
  if (!c.opts.answer || !question || c.answerSlot !== slot.slot) return null;
  return question.attempt === n ? c.opts.answer : null;
}

function classify(res) {
  const gate = res?.gate ?? null;
  if (res?.exit === EXIT.needsTrust) return { kind: "trust", reason: "the gate reported untrusted argv" };
  if (!QAC_JUDGED.includes(res?.exit) || !gate) {
    const detail = String(res?.stderr ?? "").trim() || res?.error || `qac gate exited ${res?.exit}`;
    return { kind: "infra", reason: detail };
  }
  if (gate.verdict === "clean") return res.exit === 0 ? { kind: "green" } : { kind: "infra", reason: `gate verdict clean but qac exited ${res.exit}` };
  if (gate.verdict === "findings") return { kind: "red" };
  if (gate.verdict === "flaky_only") return { kind: "infra", reason: "flaky judge" };
  if (gate.verdict === "could_not_judge") {
    const reason = gate.reason ?? "could not judge";
    return UNTRUSTED.test(reason) ? { kind: "trust", reason } : { kind: "infra", reason };
  }
  return { kind: "infra", reason: `unknown gate verdict ${gate.verdict}` };
}

function staleReason(c, slot, gate, n) {
  try {
    return gateStale(gate, { loop: c.key, attempt: n, base: c.loop.base, cwd: slot.path }, c.d);
  } catch (error) {
    return error.message;
  }
}

function nextStep(c, slot) {
  const last = attemptsFor(c, slot).at(-1);
  if (!last) return { step: "attempt", n: 1 };
  const gate = readJson(path.join(last.dir, "gate.json"), c.d);
  if (!gate || (gate.verdict !== "clean" && gate.verdict !== "findings")) return { step: "attempt", n: last.n };
  if (gate.verdict === "clean") {
    return staleReason(c, slot, gate, last.n) === null ? { step: "green", n: last.n, gate } : { step: "attempt", n: last.n };
  }
  const verdict = readJson(path.join(last.dir, "verdict.json"), c.d);
  if (verdict?.blame === "spec") return { step: "spec", n: last.n, verdict };
  if (excludedBy(verdict) && !c.d.exists(path.join(last.dir, "regate.json"))) {
    return { step: "attempt", n: last.n };
  }
  const limit = verdict?.blame === "impl" ? MAX_ATTEMPTS_AFTER_IMPL_VERDICT : MAX_ATTEMPTS;
  if (last.n < limit) return { step: "attempt", n: last.n + 1 };
  return { step: "escalate", n: last.n, gate };
}

async function laneStep(c, slot, n, dir) {
  const previous = previousOf(c, slot, n);
  const answer = answerFor(c, slot, n);
  const brief = buildBrief({ spec: c.spec, traps: c.traps, findings: previous.findings, verdict: previous.verdict, answer });
  c.d.write(path.join(dir, "brief.md"), brief);
  const session = sessionFor(c, slot, n);
  let lane;
  try {
    lane = await c.d.runLane(
      {
        surface: c.surface,
        key: c.key,
        index: slot.slot,
        cwd: slot.path,
        brief,
        lane: c.loop.lane,
        budget: c.loop.budget_usd,
        attempt: n,
        sessionId: session ?? c.d.uuid(),
        resume: session !== null,
        answer,
      },
      c.d,
    );
  } catch (error) {
    lane = { exit: 1, text: "", session: null, cost_usd: null, question: null, error: error.message };
  }
  if (answer) c.d.remove(questionFile(c.dir, slot.slot));
  const text = String(lane.text ?? "");
  const missing = lane.exit === 0 && !lane.question && text.trim() === "";
  const exit = missing ? 1 : lane.exit;
  writeJson(
    path.join(dir, "lane.json"),
    {
      surface: c.surface,
      session: lane.session ?? null,
      exit,
      cost_usd: lane.cost_usd ?? null,
      question: lane.question ?? null,
      completion_marker: lane.completion_marker ?? null,
      ...(lane.error ? { error: lane.error } : {}),
    },
    c.d,
  );
  if (lane.exit === EXIT.handover) return { kind: "handover", brief: path.join(dir, "brief.md") };
  if (lane.question) {
    writeJson(
      questionFile(c.dir, slot.slot),
      {
        schema: 1,
        key: c.key,
        attempt: n,
        slot: slot.slot,
        index: slot.index,
        question: lane.question,
        session: lane.session ?? null,
        at: c.d.now().toISOString(),
      },
      c.d,
    );
    return { kind: "question", question: lane.question };
  }
  if (exit !== 0) return { kind: "infra", reason: lane.error ?? (missing ? "the lane returned no result" : `the lane exited ${exit}`) };
  return null;
}

function gateOptions(c, cwd, out, attempt, excludeFindings) {
  const baseline = path.join(c.dir, "baseline", "gate.json");
  const accept = path.join(c.dir, "accept.json");
  const owned = path.join(c.dir, "owned.json");
  const spec = path.join(c.dir, "spec.md");
  return {
    cwd,
    base: c.loop.base,
    out,
    accept,
    acceptFile: accept,
    owned,
    ownedFile: owned,
    spec,
    specPath: spec,
    specSha: c.loop.spec_sha,
    baseline: c.d.exists(baseline) ? baseline : undefined,
    excludeFindings,
    loop: c.key,
    attempt,
  };
}

async function attempt(c, slot, n) {
  const dir = attemptDir(c.dir, n, slot.slot);
  const base = { slot, n, dir };
  if (!c.d.exists(slot.path)) return { ...base, kind: "infra", reason: `worktree ${slot.path} is missing` };
  const laneFile = path.join(dir, "lane.json");
  const prior = readJson(laneFile, c.d);
  const laneDone = Boolean(prior) && prior.exit === 0 && !prior.question && !prior.empty_diff;
  if (!c.gateOnly && !laneDone) {
    const stopped = await laneStep(c, slot, n, dir);
    if (stopped) return { ...base, ...stopped };
  }
  const diff = String(await c.d.captureDiff(slot.path, c.loop.base, c.d));
  c.d.write(path.join(dir, "diff.patch"), diff);
  if (diff.trim() === "") {
    const lane = readJson(laneFile, c.d);
    if (lane && !c.gateOnly) writeJson(laneFile, { ...lane, empty_diff: true }, c.d);
    return { ...base, kind: "infra", reason: "empty diff: the worktree holds no change against the base" };
  }
  const verdict = readJson(path.join(dir, "verdict.json"), c.d);
  const excluded = excludedBy(verdict);
  const excludes = excluded ? [excluded] : [];
  let res;
  try {
    res = await c.d.runGate(gateOptions(c, slot.path, dir, n, excludes), c.d);
  } catch (error) {
    return { ...base, kind: "infra", reason: error.message };
  }
  if (res?.gate) writeJson(path.join(dir, "gate.json"), res.gate, c.d);
  const verdictKind = classify(res);
  if (excluded && (verdictKind.kind === "green" || verdictKind.kind === "red")) {
    writeJson(path.join(dir, "regate.json"), { ...excluded, finding: verdict.finding ?? null, at: c.d.now().toISOString() }, c.d);
  }
  return { ...base, ...verdictKind, gate: res?.gate ?? null };
}

async function runSlot(c, slot) {
  const pending = c.questions.get(slot.slot);
  if (pending && c.answerSlot !== slot.slot) {
    return { slot, n: pending.attempt, dir: attemptDir(c.dir, pending.attempt, slot.slot), kind: "question", question: pending.question };
  }
  for (;;) {
    const step = nextStep(c, slot);
    const base = { slot, n: step.n, dir: attemptDir(c.dir, step.n, slot.slot) };
    if (step.step === "green") return { ...base, kind: "green", gate: step.gate };
    if (step.step === "spec") return { ...base, kind: "spec", verdict: step.verdict };
    if (step.step === "escalate") return { ...base, kind: "red", gate: step.gate };
    const result = await attempt(c, slot, step.n);
    if (result.kind !== "red") return result;
  }
}

async function gateOnlySlot(c, slot) {
  const n = attemptsFor(c, slot).at(-1)?.n ?? 1;
  const result = await attempt(c, slot, n);
  if (result.kind !== "red" || n >= MAX_ATTEMPTS) return result;
  const previous = previousOf(c, slot, n + 1);
  const brief = path.join(attemptDir(c.dir, n + 1, slot.slot), "brief.md");
  c.d.write(brief, buildBrief({ spec: c.spec, traps: c.traps, findings: previous.findings, verdict: previous.verdict, answer: null }));
  return { ...result, kind: "retry", brief, retryAttempt: n + 1 };
}

function controlFinished(c) {
  const lane = readJson(path.join(controlDir(c.dir), "lane.json"), c.d);
  return lane !== null && lane.exit !== null && lane.exit !== undefined;
}

async function runControl(c) {
  const dir = controlDir(c.dir);
  const laneFile = path.join(dir, "lane.json");
  try {
    const worktree = await c.d.addWorktree({ repoRoot: c.loop.repo_root, key: c.key, index: CONTROL_INDEX, base: c.loop.base }, c.d);
    const record = { surface: "headless", worktree: { path: worktree.path, branch: worktree.branch }, exit: null };
    writeJson(laneFile, record, c.d);
    const brief = buildBrief({ spec: c.spec, traps: c.traps });
    c.d.write(path.join(dir, "brief.md"), brief);
    const lane = await c.d.runLane(
      {
        surface: "headless",
        key: c.key,
        index: CONTROL_INDEX,
        cwd: worktree.path,
        brief,
        lane: CONTROL_LANE,
        budget: c.loop.budget_usd,
        attempt: 1,
        sessionId: c.d.uuid(),
        resume: false,
      },
      c.d,
    );
    writeJson(laneFile, { ...record, session: lane.session ?? null, exit: lane.exit, cost_usd: lane.cost_usd ?? null, question: lane.question ?? null }, c.d);
    if (lane.exit !== 0) return { state: "lane_failed", exit: lane.exit, cost_usd: lane.cost_usd ?? null };
    const diff = String(await c.d.captureDiff(worktree.path, c.loop.base, c.d));
    c.d.write(path.join(dir, "diff.patch"), diff);
    if (diff.trim() === "") return { state: "empty_diff", cost_usd: lane.cost_usd ?? null };
    const res = await c.d.runGate(gateOptions(c, worktree.path, dir, 1, []), c.d);
    if (res?.gate) writeJson(path.join(dir, "gate.json"), res.gate, c.d);
    return { state: "gated", verdict: res?.gate?.verdict ?? null, cost_usd: lane.cost_usd ?? null, worktree: worktree.path };
  } catch (error) {
    return { state: "error", error: error.message };
  }
}

function summarize(c, outcome) {
  const gateFile = path.join(outcome.dir, "gate.json");
  return {
    index: outcome.slot.index,
    attempt: outcome.n,
    state: outcome.kind,
    worktree: outcome.slot.path,
    branch: outcome.slot.branch,
    dir: outcome.dir,
    gate: c.d.exists(gateFile) ? gateFile : null,
    verdict: outcome.gate?.verdict ?? null,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  };
}

function escalationPacket(c, outcomes) {
  const attempts = outcomes.flatMap((outcome) =>
    attemptsFor(c, outcome.slot).map((entry) => {
      const file = (name) => (c.d.exists(path.join(entry.dir, name)) ? path.join(entry.dir, name) : null);
      return { index: outcome.slot.index, attempt: entry.n, brief: file("brief.md"), diff: file("diff.patch"), gate: file("gate.json"), lane: file("lane.json") };
    }),
  );
  return {
    spec: path.join(c.dir, "spec.md"),
    diffs: attempts.map((entry) => entry.diff).filter(Boolean),
    gates: attempts.map((entry) => entry.gate).filter(Boolean),
    attempts,
    worktrees: outcomes.map((outcome) => outcome.slot.path),
  };
}

function probeOf(c, outcomes) {
  if (outcomes.length < 2 || outcomes.some((outcome) => !outcome.gate)) return { ambiguous: false, reasons: [] };
  const diffs = outcomes.map((outcome) => {
    try {
      return c.d.read(path.join(outcome.dir, "diff.patch"));
    } catch {
      return "";
    }
  });
  return compareImplementers(outcomes.map((outcome) => outcome.gate), diffs);
}

function questionRow(outcome) {
  return { index: outcome.slot.index, slot: outcome.slot.slot, attempt: outcome.n, question: outcome.question };
}

function finalize(c, outcomes, control) {
  const base = { key: c.key, slots: outcomes.map((outcome) => summarize(c, outcome)), ...(control ? { control } : {}) };
  const first = (kind) => outcomes.find((outcome) => outcome.kind === kind);
  const spec = first("spec");
  if (spec) {
    return usage(`the verdict blames the spec: the loop is done, fix the spec and open ${c.key}-v2`, { ...base, state: "spec_blamed", next: `${c.key}-v2` });
  }
  const question = first("question");
  if (question) {
    const questions = outcomes.filter((outcome) => outcome.kind === "question").map(questionRow);
    return reply(EXIT.question, { ...base, state: "question", question: question.question, attempt: question.n, index: question.slot.index, questions });
  }
  const trust = first("trust");
  if (trust) return reply(EXIT.needsTrust, { ...base, state: "needs_trust", reason: trust.reason, attempt: trust.n, index: trust.slot.index });
  const infra = first("infra");
  if (infra) return reply(EXIT.infra, { ...base, state: "infra", reason: infra.reason, attempt: infra.n, index: infra.slot.index });
  const handover = outcomes.filter((outcome) => outcome.kind === "handover");
  if (handover.length > 0) {
    return reply(EXIT.handover, {
      ...base,
      state: "handover",
      briefs: handover.map((outcome) => outcome.brief),
      worktrees: handover.map((outcome) => outcome.slot.path),
      next: `qols loop run ${c.key} --gate-only`,
    });
  }
  const retries = outcomes.filter((outcome) => outcome.kind === "retry");
  const probe = probeOf(c, outcomes);
  if (probe.ambiguous && retries.length === 0) {
    return reply(EXIT.escalation, { ...base, state: "escalation", ...escalationPacket(c, outcomes), ambiguous: true, reasons: probe.reasons });
  }
  const greens = outcomes.filter((outcome) => outcome.kind === "green");
  if (greens.length > 0) {
    return reply(EXIT.ok, { ...base, state: "green", green: greens.map((outcome) => outcome.slot.index), ambiguous: false, reasons: [] });
  }
  if (retries.length > 0) {
    return reply(EXIT.handover, {
      ...base,
      state: "red",
      attempt: 2,
      reason: "the gate is red after attempt 1: hand over attempt 2 with the retry brief, then run --gate-only again",
      briefs: retries.map((outcome) => outcome.brief),
      worktrees: retries.map((outcome) => outcome.slot.path),
      next: `qols loop run ${c.key} --gate-only`,
    });
  }
  const reds = outcomes.filter((outcome) => outcome.kind === "red");
  return reply(EXIT.escalation, { ...base, state: "escalation", ...escalationPacket(c, reds), ambiguous: probe.ambiguous, reasons: probe.reasons });
}

function load(key, opts, deps) {
  const d = resolveDeps(deps);
  const cwd = path.resolve(opts.cwd ?? process.cwd());
  const dir = loopDir(commonDir(cwd, d), key);
  const loop = readLoop(dir, d);
  if (!loop) return { early: usage(`no loop ${key} under ${dir}: run qols loop open first`) };
  const release = acquireLoopLock(dir, d);
  try {
    const slots = slotsOf(loop);
    const refusal = refuse(key, dir, slots, d);
    if (refusal) {
      release();
      return { early: refusal };
    }
    const specPath = path.join(dir, "spec.md");
    const parsed = parseSpec(d.read(specPath));
    const spec = {
      front: { lane: loop.lane, owned: loop.owned ?? [], accept: loop.accept ?? [], implementers: loop.implementers ?? 1, budget_usd: loop.budget_usd ?? undefined },
      body: parsed.body,
      path: specPath,
    };
    const questions = new Map();
    for (const slot of slots) {
      const question = readJson(questionFile(dir, slot.slot), d);
      if (question) questions.set(slot.slot, question);
    }
    const c = {
      d,
      key,
      dir,
      cwd,
      loop,
      slots,
      spec,
      opts,
      gateOnly: Boolean(opts.gateOnly),
      surface: null,
      traps: [],
      questions,
      answerSlot: undefined,
      fresh: listAttempts(dir, d).length === 0,
    };
    return { c, release };
  } catch (error) {
    release();
    throw error;
  }
}

function refuse(key, dir, slots, d) {
  if (d.exists(path.join(dir, "closed.json"))) return usage(`loop ${key} is closed`);
  if (!isArmed(dir, d)) return usage(`loop ${key} is not armed: rerun qols loop open ${key} --spec FILE until it prints loop_armed true`);
  if (slots.length === 0) return usage(`loop ${key} has no implementer worktrees`);
  return null;
}

function answerTarget(c) {
  const two = c.loop.implementers === 2;
  const wanted = c.opts.index === undefined || c.opts.index === null ? null : Number(c.opts.index);
  if (two && wanted !== 1 && wanted !== 2) {
    return { early: usage(`loop ${c.key} has 2 implementers: pass --index 1 or --index 2 to say which lane the answer is for`) };
  }
  if (!two && wanted !== null && wanted !== 1) return { early: usage(`loop ${c.key} has one implementer: --index must be 1 or omitted`) };
  const slot = two ? wanted : null;
  if (!c.questions.has(slot)) return { early: usage(`loop ${c.key} has no open question${two ? ` for implementer ${slot}` : ""} to answer`) };
  return { slot };
}

function pendingQuestions(c) {
  const all = c.slots.map((slot) => c.questions.get(slot.slot)).filter(Boolean);
  const rows = all.map(({ index, slot, attempt, question }) => ({ index, slot, attempt, question }));
  return reply(EXIT.question, { state: "question", key: c.key, question: rows[0].question, attempt: rows[0].attempt, index: rows[0].index, questions: rows });
}

function controlWanted(c) {
  return (
    !c.gateOnly &&
    !c.opts.answer &&
    c.fresh &&
    isControlLoop(c.key, c.d.env) &&
    Number(c.loop.budget_usd) > 0 &&
    Boolean(c.d.detectLanes(c.d).headless) &&
    !controlFinished(c)
  );
}

async function runLocked(c) {
  if (!c.gateOnly) {
    if (c.opts.answer) {
      const target = answerTarget(c);
      if (target.early) return target.early;
      c.answerSlot = target.slot;
    } else if (c.questions.size > 0) {
      return pendingQuestions(c);
    }
    c.surface = c.d.pickSurface({ force: c.opts.surface ?? null }, c.d);
    if (c.surface === "headless" && !(Number(c.loop.budget_usd) > 0)) return usage("headless lanes need budget_usd in the spec");
    try {
      c.traps = (await c.d.fetchTraps(c.cwd, c.d)) ?? [];
    } catch {
      c.traps = [];
    }
  }
  const control = controlWanted(c) ? runControl(c) : Promise.resolve(null);
  const [outcomes, controlResult] = await Promise.all([
    Promise.all(c.slots.map((slot) => (c.gateOnly ? gateOnlySlot(c, slot) : runSlot(c, slot)))),
    control,
  ]);
  return finalize(c, outcomes, controlResult);
}

export async function runLoop(key, opts = {}, deps = {}) {
  if (opts.surface && !SURFACES.includes(opts.surface)) return usage(`unknown surface ${opts.surface}: use ${SURFACES.join(", ")}`);
  let release = null;
  try {
    const loaded = load(key, opts, deps);
    if (loaded.early) return loaded.early;
    release = loaded.release;
    return await runLocked(loaded.c);
  } catch (error) {
    if (error instanceof LoopError) return reply(error.exit, { state: "error", error: error.message });
    return reply(EXIT.infra, { state: "infra", reason: error.message });
  } finally {
    if (release) release();
  }
}
