#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

function distance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    row = next;
  }
  return row[b.length];
}

function closest(word, options) {
  const [best] = options.map((option) => [option, distance(word, option)]).sort((a, b) => a[1] - b[1]);
  return best && best[1] <= Math.max(2, Math.floor(word.length / 3)) ? best[0] : null;
}

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

export function renderDiagnostic({ title, source, start, end, label, notes }) {
  const lineStart = source.lastIndexOf("\n", start - 1) + 1;
  const lineEnd = source.indexOf("\n", start) === -1 ? source.length : source.indexOf("\n", start);
  const line = source.slice(lineStart, lineEnd);
  const lineNumber = source.slice(0, lineStart).split("\n").length;
  const column = start - lineStart;
  const width = Math.max(1, Math.min(end, lineEnd + 1) - start);
  const gutter = " ".repeat(String(lineNumber).length);
  return [
    `error: ${title}`,
    `${gutter}--> prompt:${lineNumber}:${column + 1}`,
    `${gutter} |`,
    `${lineNumber} | ${line}`,
    `${gutter} | ${" ".repeat(column)}${"^".repeat(width)} ${label}`,
    `${gutter} |`,
    ...notes.map((note) => `${gutter} = ${note}`),
  ].join("\n");
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

  let reason = parsed.diagnostic ? renderDiagnostic(parsed.diagnostic) : USAGE;
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
