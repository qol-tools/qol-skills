import assert from "node:assert/strict";
import test from "node:test";

import { blockJson, contextJson, denyJson, emitContext } from "../output.mjs";

test("denyJson matches the two-line PreToolUse deny of pr-watch-park-guard", () => {
  assert.equal(
    denyJson({
      hook: "pr-watch-park-guard",
      why: "The pull request watcher runs only under a parked session, so no terminal stays open while it waits.",
      hint: "run `qol sessions park -- node pr-watch.cjs <pr-url> --pretty` and end your turn",
    }),
    '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":'
      + '"The pull request watcher runs only under a parked session, so no terminal stays open while it waits.\\n'
      + '[pr-watch-park-guard] run `qol sessions park -- node pr-watch.cjs <pr-url> --pretty` and end your turn"}}',
  );
});

test("denyJson takes another decision and event", () => {
  const out = JSON.parse(denyJson({ hook: "h", why: "w", hint: "i", decision: "ask", event: "PermissionRequest" }));
  assert.deepEqual(out, {
    hookSpecificOutput: { hookEventName: "PermissionRequest", permissionDecision: "ask", permissionDecisionReason: "w\n[h] i" },
  });
});

test("blockJson matches the sw-intercept fallback reply", () => {
  assert.equal(blockJson("sw: nothing to do"), '{"decision":"block","reason":"sw: nothing to do"}');
});

test("blockJson can hide the original prompt from the block notice", () => {
  assert.deepEqual(JSON.parse(blockJson("qols fork: k", { suppressPrompt: true })), {
    decision: "block",
    reason: "qols fork: k",
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true },
  });
});

test("contextJson matches the vs-intercept autoinject setup context", () => {
  assert.equal(
    contextJson("UserPromptSubmit", "[autoinject] Run the guided setup"),
    '{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"[autoinject] Run the guided setup"}}',
  );
});

test("emitContext writes one context line to stdout", () => {
  const writes = [];
  const write = process.stdout.write;
  process.stdout.write = (chunk) => writes.push(chunk);
  try {
    emitContext("PreToolUse", "commit rules");
  } finally {
    process.stdout.write = write;
  }
  assert.deepEqual(writes, ['{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":"commit rules"}}\n']);
});
