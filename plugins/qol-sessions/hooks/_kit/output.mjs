// @generated hook-kit output.mjs sha256:e30e3f1b81b3d5d7702e13ddd153a3905253b40a8b4d1cd25f61dec0dee56419 - do not edit; change qol-skills/kit-src/hook-kit, then run vs vendor
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
