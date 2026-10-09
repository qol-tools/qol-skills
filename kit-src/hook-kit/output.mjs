export function denyJson({ hook, why, hint, decision = "deny", event = "PreToolUse" }) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      permissionDecision: decision,
      permissionDecisionReason: `${why}\n[${hook}] ${hint}`,
    },
  });
}

export function blockJson(reason) {
  return JSON.stringify({ decision: "block", reason });
}

export function contextJson(event, text) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

export function emitContext(event, text) {
  process.stdout.write(`${contextJson(event, text)}\n`);
}
