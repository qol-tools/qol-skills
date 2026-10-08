#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const USAGE = [
  "qols fork <problem> [-picks]   detached architect that owns the problem",
  "qols bridge <task> [-picks]    lane that reports back to this session",
  "picks: -tab -win, -<harness>, -<model>, -<effort>, or an [aliases] entry in sessions.toml",
].join("\n");

export function parsePrompt(prompt) {
  const match = /^qols(?:\s+([\s\S]*))?$/i.exec((prompt ?? "").trim());
  if (match === null) return null;
  const tokens = (match[1] ?? "").trim().split(/\s+/).filter(Boolean);
  const verb = tokens.shift()?.toLowerCase();
  if (verb !== "fork" && verb !== "bridge") return { verb: "help" };
  const picks = [];
  while (tokens.length > 0 && /^--?[^-\s]\S*$/.test(tokens.at(-1))) {
    picks.unshift(tokens.pop().replace(/^--?/, "-"));
  }
  const message = tokens.join(" ");
  if (message === "") return { verb: "help" };
  return { verb, message, picks };
}

export function commandFor({ verb, message, picks }, cwd) {
  if (verb === "fork") return ["sessions", "fork", "--cwd", cwd, "--brief", message, ...picks];
  return ["sessions", "spawn", "--cwd", cwd, "--task", message, "--background", ...picks];
}

export function summarize(verb, outcome) {
  const launch = [outcome.tool, outcome.model, outcome.effort, outcome.surface].filter(Boolean).join(" ");
  if (verb === "fork") return `qols fork: ${outcome.key} (${launch})`;
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

  let reason = USAGE;
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
