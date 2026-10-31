import { worktreeBranch } from "../paths.mjs";

const DEFAULT_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_POLL_MS = 2000;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function failure(error, session = null) {
  return { exit: 1, text: "", session, cost_usd: null, error };
}

export function spawnArgs({ key, index, cwd, brief, lane }) {
  return [
    "qol",
    "sessions",
    "spawn",
    "--tool",
    lane.tool,
    "--model",
    lane.model,
    ...(lane.effort ? ["--effort", lane.effort] : []),
    "--cwd",
    cwd,
    "--key",
    worktreeBranch(key, index),
    "--title",
    `loop-${key}`,
    "--task",
    brief,
    "--background",
    "--silent-wake",
  ];
}

function readReceipt(file, d) {
  if (!d.exists(file)) return null;
  const receipt = parseJson(d.read(file));
  return receipt && typeof receipt.report === "string" ? receipt : null;
}

export async function runKitty(opts, d) {
  const spawned = d.exec(spawnArgs(opts), { cwd: opts.cwd, env: d.env });
  if (spawned.status !== 0) {
    const detail = String(spawned.stderr ?? "").trim() || spawned.error || `exit ${spawned.status}`;
    return failure(`qol sessions spawn failed: ${detail}`);
  }
  const outcome = parseJson(String(spawned.stdout ?? ""));
  const session = outcome?.session ?? outcome?.token ?? null;
  const receiptPath = outcome?.receipt_path;
  if (typeof receiptPath !== "string" || receiptPath === "") return failure("qol sessions spawn printed no receipt_path", session);
  const timeoutMs = d.laneTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollMs = d.pollMs ?? DEFAULT_POLL_MS;
  const clock = d.nowMs ?? Date.now;
  const sleep = d.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const deadline = clock() + timeoutMs;
  let receipt = null;
  for (;;) {
    try {
      receipt = readReceipt(receiptPath, d);
    } catch {
      receipt = null;
    }
    if (receipt) break;
    if (clock() >= deadline) return failure(`no receipt at ${receiptPath} within ${Math.round(timeoutMs / 1000)}s`, session);
    await sleep(pollMs);
  }
  let text = "";
  try {
    text = String(d.read(receipt.report));
  } catch {
    return failure(`the receipt names a report that cannot be read: ${receipt.report}`, receipt.session ?? session);
  }
  if (text.trim() === "") return failure(`the report ${receipt.report} is empty`, receipt.session ?? session);
  return {
    exit: 0,
    text,
    session: receipt.session ?? session,
    cost_usd: null,
    completion_marker: receipt.completion_marker ?? outcome?.completion_marker ?? null,
  };
}
