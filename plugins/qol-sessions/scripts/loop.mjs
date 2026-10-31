import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { closeLoop } from "../src/loop/close.mjs";
import { doctorLoop } from "../src/loop/doctor.mjs";
import { openLoop } from "../src/loop/open.mjs";
import { EXIT, LoopError } from "../src/loop/paths.mjs";
import { normalizeRetro } from "../src/loop/retro.mjs";
import { statusLoop } from "../src/loop/status.mjs";
import { recordVerdict } from "../src/loop/verdict.mjs";

export { EXIT };

const VERBS = {
  open: { usage: "open <key> --spec FILE [--base REV] [--cwd DIR]", about: "freeze the spec, check trust, create worktrees, run the baseline gate", positional: 1, strings: ["spec", "base", "cwd"], bools: [] },
  run: { usage: "run <key> [--answer TEXT] [--gate-only] [--surface kitty|headless|handover] [--cwd DIR]", about: "run attempt 1 and at most one retry, then gate; a red --gate-only after attempt 1 writes the retry brief and exits 14", positional: 1, strings: ["answer", "surface", "cwd"], bools: ["gate-only"] },
  verdict: { usage: "verdict <key> --blame spec|impl|judge --finding ID --hunk PATH:LINE --why TEXT [--index N] [--cwd DIR]", about: "record who is at fault for a red gate; --index 1|2 is required with 2 implementers", positional: 1, strings: ["blame", "finding", "hunk", "why", "index", "cwd"], bools: [] },
  close: { usage: "close <key> --outcome accepted|paused [--keep N] [--remaining TEXT] [--cwd DIR]", about: "close lanes, write the retro line, keep one worktree, print the receipt", positional: 1, strings: ["outcome", "keep", "remaining", "cwd"], bools: [] },
  status: { usage: "status [key] [--cwd DIR]", about: "show one loop or every loop of this repository", positional: 1, optional: true, strings: ["cwd"], bools: [] },
  doctor: { usage: "doctor [--prune] [--cwd DIR]", about: "check node, qol, lanes, qac, hooks, trust, mcp and the script root", positional: 0, strings: ["cwd"], bools: ["prune"] },
  retro: { usage: "retro --normalize", about: "one-time: back up the retro ledger, type its numbers, add schema 1", positional: 0, strings: [], bools: ["normalize"] },
};

const EXIT_ABOUT = [
  [EXIT.ok, "ok"],
  [EXIT.usage, "usage error"],
  [EXIT.infra, "infrastructure failure or could not judge"],
  [EXIT.needsTrust, "accept commands need qac trust approve"],
  [EXIT.escalation, "two red attempts, escalation packet printed"],
  [EXIT.question, "the lane asked a question"],
  [EXIT.handover, "handover: do the brief (or the retry brief after a first red --gate-only) by hand, then run --gate-only"],
];

export function helpText() {
  const width = Math.max(...Object.values(VERBS).map((verb) => verb.usage.length));
  return [
    "qols loop: drive one implementation loop through a deterministic gate.",
    "",
    "verbs:",
    ...Object.values(VERBS).map((verb) => `  ${verb.usage.padEnd(width)}  ${verb.about}`),
    "",
    "flags on every verb:",
    "  --pretty  print text instead of one JSON line",
    "  --help    print this text",
    "",
    "exit codes:",
    ...EXIT_ABOUT.map(([code, about]) => `  ${String(code).padEnd(2)}  ${about}`),
  ].join("\n");
}

export function parseArgs(argv) {
  const parsed = { verb: null, positionals: [], flags: {}, pretty: false, help: false, errors: [] };
  const rest = [...argv];
  while (rest.length > 0 && rest[0] !== "--") {
    const head = rest[0];
    if (head === "--pretty") parsed.pretty = true;
    else if (head === "--help" || head === "-h") parsed.help = true;
    else break;
    rest.shift();
  }
  const verb = rest.shift();
  if (verb === undefined) return parsed;
  if (verb === "--help" || verb === "-h" || verb === "help") {
    parsed.help = true;
    return parsed;
  }
  const spec = VERBS[verb];
  if (!spec) {
    parsed.errors.push(`unknown verb ${verb}`);
    return parsed;
  }
  parsed.verb = verb;
  while (rest.length > 0) {
    const token = rest.shift();
    if (token === "--pretty") {
      parsed.pretty = true;
      continue;
    }
    if (token === "--help" || token === "-h") {
      parsed.help = true;
      continue;
    }
    if (!token.startsWith("--")) {
      parsed.positionals.push(token);
      continue;
    }
    const eq = token.indexOf("=");
    const name = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (spec.bools.includes(name)) {
      parsed.flags[name] = true;
    } else if (spec.strings.includes(name)) {
      const value = eq === -1 ? rest.shift() : token.slice(eq + 1);
      if (value === undefined) parsed.errors.push(`--${name} needs a value`);
      else parsed.flags[name] = value;
    } else {
      parsed.errors.push(`unknown flag --${name} for ${verb}`);
    }
  }
  const min = spec.optional ? 0 : spec.positional;
  if (parsed.positionals.length < min || parsed.positionals.length > spec.positional) {
    parsed.errors.push(spec.positional === 0 ? `${verb} takes no positional arguments` : `${verb} takes ${spec.optional ? "at most " : "exactly "}${spec.positional} key`);
  }
  return parsed;
}

function requireFlags(parsed, names) {
  const missing = names.filter((name) => parsed.flags[name] === undefined);
  if (missing.length > 0) throw new LoopError(`${parsed.verb} needs ${missing.map((name) => `--${name}`).join(", ")}`);
}

function parsePositive(flag, value) {
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new LoopError(`--${flag} must be a positive integer`);
  return number;
}

async function loadRun(deps) {
  if (deps.runLoop) return deps.runLoop;
  const module = await import("../src/loop/run.mjs");
  return module.runLoop;
}

async function dispatch(parsed, deps) {
  const flags = parsed.flags;
  const key = parsed.positionals[0];
  const loopDeps = deps.loop;
  switch (parsed.verb) {
    case "open":
      requireFlags(parsed, ["spec"]);
      return openLoop(key, { cwd: flags.cwd, spec: flags.spec, base: flags.base }, loopDeps);
    case "run": {
      const runLoop = await loadRun(deps);
      return runLoop(key, { cwd: flags.cwd, answer: flags.answer, gateOnly: Boolean(flags["gate-only"]), surface: flags.surface }, loopDeps);
    }
    case "verdict":
      requireFlags(parsed, ["blame", "finding", "hunk", "why"]);
      return recordVerdict(key, { blame: flags.blame, finding: flags.finding, hunk: flags.hunk, why: flags.why }, { cwd: flags.cwd, index: parsePositive("index", flags.index) }, loopDeps);
    case "close":
      requireFlags(parsed, ["outcome"]);
      return closeLoop(key, { cwd: flags.cwd, outcome: flags.outcome, keep: parsePositive("keep", flags.keep), remaining: flags.remaining }, loopDeps);
    case "status":
      return statusLoop(key, { cwd: flags.cwd }, loopDeps);
    case "doctor":
      return doctorLoop({ cwd: flags.cwd, prune: Boolean(flags.prune) }, loopDeps);
    case "retro":
      requireFlags(parsed, ["normalize"]);
      return { exit: EXIT.ok, ...normalizeRetro(loopDeps) };
    default:
      throw new LoopError(`unknown verb ${parsed.verb}`);
  }
}

function renderOpen(result) {
  if (result.needs_trust) {
    const lines = ["accept commands need approval before the loop can arm:"];
    for (const entry of result.untrusted) lines.push(`  ${entry.id ?? "?"}: ${(entry.argv ?? [entry]).join(" ")}`);
    lines.push(`approve with: ${result.approve}`);
    return lines.join("\n");
  }
  const lines = [`loop ${result.key} armed on ${String(result.base).slice(0, 12)} via ${result.surface}${result.control ? " (opus control on)" : ""}`];
  for (const worktree of result.worktrees ?? []) lines.push(`  worktree ${worktree.index}: ${worktree.path} (${worktree.branch})`);
  if (result.baseline) lines.push(`baseline gate: ${result.baseline.verdict}, ${result.baseline.findings} findings`);
  return lines.join("\n");
}

function renderVerdict(result) {
  const lines = [`verdict recorded: ${result.verdict.blame} on ${result.verdict.finding} at ${result.verdict.hunk} (attempt ${result.verdict.attempt})`];
  if (result.slip) lines.push(result.slip.error ? `slip failed: ${result.slip.error}` : "slip recorded for the judge");
  lines.push(`next: ${result.next}`);
  return lines.join("\n");
}

function renderClose(result) {
  const report = result.final_report;
  const lines = [`loop ${report.key} closed ${report.outcome}: ${report.attempts} attempts, gate ${report.gate.verdict}`, `kept worktree ${report.worktree}`];
  for (const lane of result.lane_closes ?? []) lines.push(lane.skipped ? `  lane ${lane.session} not closed: ${lane.skipped}` : `  lane ${lane.session} loop-close exit ${lane.exit}${lane.error ? `: ${lane.error}` : ""}`);
  for (const removed of result.removed ?? []) lines.push(`  removed ${removed.path}`);
  if (result.retro?.error) lines.push(`retro not written: ${result.retro.error}`);
  lines.push(`remaining: ${report.remaining}`);
  return lines.join("\n");
}

function renderLoop(loop) {
  const lines = [`${loop.key}  ${loop.phase}  ${loop.surface}  ${loop.attempts.length} attempts${loop.outcome ? `  ${loop.outcome}` : ""}`];
  for (const attempt of loop.attempts) {
    lines.push(`  ${attempt.name}  gate ${attempt.gate ?? "-"}  ${attempt.findings} findings  ${attempt.tamper} tamper${attempt.blame ? `  blame ${attempt.blame}` : ""}`);
  }
  if (loop.question) lines.push(`  open question: ${loop.question.text ?? JSON.stringify(loop.question)}`);
  return lines.join("\n");
}

function renderStatus(result) {
  if (result.loop) return renderLoop(result.loop);
  return result.loops.length === 0 ? "no loops in this repository" : result.loops.map(renderLoop).join("\n");
}

function renderDoctor(result) {
  const lines = result.checks.flatMap((entry) => {
    const mark = entry.status === "pass" ? "ok  " : entry.status === "warn" ? "warn" : "FAIL";
    const head = `${mark} ${entry.check}: ${entry.detail}`;
    return entry.fix && entry.status !== "pass" ? [head, `     fix: ${entry.fix}`] : [head];
  });
  for (const entry of result.prune?.pruned ?? []) lines.push(`pruned ${entry.path}`);
  for (const entry of result.prune?.kept ?? []) lines.push(`kept ${entry.path}: ${entry.reason}`);
  lines.push(result.ok ? "doctor: no failing checks" : "doctor: some checks fail");
  return lines.join("\n");
}

function renderRetro(result) {
  if (result.reason) return `retro: ${result.reason}`;
  return `retro: ${result.changed} of ${result.lines} lines normalized${result.backed_up ? `, backup ${result.backup}` : ""}`;
}

const RENDERERS = { open: renderOpen, verdict: renderVerdict, close: renderClose, status: renderStatus, doctor: renderDoctor, retro: renderRetro };

export function renderPretty(verb, result) {
  if (result.error) return [`error: ${result.error}`, ...(result.needs_trust ? [renderOpen(result)] : [])].join("\n");
  if (typeof result.text === "string") return result.text;
  const render = RENDERERS[verb];
  return render ? render(result) : JSON.stringify(result, null, 2);
}

export async function main(argv, deps = {}) {
  const parsed = parseArgs(argv);
  if (parsed.help) return { exit: EXIT.ok, stdout: helpText(), stderr: "" };
  if (parsed.errors.length > 0 || !parsed.verb) {
    const message = parsed.errors.length > 0 ? parsed.errors.join("; ") : "missing verb";
    const body = parsed.pretty ? `error: ${message}\n\n${helpText()}` : JSON.stringify({ error: message, exit: EXIT.usage });
    return { exit: EXIT.usage, stdout: body, stderr: "" };
  }
  let result;
  let exit = EXIT.ok;
  try {
    result = await dispatch(parsed, deps);
    exit = result?.exit ?? EXIT.ok;
  } catch (error) {
    exit = error instanceof LoopError ? error.exit : EXIT.infra;
    result = { ...(error.result ?? {}), error: error.message };
  }
  const { exit: _exit, ...printable } = result ?? {};
  const stdout = parsed.pretty ? renderPretty(parsed.verb, printable) : JSON.stringify(exit !== EXIT.ok && printable.error ? { ...printable, exit } : printable);
  return { exit, stdout, stderr: "" };
}

function invokedDirectly() {
  try {
    return process.argv[1] !== undefined && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  const { exit, stdout, stderr } = await main(process.argv.slice(2));
  if (stdout) process.stdout.write(`${stdout}\n`);
  if (stderr) process.stderr.write(`${stderr}\n`);
  process.exitCode = exit;
}
