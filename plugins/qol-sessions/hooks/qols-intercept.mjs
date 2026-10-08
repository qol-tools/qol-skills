#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const FLAGS = { surface: "--surface", harness: "--tool", model: "--model", effort: "--effort" };

const USAGE = [
  "qols fork <problem> [--harness H] [--model M] [--effort E] [--surface S]",
  "qols bridge <task> [--harness H] [--model M] [--effort E] [--surface S]",
  "qols test <problem> [--harness H] [--model M] [--effort E] [--surface S]",
  "fork: detached architect that owns the problem; bridge: lane that reports back here;",
  "test: a fork whose prompt is typed but not submitted, so the launch costs no tokens",
  "values may be [aliases] from sessions.toml; left out, sessions.toml defaults apply",
].join("\n");

export function parsePrompt(prompt) {
  const match = /^qols(?:\s+([\s\S]*))?$/i.exec((prompt ?? "").trim());
  if (match === null) return null;
  const tokens = (match[1] ?? "").trim().split(/\s+/).filter(Boolean);
  const verb = tokens.shift()?.toLowerCase();
  if (verb !== "fork" && verb !== "bridge" && verb !== "test") return { verb: "help" };
  const flags = [];
  while (tokens.length >= 2 && tokens.at(-2).startsWith("--")) {
    const name = tokens.at(-2).slice(2);
    if (!Object.hasOwn(FLAGS, name)) return { verb: "help", error: `unknown flag --${name}` };
    const value = tokens.pop();
    tokens.pop();
    flags.unshift(FLAGS[name], value);
  }
  const message = tokens.join(" ");
  if (message === "") return { verb: "help" };
  return { verb, message, flags };
}

export function commandFor({ verb, message, flags }, cwd) {
  if (verb === "fork") return ["sessions", "fork", "--cwd", cwd, "--brief", message, ...flags];
  if (verb === "test") return ["sessions", "fork", "--cwd", cwd, "--brief", message, "--dry-run", ...flags];
  return ["sessions", "spawn", "--cwd", cwd, "--task", message, "--background", ...flags];
}

export function summarize(verb, outcome) {
  const launch = [outcome.tool, outcome.model, outcome.effort, outcome.surface].filter(Boolean).join(" ");
  if (verb === "fork") return `qols fork: ${outcome.key} (${launch})`;
  if (verb === "test") return `qols test: ${outcome.key} (${launch}); the prompt is typed but not submitted`;
  return `qols bridge: ${outcome.key} (${launch}); its report arrives here as the next prompt`;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8") || "{}");
  } catch {
    process.exit(0);
  }
  const parsed = parsePrompt(input.prompt);
  if (parsed === null) process.exit(0);

  let reason = parsed.error ? `${parsed.error}\n${USAGE}` : USAGE;
  if (parsed.verb !== "help") {
    try {
      const output = execFileSync("qol", commandFor(parsed, input.cwd || process.cwd()), {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      const outcome = JSON.parse(output);
      if (parsed.verb === "bridge") {
        spawn("qol", ["sessions", "watch", outcome.session], { detached: true, stdio: "ignore" }).unref();
      }
      reason = summarize(parsed.verb, outcome);
    } catch (error) {
      reason = `qols ${parsed.verb}: ${`${error.stderr ?? ""}`.trim() || error.message}`;
    }
  }
  process.stdout.write(JSON.stringify({ decision: "block", reason }) + "\n");
  process.exit(0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
