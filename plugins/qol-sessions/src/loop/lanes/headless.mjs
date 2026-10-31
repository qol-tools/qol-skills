import { spawn } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export function defaultSpawn(argv, { cwd, env, timeoutMs } = {}) {
  return new Promise((resolve) => {
    const out = [];
    const err = [];
    let settled = false;
    let timedOut = false;
    let timer = null;
    const finish = (status, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(err).toString("utf8"), error: error ?? null });
    };
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      finish(null, error.code ?? error.message);
      return;
    }
    child.stdout.on("data", (chunk) => out.push(chunk));
    child.stderr.on("data", (chunk) => err.push(chunk));
    child.on("error", (error) => finish(null, error.code ?? error.message));
    child.on("close", (code) => finish(timedOut ? null : code, timedOut ? "timeout" : null));
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, timeoutMs);
    }
  });
}

export function headlessArgv({ brief, lane, budget, sessionId, resume }) {
  return [
    "claude",
    "-p",
    brief,
    "--output-format",
    "json",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Read,Edit,Write,Glob,Grep",
    "--disallowedTools",
    "Bash",
    "--model",
    lane.model,
    "--max-budget-usd",
    String(budget),
    resume ? "--resume" : "--session-id",
    sessionId,
  ];
}

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function failure(error, extra = {}) {
  return { exit: 1, text: "", session: null, cost_usd: null, error, ...extra };
}

export async function runHeadless(opts, d) {
  if (!(Number(opts.budget) > 0)) return { ...failure("headless lanes need budget_usd in the spec"), exit: 2 };
  if (!opts.sessionId) return { ...failure("headless lanes need a session id"), exit: 2 };
  const resume = opts.resume ?? (Number(opts.attempt) > 1 || Boolean(opts.answer));
  const run = d.spawn ?? defaultSpawn;
  const result = await run(headlessArgv({ ...opts, resume }), { cwd: opts.cwd, env: d.env, timeoutMs: d.laneTimeoutMs ?? DEFAULT_TIMEOUT_MS });
  const parsed = parseJson(String(result.stdout ?? "").trim());
  const session = parsed?.session_id ?? opts.sessionId;
  const cost = Number(parsed?.total_cost_usd ?? parsed?.cost_usd);
  const cost_usd = Number.isFinite(cost) ? cost : null;
  if (result.status !== 0) {
    const detail = String(result.stderr ?? "").trim() || result.error || `exit ${result.status}`;
    return failure(`claude -p failed: ${detail}`, { session, cost_usd });
  }
  if (!parsed || typeof parsed !== "object") return failure("claude -p printed no JSON result", { session });
  if (parsed.is_error === true || (parsed.subtype && parsed.subtype !== "success")) {
    return failure(`claude -p reported ${parsed.subtype ?? "an error"}: ${String(parsed.result ?? "").slice(0, 300)}`, { session, cost_usd });
  }
  return { exit: 0, text: typeof parsed.result === "string" ? parsed.result : "", session, cost_usd };
}
