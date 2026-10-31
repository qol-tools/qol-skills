import { EXIT } from "../paths.mjs";

export function runHandover() {
  return { exit: EXIT.handover, text: "", session: null, cost_usd: null };
}
