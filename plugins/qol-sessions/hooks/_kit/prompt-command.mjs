// @generated hook-kit prompt-command.mjs sha256:9f32af71ae4cd3fa6a0863440acb493cfb6c32052c3d4779c2653650fe75a332 - do not edit; change qol-skills/kit-src/hook-kit, then run vs vendor
import { execFileSync } from "node:child_process";

import { gitRoot, readHookInput } from "./input.mjs";
import { blockJson, contextJson } from "./output.mjs";

export function execCli(cli, argv, { cwd, bin = process.execPath } = {}) {
  try {
    return execFileSync(bin, [cli, ...argv], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    return `${error.stdout ?? ""}${error.stderr ?? ""}`.trim()
      || (error instanceof Error ? error.message : String(error));
  }
}

function resolveCwd(input, mode) {
  const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();
  return mode === "git" ? gitRoot(cwd) : cwd;
}

export function decidePrompt(input, { parse, cli, prefix, cwd = "input", handle = execCli }) {
  const prompt = typeof input?.prompt === "string" ? input.prompt : "";
  const dir = resolveCwd(input ?? {}, cwd);
  const parsed = parse(prompt, dir);
  if (parsed === null || parsed === undefined) return null;
  if (Array.isArray(parsed)) {
    const output = handle(cli, parsed, { cwd: dir });
    return blockJson(`${output ?? ""}`.trim() || `${prefix}: nothing to do`);
  }
  if (typeof parsed.context === "string") {
    return contextJson("UserPromptSubmit", parsed.context);
  }
  return blockJson(parsed.reason);
}

export function runPromptCommand(opts) {
  try {
    const input = readHookInput();
    const output = input === null ? null : decidePrompt(input, opts);
    if (output !== null) process.stdout.write(`${output}\n`);
  } catch {}
  process.exit(0);
}
