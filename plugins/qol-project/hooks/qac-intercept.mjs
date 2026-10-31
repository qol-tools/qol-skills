#!/usr/bin/env node
import { fileURLToPath } from "node:url";

import { runCli, runPromptCommand } from "./_kit/prompt-command.mjs";

export const CLI = fileURLToPath(new URL("../scripts/qac.mjs", import.meta.url));
export const ANSWERED = [0, 1, 5, 6];
const TIMEOUT_MS = 110000;
const VERBS = ["lint", "fix", "slip", "slips", "gate", "trust", "traps", "init", "help"];
const FINDINGS = 1;

export function parsePrompt(prompt, cwd) {
  const match = /^qac(?:\s+(.*))?$/i.exec((prompt ?? "").trim());
  if (match === null) return null;
  const rest = (match[1] ?? "").trim();
  const tokens = (rest.match(/"[^"]*"|\S+/g) ?? []).map(token => token.replace(/^"(.*)"$/s, "$1"));
  const verb = tokens[0]?.toLowerCase();
  const args = tokens.length === 0
    ? ["help"]
    : VERBS.includes(verb) ? [verb, ...tokens.slice(1)] : ["lint", ...tokens];
  const flags = ["--prefix=qac", "--pretty"];
  if (args[0] === "lint") flags.push("--open");
  if (cwd) flags.push(`--cwd=${cwd}`);
  return [...args, ...flags];
}

function runQac(argv, cwd) {
  return runCli(CLI, argv, { cwd, answered: ANSWERED, timeoutMs: TIMEOUT_MS });
}

export function decide(prompt, cwd, run = runQac) {
  const argv = parsePrompt(prompt, cwd);
  if (argv === null || argv[0] !== "fix") return argv;
  const result = run(argv, cwd);
  if (result.kind === "answered" && result.status === FINDINGS) {
    return { context: result.text || "qac fix: nothing to do" };
  }
  return { reason: result.text || "qac fix: nothing to do", sent: result.kind === "answered" };
}

function main() {
  runPromptCommand({
    parse: (prompt, cwd) => decide(prompt, cwd),
    cli: CLI,
    prefix: "qac",
    cwd: "input",
    answered: ANSWERED,
    handle: (cli, argv, options) => runCli(cli, argv, { ...options, timeoutMs: TIMEOUT_MS }),
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
