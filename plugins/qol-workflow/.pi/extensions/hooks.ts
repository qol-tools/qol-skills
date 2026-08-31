import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import path from "node:path";

const PLUGIN_DIR = path.resolve(__dirname, "../..");

const PRE_TOOL_USE_HOOKS = [
    { matcher: "Bash", script: "bin/commit-skill-context.cjs" },
    { matcher: "Bash", script: "bin/commit-deny-coauthor.cjs" },
    { matcher: "Bash", script: "bin/branch-deny-checkout-in-main-clone.cjs" },
    { matcher: "Bash", script: "bin/branch-deny-agent-checkout.cjs" },
    { matcher: "Bash", script: "bin/branch-deny-pid-branch-name.cjs" },
    { matcher: "Edit|Write|MultiEdit", script: "bin/deny-tool-matches.cjs" },
];

const USER_PROMPT_SUBMIT_HOOKS = [
    { script: "bin/qol-cicd-context.cjs" },
    { script: "bin/qol-monorepo-rules-context.cjs" },
];

let pendingPromptContext = "";

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
  let updatedPrompt;

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
      updatedPrompt = decision?.updatedPrompt;
    } catch (_ignored) {}
  }

  return { blocked: false, context, systemMessage, updatedPrompt };
}

function matchedToolName(matcher, toolName) {
  return matcher
    .split("|")
    .map((name) => name.trim())
    .find((name) => name.toLowerCase() === toolName.toLowerCase());
}

export default function (pi: ExtensionAPI) {
  if (PRE_TOOL_USE_HOOKS.length > 0) {
    pi.on("tool_call", async (event, _ctx) => {
      if (!event.toolName) {
        return;
      }

      for (const hook of PRE_TOOL_USE_HOOKS) {
        const matched = hook.matcher
          && matchedToolName(hook.matcher, event.toolName);

        if (!matched) {
          continue;
        }

        const input = JSON.stringify({
          tool_name: matched,
          tool_input: event.input ?? {},
        });
        const result = runHook(hook.script, input);

        if (result.blocked) {
          return { block: true, reason: result.reason };
        }
      }
    });
  }

  if (USER_PROMPT_SUBMIT_HOOKS.length > 0) {
    pi.on("input", async (event, ctx) => {
      let extraContext = "";
      let prompt = event.text;

      for (const hook of USER_PROMPT_SUBMIT_HOOKS) {
        const input = JSON.stringify({ cwd: ctx.cwd ?? "", prompt });
        const result = runHook(hook.script, input);

        if (result.blocked) {
          ctx.ui?.notify?.(result.reason, "warning");
          return { action: "handled" };
        }

        if (typeof result.updatedPrompt === "string") {
          prompt = result.updatedPrompt;
        }

        if (result.context) {
          extraContext += "\n\n" + result.context;
        }
      }

      pendingPromptContext = extraContext;

      if (prompt !== event.text) {
        return { action: "transform", text: prompt };
      }
    });

    pi.on("before_agent_start", async (event, _ctx) => {
      if (!pendingPromptContext) {
        return;
      }

      const extraContext = pendingPromptContext;
      pendingPromptContext = "";
      return { systemPrompt: (event.systemPrompt ?? "") + extraContext };
    });
  }
}
