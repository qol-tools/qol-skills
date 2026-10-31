import { LoopError, SURFACES, findOnPath, withDefaults } from "../paths.mjs";
import { runHandover } from "./handover.mjs";
import { runHeadless } from "./headless.mjs";
import { runKitty } from "./kitty.mjs";

export function detectLanes(deps) {
  const d = withDefaults(deps);
  const qol = findOnPath("qol", d);
  let kitty = false;
  if (qol) {
    const help = d.exec([qol, "sessions", "spawn", "--help"], { env: d.env });
    kitty = /receipt_path/.test(`${help.stdout ?? ""}${help.stderr ?? ""}`);
  }
  const claude = findOnPath("claude", d);
  const headless = d.env.QOLS_HEADLESS_LANES === "1" && claude !== null;
  return { qol, kitty, claude, headless };
}

export function pickSurface({ force } = {}, deps) {
  if (force) {
    if (!SURFACES.includes(force)) throw new LoopError(`unknown surface ${force}: use ${SURFACES.join(", ")}`);
    return force;
  }
  const lanes = detectLanes(deps);
  if (lanes.kitty) return "kitty";
  if (lanes.headless) return "headless";
  return "handover";
}

export function extractQuestion(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  const at = lines.findIndex((line) => line.startsWith("QUESTION:"));
  if (at === -1) return null;
  const first = lines[at].slice("QUESTION:".length).trim();
  const rest = lines.slice(at + 1).join("\n").trim();
  return [first, rest].filter(Boolean).join("\n") || "(the lane asked without text)";
}

const RUNNERS = { kitty: runKitty, headless: runHeadless, handover: async () => runHandover() };

export async function runLane(opts, deps) {
  const runner = RUNNERS[opts?.surface];
  if (!runner) throw new Error(`unknown surface ${opts?.surface}: use ${SURFACES.join(", ")}`);
  const d = withDefaults(deps);
  const result = await runner(opts, d);
  const text = result.text ?? "";
  const lane = {
    exit: result.exit,
    text,
    session: result.session ?? null,
    cost_usd: result.cost_usd ?? null,
    question: result.exit === 0 ? extractQuestion(text) : null,
  };
  if (result.completion_marker) lane.completion_marker = result.completion_marker;
  return result.error ? { ...lane, error: result.error } : lane;
}
