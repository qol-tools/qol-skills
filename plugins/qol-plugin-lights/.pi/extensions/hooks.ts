import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawnSync } from "node:child_process";
import path from "node:path";

const PLUGIN_DIR = path.resolve(__dirname, "../..");

const PRE_TOOL_USE_HOOKS = [
    { matcher: "Edit|Write|NotebookEdit", script: "bin/route-to-agent.cjs" }
];

const USER_PROMPT_SUBMIT_HOOKS = [

];

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
      context = parsed?.hookSpecificOutput?.additionalContext;
    } catch (_ignored) {}
  }

  return { blocked: false, context };
}

export default function (pi: ExtensionAPI) {
  if (PRE_TOOL_USE_HOOKS.length > 0) {
    pi.on("tool_call", async (event, _ctx) => {
      const hook = PRE_TOOL_USE_HOOKS.find(
        (h) => h.matcher && event.toolName &&
          h.matcher.toLowerCase() === event.toolName.toLowerCase()
      );

      if (!hook) {
        return;
      }

      const input = JSON.stringify({
        tool_name: "Bash",
        tool_input: { command: event.input?.command ?? "" },
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
}
