#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { closest, renderDiagnostic } from "./_kit/diagnostic.mjs";
import { runPromptCommand } from "./_kit/prompt-command.mjs";

export { renderDiagnostic };

const FLAGS = { harness: "--tool", model: "--model", effort: "--effort", surface: "--surface" };
const SWITCHES = { park: "--park" };

const USAGE = [
  "qols fork <problem> [--harness H] [--model M] [--effort E] [--surface S] [--park]",
  "qols bridge <task> [--harness H] [--model M] [--effort E] [--surface S]",
  "qols test <problem> [--harness H] [--model M] [--effort E] [--surface S]",
  "qols new [prompt] [--harness H] [--model M] [--effort E] [--surface S] [--park]",
  "qols switchboard [--model M] [--effort E] [--surface S]",
  "qols park",
  "fork: detached architect that owns the problem; bridge: lane that reports back here;",
  "test: a fork whose prompt is typed but not submitted, so the launch costs no tokens",
  "new: a fork without the chat copy; with no prompt, a blank session you type into",
  "switchboard: your one control chat; always claude, effort low unless --effort says otherwise",
  "--park lets a fork close its terminal while it waits on a long command and reopen when it ends",
  "park: toggle parking for this terminal; on, a park closes it and reopens the conversation later",
  "values may be [aliases] from sessions.toml; left out, sessions.toml defaults apply",
].join("\n");

const VERBS = ["fork", "bridge", "test", "new", "switchboard", "park"];

function usageFor(verb) {
  return USAGE.split("\n").find((line) => line === `qols ${verb}` || line.startsWith(`qols ${verb} `));
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
  if (verb === "park") return parsePark(source, tokens);
  const flags = [];
  while (tokens.length >= 1) {
    const last = tokens.at(-1).text;
    if (verb !== "bridge" && last.startsWith("--") && Object.hasOwn(SWITCHES, last.slice(2))) {
      if (verb === "switchboard") return refuse(source, tokens.at(-1), verb, "the switchboard does not park");
      tokens.pop();
      flags.unshift(SWITCHES[last.slice(2)]);
      continue;
    }
    if (tokens.length < 2 || !tokens.at(-2).text.startsWith("--")) break;
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
    if (verb === "switchboard" && name === "harness") {
      return refuse(source, flag, verb, "the switchboard always runs claude");
    }
    const value = tokens.pop();
    tokens.pop();
    flags.unshift(FLAGS[name], value.text);
  }
  if (verb === "new") return tokens.length === 0 ? { verb, flags } : { verb, message: tokens.map((t) => t.text).join(" "), flags };
  if (verb === "switchboard") return parseTaskless(source, tokens, verb, flags);
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

function parseTaskless(source, tokens, verb, flags) {
  if (tokens.length === 0) return { verb, flags };
  const [wrong] = tokens;
  return {
    verb: "help",
    diagnostic: {
      title: `\`qols ${verb}\` takes no task`,
      source,
      start: wrong.start,
      end: wrong.end,
      label: "expected only flags here",
      notes: [`usage: ${usageFor(verb)}`],
    },
  };
}

function refuse(source, token, verb, label) {
  return {
    verb: "help",
    diagnostic: {
      title: `\`qols ${verb}\` does not take \`${token.text}\``,
      source,
      start: token.start,
      end: token.end,
      label,
      notes: [`usage: ${usageFor(verb)}`],
    },
  };
}

function parsePark(source, tokens) {
  if (tokens.length === 0) return { verb: "park" };
  const [wrong] = tokens;
  return {
    verb: "help",
    diagnostic: {
      title: `\`qols park\` does not take \`${wrong.text}\``,
      source,
      start: wrong.start,
      end: wrong.end,
      label: "qols park only toggles",
      notes: [`usage: ${usageFor("park")}`],
    },
  };
}

export function cliSessionsBinary(env = process.env, home = homedir(), exists = existsSync) {
  const config = env.XDG_CONFIG_HOME || join(home, ".config");
  const name = process.platform === "win32" ? "qol-cli-sessions.exe" : "qol-cli-sessions";
  const plugin = join(config, "qol-tray", "plugins", "qol-cli-sessions", name);
  return exists(plugin) ? plugin : null;
}

export function summarizePark(state) {
  return state === "parking on"
    ? "qols park: on; a park closes this terminal and reopens the conversation when the wait ends"
    : "qols park: off; a park keeps this terminal open and submits the result here";
}

export function commandFor({ verb, message, flags }, cwd) {
  if (verb === "fork") return ["sessions", "fork", "--cwd", cwd, "--brief", message, ...flags];
  if (verb === "test") return ["sessions", "fork", "--cwd", cwd, "--brief", message, "--dry-run", ...flags];
  if (verb === "new" && message !== undefined) return ["sessions", "fork", "--cwd", cwd, "--brief", message, "--no-chat", ...flags];
  if (verb === "new") return ["sessions", "fork", "--cwd", cwd, "--blank", ...flags];
  if (verb === "switchboard") return ["sessions", "switchboard", ...flags];
  return ["sessions", "spawn", "--cwd", cwd, "--task", message, "--background", ...flags];
}

export function summarize(verb, outcome) {
  const launch = [outcome.tool, outcome.model, outcome.effort, outcome.surface].filter(Boolean).join(" ");
  if (verb === "fork") return `qols fork: ${outcome.key} (${launch})`;
  if (verb === "test") return `qols test: ${outcome.key} (${launch}); the prompt is typed but not submitted`;
  if (verb === "new") return `qols new: ${outcome.key} (${launch})`;
  if (verb === "switchboard" && outcome.opened === "focused") return `qols switchboard: focused ${outcome.session}`;
  if (verb === "switchboard" && outcome.opened === "started_kitty") return `qols switchboard: started ${outcome.program} for it`;
  if (verb === "switchboard") return `qols switchboard: ${outcome.session} (${launch})`;
  return `qols bridge: ${outcome.key} (${launch}); its report arrives here as the next prompt`;
}

function reply(parsed, cwd) {
  if (parsed === null) return null;
  if (parsed.verb === "help") return { reason: parsed.diagnostic ? renderDiagnostic(parsed.diagnostic) : USAGE };
  if (parsed.verb === "park") return park();
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

function park() {
  const binary = cliSessionsBinary();
  if (binary === null) return { reason: "qols park: CLI Sessions is not installed in qol-tray" };
  try {
    const state = execFileSync(binary, ["parking", "toggle"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    return { reason: summarizePark(state), sent: true };
  } catch (error) {
    return { reason: `qols park: ${`${error.stderr ?? ""}`.trim() || error.message}` };
  }
}

function main() {
  runPromptCommand({ parse: (prompt, cwd) => reply(parsePrompt(prompt), cwd), prefix: "qols", cwd: "input" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
