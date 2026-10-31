import { createHash } from "node:crypto";

export const CONTROL_LANE = Object.freeze({ tool: "claude", model: "claude-opus-5-5", effort: "high" });

export const CONTROL_INDEX = "control";

export function isControlLoop(key, env = process.env) {
  if (env.QOLS_CONTROL === "0") return false;
  const head = createHash("sha256").update(String(key)).digest("hex").slice(0, 8);
  return parseInt(head, 16) % 5 === 0;
}

export function controlWanted(loop, env = process.env) {
  if (env.QOLS_CONTROL === "0") return false;
  return loop.control === undefined || loop.control === null ? isControlLoop(loop.key, env) : Boolean(loop.control);
}
