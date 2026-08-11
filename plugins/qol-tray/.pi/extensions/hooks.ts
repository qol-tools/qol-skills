import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import path from "node:path";

const PLUGIN_DIR = path.resolve(__dirname, "../..");

const PRE_TOOL_USE_HOOKS = [

];

const USER_PROMPT_SUBMIT_HOOKS = [

];

const SESSION_START_CONTEXT_HOOKS = [
    { script: "bin/inject-dev-recompile-context.cjs" }
];

const STOP_GUARD_HOOKS = [
    { script: "bin/stop-deny-uncited-arch-claims.cjs" }
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
    } catch (_ignored) {}
  }

  return { blocked: false, context };
}

function matchedToolName(matcher, toolName) {
  return matcher
    .split("|")
    .map((name) => name.trim())
    .find((name) => name.toLowerCase() === toolName.toLowerCase());
}

function stopGuardInput(ctx: ExtensionContext) {
  return JSON.stringify({
    transcript_path: ctx.sessionManager.getSessionFile() ?? "",
    cwd: process.cwd(),
    hook_event_name: "Stop",
  });
}

export default function (pi: ExtensionAPI) {
  if (PRE_TOOL_USE_HOOKS.length > 0) {
    pi.on("tool_call", async (event, _ctx) => {
      if (!event.toolName) {
        return;
      }

      const hook = PRE_TOOL_USE_HOOKS.find(
        (h) => h.matcher && matchedToolName(h.matcher, event.toolName)
      );

      if (!hook) {
        return;
      }

      const input = JSON.stringify({
        tool_name: matchedToolName(hook.matcher, event.toolName),
        tool_input: event.input ?? {},
      });
      const result = runHook(hook.script, input);

      if (result.blocked) {
        return { block: true, reason: result.reason };
      }
    });
  }

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
      const sessionId = path.basename(sessionFile);
      let context = "";

      for (const hook of SESSION_START_CONTEXT_HOOKS) {
        const result = runHook(hook.script, JSON.stringify({ session_id: sessionId }));

        if (result.context) {
          context += "\n\n" + result.context;
        }
      }

      stashedContext = context;
      stashedSessionFile = sessionFile;
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

  if (STOP_GUARD_HOOKS.length > 0) {
    pi.on("session_before_switch", async (event, ctx) => {
      const input = stopGuardInput(ctx);

      for (const hook of STOP_GUARD_HOOKS) {
        const result = runHook(hook.script, input);

        if (result.blocked) {
          return { cancel: true };
        }
      }
    });

    pi.on("session_shutdown", async (event, ctx) => {
      if (event.reason !== "quit") {
        return;
      }

      const input = stopGuardInput(ctx);

      for (const hook of STOP_GUARD_HOOKS) {
        const result = runHook(hook.script, input);

        if (result.blocked) {
          ctx.ui.notify(result.reason, "warning");
        }
      }
    });
  }
}
