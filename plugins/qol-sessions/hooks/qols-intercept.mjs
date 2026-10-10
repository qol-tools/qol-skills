#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { closest, renderDiagnostic } from "./_kit/diagnostic.mjs";
import { runPromptCommand } from "./_kit/prompt-command.mjs";

export { renderDiagnostic };

const FLAGS = { harness: "--tool", model: "--model", effort: "--effort", surface: "--surface" };

const USAGE = [
  "qols fork <problem> [--harness H] [--model M] [--effort E] [--surface S]",
  "qols bridge <task> [--harness H] [--model M] [--effort E] [--surface S]",
  "qols test <problem> [--harness H] [--model M] [--effort E] [--surface S]",
  "fork: detached architect that owns the problem; bridge: lane that reports back here;",
  "test: a fork whose prompt is typed but not submitted, so the launch costs no tokens",
  "values may be [aliases] from sessions.toml; left out, sessions.toml defaults apply",
].join("\n");

const VERBS = ["fork", "bridge", "test"];

function usageFor(verb) {
  return USAGE.split("\n").find((line) => line.startsWith(`qols ${verb} `));
}

export function parsePrompt(prompt) {
  const source = (prompt ?? "").trim();
  const match = /^qols(?:\s+([\s\S]*))?$/i.exec(source);
  if (match === null) return null;
  const tokens = [...source.matchAll(/\S+/g)].map((m) => ({ text: m[0], start: m.index, end: m.index + m[0].length }));
  tokens.shift();
  const verbToken = tokens.shift();
  const verb = verbToken?.text.toLowerCase();
  if (verbToken === undefined || verb === "help") return { verb: "help" };
  if (!VERBS.includes(verb)) {
    const guess = closest(verb, VERBS);
    return {
      verb: "help",
      diagnostic: {
        title: `unknown command \`${verbToken.text}\``,
        source,
        start: verbToken.start,
        end: verbToken.end,
        label: "qols has no such command",
        notes: [
          ...(guess ? [`help: did you mean \`${guess}\`?`] : []),
          `note: commands are ${VERBS.join(", ")}`,
        ],
      },
    };
  }
  const flags = [];
  while (tokens.length >= 2 && tokens.at(-2).text.startsWith("--")) {
    const flag = tokens.at(-2);
    const name = flag.text.slice(2);
    if (!Object.hasOwn(FLAGS, name)) {
      const guess = closest(name, Object.keys(FLAGS));
      return {
        verb: "help",
        diagnostic: {
          title: `unknown flag \`${flag.text}\``,
          source,
          start: flag.start,
          end: flag.end,
          label: "not a flag qols knows",
          notes: [
            ...(guess ? [`help: did you mean \`--${guess}\`?`] : []),
            `note: flags are ${Object.keys(FLAGS).map((key) => `--${key}`).join(", ")}`,
            `usage: ${usageFor(verb)}`,
          ],
        },
      };
    }
    const value = tokens.pop();
    tokens.pop();
    flags.unshift(FLAGS[name], value.text);
  }
  if (tokens.length === 0) {
    return {
      verb: "help",
      diagnostic: {
        title: `\`qols ${verb}\` needs a task`,
        source,
        start: verbToken.end,
        end: verbToken.end + 1,
        label: "expected a task here",
        notes: [`usage: ${usageFor(verb)}`],
      },
    };
  }
  return { verb, message: tokens.map((t) => t.text).join(" "), flags };
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

function reply(parsed, cwd) {
  if (parsed === null) return null;
  if (parsed.verb === "help") return { reason: parsed.diagnostic ? renderDiagnostic(parsed.diagnostic) : USAGE };
  try {
    const output = execFileSync("qol", commandFor(parsed, cwd), {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const outcome = JSON.parse(output);
    if (parsed.verb === "bridge") {
      spawn("qol", ["sessions", "watch", outcome.session], { detached: true, stdio: "ignore" }).unref();
    }
    return { reason: summarize(parsed.verb, outcome), sent: true };
  } catch (error) {
    return { reason: `qols ${parsed.verb}: ${`${error.stderr ?? ""}`.trim() || error.message}` };
  }
}

function main() {
  runPromptCommand({ parse: (prompt, cwd) => reply(parsePrompt(prompt), cwd), prefix: "qols", cwd: "input" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
