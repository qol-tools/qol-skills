#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { closest, renderDiagnostic } from "./_kit/diagnostic.mjs";
import { runCli, runPromptCommand } from "./_kit/prompt-command.mjs";

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
  "qols wake <key>",
  "qols status",
  "qols loop [key | doctor]",
  "fork: detached architect that owns the problem; bridge: lane that reports back here;",
  "test: a fork whose prompt is typed but not submitted, so the launch costs no tokens",
  "new: a fork without the chat copy; with no prompt, a blank session you type into",
  "in the switchboard, fork, bridge and new reach it as your request, and it starts a fork for them",
  "switchboard: your one control chat; always claude, effort low unless --effort says otherwise",
  "--park lets a fork close its terminal while it waits on a long command and reopen when it ends;",
  "a fork given a problem or prompt also closes once its turn ends",
  "park: toggle parking for this terminal; on, a park closes it and reopens the conversation later",
  "wake: make a session read its waiting messages now, even while parked; reopens a closed park",
  "status: one line per lane with its attention, remote control, pull requests and last message",
  "loop: the loop-gate runs of this repo, or one run by key, or the driver doctor; open, run, verdict and close run from the architect's Bash",
  "values may be [aliases] from sessions.toml; left out, sessions.toml defaults apply",
].join("\n");

const VERBS = ["fork", "bridge", "test", "new", "switchboard", "park", "wake", "status", "loop"];

const ARCHITECT_LOOP_VERBS = ["open", "run", "verdict", "close"];
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const QOL_TIMEOUT_MS = 100000;

const STALE_QOL = "qols status: this qol has no `qol sessions status`; update qol";

const SWITCHBOARD_KEY = "switchboard";
const KITTY_TIMEOUT_MS = 4000;
const SWITCHBOARD_ASKS = {
  fork: "a fork that owns the problem in their words",
  bridge: "a fork that does the task in their words and reports back to you",
  new: "a new session for their words",
};

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
  if (verb === "park") return parseBare(source, tokens, verb, "qols park only toggles");
  if (verb === "status") return parseBare(source, tokens, verb, "qols status takes nothing");
  if (verb === "wake") return parseWake(source, verbToken, tokens);
  if (verb === "loop") return parseLoop(source, verbToken, tokens);
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

function parseWake(source, verbToken, tokens) {
  if (tokens.length === 1) return { verb: "wake", key: tokens[0].text };
  const [, extra] = tokens;
  return {
    verb: "help",
    diagnostic: {
      title: tokens.length === 0 ? "`qols wake` needs a session key" : `\`qols wake\` does not take \`${extra.text}\``,
      source,
      start: tokens.length === 0 ? verbToken.end : extra.start,
      end: tokens.length === 0 ? verbToken.end + 1 : extra.end,
      label: tokens.length === 0 ? "expected a spawn key here" : "wake takes one spawn key",
      notes: [`usage: ${usageFor("wake")}`],
    },
  };
}

function parseLoop(source, verbToken, tokens) {
  const [first, ...extra] = tokens;
  if (first === undefined) return { verb: "loop", args: ["status"] };
  const word = first.text.toLowerCase();
  if (ARCHITECT_LOOP_VERBS.includes(word)) return { verb: "loop", usage: loopArchitectUsage(word) };
  const wrong = extra[0] ?? (first.text.startsWith("-") ? first : undefined);
  if (wrong !== undefined) {
    return {
      verb: "help",
      diagnostic: {
        title: `\`qols loop\` does not take \`${wrong.text}\``,
        source,
        start: wrong.start,
        end: wrong.end,
        label: extra.length > 0 ? "loop takes one key or doctor" : "a loop key is a name, not a flag",
        notes: [`usage: ${usageFor("loop")}`],
      },
    };
  }
  return { verb: "loop", args: word === "doctor" ? ["doctor"] : ["status", first.text] };
}

function loopArchitectUsage(word) {
  return `usage: ${usageFor("loop")}; ${ARCHITECT_LOOP_VERBS.join(", ")} run from the architect's Bash: node scripts/loop.mjs ${word} ...`;
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

function parseBare(source, tokens, verb, label) {
  if (tokens.length === 0) return { verb };
  const [wrong] = tokens;
  return {
    verb: "help",
    diagnostic: {
      title: `\`qols ${verb}\` does not take \`${wrong.text}\``,
      source,
      start: wrong.start,
      end: wrong.end,
      label,
      notes: [`usage: ${usageFor(verb)}`],
    },
  };
}

export function cliSessionsBinary(env = process.env, home = homedir(), exists = existsSync) {
  const config = env.XDG_CONFIG_HOME || join(home, ".config");
  const name = process.platform === "win32" ? "qol-cli-sessions.exe" : "qol-cli-sessions";
  const plugin = join(config, "qol-tray", "plugins", "qol-cli-sessions", name);
  return exists(plugin) ? plugin : null;
}

function kittenLs(argv) {
  return execFileSync("kitten", argv, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: KITTY_TIMEOUT_MS });
}

export function isSwitchboard(env = process.env, run = kittenLs) {
  const window = env.KITTY_WINDOW_ID;
  if (!window) return false;
  try {
    const windows = JSON.parse(run(["@", "ls", "--match", `id:${window}`])).flatMap((os) => os.tabs.flatMap((tab) => tab.windows));
    return windows.some((win) => String(win.id) === window && win.user_vars?.qol_session_key === SWITCHBOARD_KEY);
  } catch {
    return false;
  }
}

export function forkedBySwitchboard({ verb }, inSwitchboard = isSwitchboard) {
  return Object.hasOwn(SWITCHBOARD_ASKS, verb) && inSwitchboard();
}

export function switchboardContext({ verb, message, flags }) {
  const ask = verb === "new" && message === undefined ? "a new empty session" : SWITCHBOARD_ASKS[verb];
  const note = `[qols] \`qols ${verb}\` reached you because the switchboard starts sessions as forks, not terminals: treat it as the user asking for ${ask}, and start it as your role describes.`;
  if (flags.length === 0) return note;
  return `${note} \`--model\` and \`--effort\` set the fork's model and effort; \`--harness\` naming another tool than claude, \`--surface\` or \`--park\` ask for a terminal, so call session_fork with them.`;
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

function runBinary(bin, argv) {
  return runCli(argv[0], argv.slice(1), { bin, timeoutMs: QOL_TIMEOUT_MS });
}

function watchSession(session) {
  spawn("qol", ["sessions", "watch", session], { detached: true, stdio: "ignore" }).unref();
}

function reply(parsed, cwd) {
  if (parsed === null) return null;
  if (parsed.verb === "help") return { reason: parsed.diagnostic ? renderDiagnostic(parsed.diagnostic) : USAGE };
  if (parsed.verb === "park") return park();
  if (parsed.verb === "status") return status();
  if (parsed.verb === "wake") return wake(parsed.key);
  if (parsed.verb === "loop") return loopReply(parsed, cwd);
  if (forkedBySwitchboard(parsed)) return { context: switchboardContext(parsed) };
  return launch(parsed, cwd);
}

export function launch(parsed, cwd, run = runBinary, watch = watchSession) {
  const result = run("qol", commandFor(parsed, cwd));
  if (result.kind !== "answered") return { reason: `qols ${parsed.verb}: ${result.text}` };
  try {
    const outcome = JSON.parse(result.text);
    if (parsed.verb === "bridge") watch(outcome.session);
    return { reason: summarize(parsed.verb, outcome), sent: true };
  } catch (error) {
    return { reason: `qols ${parsed.verb}: ${error.message}` };
  }
}

export function loopCommand({ args }, cwd, root = PLUGIN_ROOT) {
  return [join(root, "scripts", "loop.mjs"), [...args, "--pretty", "--cwd", cwd]];
}

export function loopReply(parsed, cwd, run = runCli, root = PLUGIN_ROOT) {
  if (parsed.usage !== undefined) return { reason: parsed.usage };
  const [cli, argv] = loopCommand(parsed, cwd, root);
  const result = run(cli, argv, { cwd, timeoutMs: QOL_TIMEOUT_MS });
  if (result.kind !== "answered") return { reason: `qols loop: ${result.text}` };
  return { reason: result.text || "qols loop: nothing to report", sent: true };
}

export function status(run = (argv) => runBinary("qol", argv)) {
  const result = run(["sessions", "status"]);
  if (result.kind === "answered") return { reason: result.text || "qols status: no lanes", sent: true };
  if (result.text.startsWith("unknown qol sessions subcommand `status`")) return { reason: STALE_QOL };
  return { reason: `qols status: ${result.text}` };
}

export function park(binary = cliSessionsBinary(), run = runBinary) {
  if (binary === null) return { reason: "qols park: CLI Sessions is not installed in qol-tray" };
  const result = run(binary, ["parking", "toggle"]);
  if (result.kind !== "answered") return { reason: `qols park: ${result.text}` };
  return { reason: summarizePark(result.text), sent: true };
}

export function wake(key, binary = cliSessionsBinary(), run = runBinary) {
  if (binary === null) return { reason: "qols wake: CLI Sessions is not installed in qol-tray" };
  const result = run(binary, ["wake", key]);
  if (result.kind !== "answered") return { reason: `qols wake: ${result.text}` };
  return { reason: `qols wake: ${result.text}`, sent: true };
}

function main() {
  runPromptCommand({ parse: (prompt, cwd) => reply(parsePrompt(prompt), cwd), prefix: "qols", cwd: "input" });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
