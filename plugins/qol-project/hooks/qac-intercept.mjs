#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../scripts/qac.mjs", import.meta.url));
const VERBS = ["lint", "fix", "help"];
const FINDINGS = 1;

export function parsePrompt(prompt, cwd) {
  const match = /^qac(?:\s+(.*))?$/i.exec((prompt ?? "").trim());
  if (match === null) return null;
  const rest = (match[1] ?? "").trim();
  const tokens = rest === "" ? [] : rest.split(/\s+/);
  const verb = tokens[0]?.toLowerCase();
  const args = tokens.length === 0
    ? ["help"]
    : VERBS.includes(verb) ? [verb, ...tokens.slice(1)] : ["lint", ...tokens];
  const flags = ["--prefix=qac", "--pretty"];
  if (args[0] === "lint") flags.push("--open");
  if (cwd) flags.push(`--cwd=${cwd}`);
  return [...args, ...flags];
}

export function hookResponse(verb, status, output) {
  const text = output.trim() || `qac ${verb}: nothing to do`;
  if (verb === "fix" && status === FINDINGS) {
    return { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text } };
  }
  return { decision: "block", reason: text };
}

function main() {
  let prompt = "";
  let cwd = "";
  try {
    const input = JSON.parse(readFileSync(0, "utf8") || "{}");
    if (typeof input.prompt === "string") prompt = input.prompt;
    if (typeof input.cwd === "string") cwd = input.cwd;
  } catch {
    process.exit(0);
  }

  const args = parsePrompt(prompt, cwd);
  if (args === null) process.exit(0);

  let output;
  let status = 0;
  try {
    output = execFileSync(process.execPath, [CLI, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  } catch (error) {
    status = error.status ?? -1;
    output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim()
      || (error instanceof Error ? error.message : String(error));
  }

  process.stdout.write(`${JSON.stringify(hookResponse(args[0], status, output))}\n`);
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
