export const HANDOVER_EXIT = 14;

export function runHandover() {
  return { exit: HANDOVER_EXIT, text: "", session: null, cost_usd: null };
}
