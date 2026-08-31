import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import path from "node:path";

const PLUGIN_DIR = path.resolve(__dirname, "../..");

const PRE_TOOL_USE_HOOKS = [
];

const USER_PROMPT_SUBMIT_HOOKS = [
    { script: "hooks/inject_workflow_nodes_reminder.mjs" },
];

const SESSION_START_CONTEXT_HOOKS = [
    { script: "hooks/clear_workflow_nodes_sentinel.mjs" },
];

const PRE_COMPACT_HOOKS = [
    { script: "hooks/clear_workflow_nodes_sentinel.mjs" },
];

let stashedContext = "";
let stashedSessionFile = "";
let injectedSessionFile = "";

function runHook(script, input) {
  const scriptPath = path.join(PLUGIN_DIR, script);

  let result;

  try {
    result = spawnSync(process.execPath, [scriptPath], {
      input,
      encoding: "utf-8",
      timeout: 5000,
    });
  } catch (_error) {
    return { blocked: false };
  }

  const stdout = (result?.stdout ?? "").trim();
  const stderr = (result?.stderr ?? "").trim();

  if (result?.status !== 0 && result?.status !== null) {
    return { blocked: true, reason: stderr || stdout || `Blocked by ${script}` };
  }

  let context;
  let systemMessage;

  if (stdout) {
    try {
      const parsed = JSON.parse(stdout);

      if (parsed?.decision === "block") {
        return {
          blocked: true,
          reason: parsed?.reason || `Blocked by ${script}`,
        };
      }

      const decision = parsed?.hookSpecificOutput;

      if (decision?.permissionDecision === "deny") {
        return {
          blocked: true,
          reason: decision.permissionDecisionReason || `Blocked by ${script}`,
        };
      }

      context = decision?.additionalContext;
      systemMessage = parsed?.systemMessage;
    } catch (_ignored) {}
  }

  return { blocked: false, context, systemMessage };
}

function matchedToolName(matcher, toolName) {
  return matcher
    .split("|")
    .map((name) => name.trim())
    .find((name) => name.toLowerCase() === toolName.toLowerCase());
}

export default function (pi: ExtensionAPI) {

  if (USER_PROMPT_SUBMIT_HOOKS.length > 0) {
    pi.on("before_agent_start", async (event, _ctx) => {
      let extraContext = "";

      for (const hook of USER_PROMPT_SUBMIT_HOOKS) {
        const cwd = event.systemPromptOptions?.cwd ?? "";
        const input = JSON.stringify({ cwd, prompt: event.prompt });
        const result = runHook(hook.script, input);

        if (result.context) {
          extraContext += "\n\n" + result.context;
        }
      }

      if (extraContext) {
        return { systemPrompt: (event.systemPrompt ?? "") + extraContext };
      }
    });
  }

  if (SESSION_START_CONTEXT_HOOKS.length > 0) {
    pi.on("session_start", async (event, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile() ?? "";
      const sessionId = ctx.sessionManager.getSessionId();
      let context = "";

      for (const hook of SESSION_START_CONTEXT_HOOKS) {
        const result = runHook(hook.script, JSON.stringify({
          session_id: sessionId,
          cwd: ctx.sessionManager.getCwd(),
          session_file: sessionFile,
          reason: event.reason ?? "",
        }));

        if (result.systemMessage) {
          ctx.ui?.notify?.(result.systemMessage, "info");
        }

        if (result.context) {
          context += "\n\n" + result.context;
        }
      }

      if (context) {
        stashedContext = context;
        stashedSessionFile = sessionFile;
      } else if (sessionFile !== stashedSessionFile) {
        stashedContext = "";
        stashedSessionFile = sessionFile;
      }
    });

    pi.on("before_agent_start", async (event, ctx) => {
      const sessionFile = ctx.sessionManager.getSessionFile() ?? "";

      if (
        stashedContext
        && sessionFile === stashedSessionFile
        && sessionFile !== injectedSessionFile
      ) {
        injectedSessionFile = sessionFile;
        return { systemPrompt: (event.systemPrompt ?? "") + "\n\n" + stashedContext };
      }
    });
  }

  if (PRE_COMPACT_HOOKS.length > 0) {
    pi.on("session_before_compact", async (_event, ctx) => {
      const sessionId = path.basename(ctx.sessionManager.getSessionFile() ?? "");

      for (const hook of PRE_COMPACT_HOOKS) {
        runHook(hook.script, JSON.stringify({ session_id: sessionId }));
      }
    });
  }
}
