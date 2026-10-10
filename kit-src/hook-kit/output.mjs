export function denyJson({ hook, why, hint, decision = "deny", event = "PreToolUse" }) {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event,
      permissionDecision: decision,
      permissionDecisionReason: `${why}\n[${hook}] ${hint}`,
    },
  });
}

export function blockJson(reason, { suppressPrompt = false } = {}) {
  return JSON.stringify({
    decision: "block",
    reason,
    ...(suppressPrompt && { hookSpecificOutput: { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true } }),
  });
}

export function contextJson(event, text) {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

export function emitContext(event, text) {
  process.stdout.write(`${contextJson(event, text)}\n`);
}
