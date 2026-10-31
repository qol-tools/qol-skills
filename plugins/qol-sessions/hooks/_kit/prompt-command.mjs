// @generated hook-kit prompt-command.mjs sha256:5ac73e245832b3c8038778f5914226446bb5023185cad80da165ccee51e45e96 - do not edit; change qol-skills/kit-src/hook-kit, then run its scripts/vendor-hook-kit.mjs
import { spawnSync } from "node:child_process";

import { gitRoot, readHookInput } from "./input.mjs";
import { blockJson, contextJson } from "./output.mjs";

export const CLI_TIMEOUT_MS = 50000;
export const MIN_NODE_MAJOR = 18;

const CRASH_STACK = /^\s+at \S/m;
const USAGE_LINE = /^usage:/;
const USAGE_STATUS = 2;
const MAX_BUFFER = 64 * 1024 * 1024;

function failed(status, text) {
  return { kind: "failed", status, text };
}

export function runCli(cli, argv, { cwd, bin = process.execPath, timeoutMs = CLI_TIMEOUT_MS, answered = [0], exec = spawnSync } = {}) {
  const run = exec(bin, [cli, ...argv], {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: MAX_BUFFER,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const status = typeof run.status === "number" ? run.status : null;
  const stdout = `${run.stdout ?? ""}`;
  const output = (status === 0 ? stdout : `${stdout}${run.stderr ?? ""}`).trim();
  if (run.error?.code === "ETIMEDOUT") {
    return failed(status, [output, `timed out after ${timeoutMs / 1000} s`].filter(Boolean).join("\n"));
  }
  if (run.error) return failed(status, output || run.error.message);
  if (status === null) return failed(status, output || `killed by ${run.signal ?? "a signal"}`);
  if (CRASH_STACK.test(output)) return failed(status, output);
  if (status === USAGE_STATUS || USAGE_LINE.test(output)) return { kind: "usage", status, text: output };
  if (answered.includes(status)) return { kind: "answered", status, text: output };
  return failed(status, output || `exited with status ${status}`);
}

function resolveCwd(input, mode) {
  const cwd = typeof input.cwd === "string" && input.cwd !== "" ? input.cwd : process.cwd();
  return mode === "git" ? gitRoot(cwd) : cwd;
}

export function hidesPrompt(input, env = process.env) {
  return env.CLAUDECODE === "1" && input?.turn_id === undefined;
}

export function decidePrompt(input, { parse, cli, prefix, cwd = "input", handle = runCli, answered, env = process.env }) {
  const prompt = typeof input?.prompt === "string" ? input.prompt : "";
  const dir = resolveCwd(input ?? {}, cwd);
  const parsed = parse(prompt, dir);
  if (parsed === null || parsed === undefined) return null;
  if (Array.isArray(parsed)) {
    const result = handle(cli, parsed, { cwd: dir, answered });
    return blockJson(`${result?.text ?? ""}`.trim() || `${prefix}: nothing to do`, {
      suppressPrompt: result?.kind === "answered" && hidesPrompt(input, env),
    });
  }
  if (typeof parsed.context === "string") {
    return contextJson("UserPromptSubmit", parsed.context);
  }
  return blockJson(parsed.reason, { suppressPrompt: parsed.sent === true && hidesPrompt(input, env) });
}

function nodeMajor(version) {
  return Number.parseInt(`${version}`.split(".")[0], 10);
}

export function runPromptCommand(opts) {
  try {
    const input = readHookInput();
    const version = opts.nodeVersion ?? process.versions.node;
    const tooOld = !(nodeMajor(version) >= MIN_NODE_MAJOR);
    const refuse = () => failed(null, `${opts.prefix}: needs Node ${MIN_NODE_MAJOR} or newer, this is Node ${version}`);
    const output = input === null ? null : decidePrompt(input, tooOld ? { ...opts, handle: refuse } : opts);
    if (output !== null) process.stdout.write(`${output}\n`);
  } catch {}
  process.exit(0);
}
