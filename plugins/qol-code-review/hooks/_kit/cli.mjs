// @generated hook-kit cli.mjs sha256:e5851dda72e297b87c164d627ab90df9b59d49238c0859693f9093f59f58d255 - do not edit; change qol-skills/kit-src/hook-kit, then run its scripts/vendor-hook-kit.mjs
import { readFileSync } from "node:fs";
import path from "node:path";

import { closest } from "./diagnostic.mjs";

export const EXIT_USAGE = 2;
export const EXIT_CHECK_FAILED = 3;
export const MIN_NODE_MAJOR = 18;

const RESERVED_COMMANDS = new Set(["help", "doctor", "version"]);
const RESERVED_FLAGS = new Set(["--json", "--pretty", "--prefix", "--help", "-h"]);
const COMMAND_NAME = /^[a-z][a-z0-9_-]*$/;
const FLAG_NAME = /^--[a-z][a-z0-9-]*$/;
const ROW_WIDTH = 18;

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
    this.node = null;
  }
}

export class CliError extends Error {
  constructor(code, message = "", { result } = {}) {
    super(message);
    if (!Number.isInteger(code) || code < EXIT_CHECK_FAILED) {
      throw new RangeError(`CliError code must be an integer of 3 or more, got ${code}`);
    }
    this.name = "CliError";
    this.code = code;
    this.result = result;
  }
}

export const ok = (message) => ({ status: "ok", message, fix: null });
export const warn = (message, fix = null) => ({ status: "warn", message, fix });
export const fail = (message, fix = null) => ({ status: "fail", message, fix });

function list(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function camel(flag) {
  return flag.replace(/^-+/, "").replace(/-([a-z0-9])/g, (_, char) => char.toUpperCase());
}

function row(name, about) {
  return about ? `  ${name.padEnd(ROW_WIDTH)} ${about}` : `  ${name}`;
}

function invalid(message) {
  return new Error(`invalid cli spec: ${message}`);
}

function normalizeFlags(owner, flags = {}) {
  const byName = new Map();
  for (const [name, def = {}] of Object.entries(flags)) {
    if (!FLAG_NAME.test(name) || RESERVED_FLAGS.has(name)) throw invalid(`${owner} declares flag "${name}", which is not a --lower-case name or is reserved`);
    if (def.short !== undefined && (!/^-[a-zA-Z]$/.test(def.short) || RESERVED_FLAGS.has(def.short))) {
      throw invalid(`${owner} flag ${name} has the bad short form "${def.short}"`);
    }
    const value = def.value === undefined || def.value === false ? null : def.value === true ? "value" : String(def.value);
    byName.set(name, {
      name,
      key: camel(name),
      short: def.short ?? null,
      value,
      about: def.about ?? "",
      multiple: def.multiple === true,
      required: def.required === true,
    });
  }
  const shorts = [...byName.values()].filter((flag) => flag.short !== null);
  for (const flag of shorts) byName.set(flag.short, flag);
  return byName;
}

function normalizePositionals(owner, value) {
  if (value === undefined) return { min: 0, max: 0 };
  const spec = typeof value === "number" ? { min: value, max: value } : { min: value.min ?? 0, max: value.max ?? value.min ?? 0 };
  if (!(spec.min >= 0) || !(spec.max >= spec.min)) throw invalid(`${owner} has bad positional limits`);
  return spec;
}

function buildNode(def, parentPath) {
  if (typeof def.name !== "string" || !COMMAND_NAME.test(def.name)) throw invalid(`command name "${def.name}" must match ${COMMAND_NAME}`);
  const nodePath = [...parentPath, def.name];
  const owner = `command "${nodePath.join(" ")}"`;
  const exits = {};
  for (const [code, about] of Object.entries(def.exits ?? {})) {
    if (!Number.isInteger(Number(code)) || Number(code) < EXIT_CHECK_FAILED) throw invalid(`${owner} declares exit code ${code}; declared codes are 3 and up`);
    exits[Number(code)] = String(about);
  }
  const children = (def.commands ?? []).map((child) => buildNode(child, nodePath));
  const names = children.map((child) => child.name);
  if (new Set(names).size !== names.length) throw invalid(`${owner} has two subcommands with one name`);
  const flags = normalizeFlags(owner, def.flags);
  const node = {
    name: def.name,
    path: nodePath,
    about: def.about ?? "",
    usage: list(def.usage),
    details: list(def.details),
    output: list(def.output),
    exits,
    flags,
    positionals: normalizePositionals(owner, def.positionals),
    json: def.json === true,
    run: def.run,
    pretty: def.pretty,
    children,
  };
  if (typeof def.about !== "string" || def.about === "") throw invalid(`${owner} needs an about line`);
  if (node.run === undefined && children.length === 0) throw invalid(`${owner} needs a run function or subcommands`);
  if (node.run !== undefined && typeof node.run !== "function") throw invalid(`${owner} run must be a function`);
  if (flags.size > 0 || node.positionals.max > 0) {
    const usage = node.usage.join("\n");
    if (usage === "") throw invalid(`${owner} accepts flags or arguments, so it needs a usage line`);
    for (const flag of flags.values()) {
      if (!usage.includes(flag.name)) throw invalid(`${owner} usage does not mention ${flag.name}; help must list every flag the parser accepts`);
    }
  }
  return node;
}

function doctorNodes(spec) {
  const builtin = [
    { id: "node_version", about: "Node.js is new enough for this CLI." },
    { id: "plugin_json", about: "The plugin's .claude-plugin/plugin.json is readable and names a version." },
  ];
  const own = spec.checks ?? [];
  const ids = [...builtin.map((check) => check.id), ...own.map((check) => check.id)];
  for (const check of own) {
    if (typeof check.id !== "string" || !COMMAND_NAME.test(check.id)) throw invalid(`doctor check id "${check.id}" must match ${COMMAND_NAME}`);
    if (typeof check.run !== "function" || typeof check.about !== "string" || check.about === "") throw invalid(`doctor check "${check.id}" needs about and run`);
  }
  if (new Set(ids).size !== ids.length) throw invalid("two doctor checks share one id, or one reuses node_version or plugin_json");
  const shape = "{plugin_id, status, checks: [{id, status, message, fix}]}; status is ok, warn or fail.";
  const children = [...builtin, ...own].map((check) => ({
    name: check.id,
    path: ["doctor", check.id],
    about: check.about,
    usage: [],
    details: list(check.details),
    output: [`The doctor report with this one check: ${shape} --pretty prints its row.`],
    exits: { [EXIT_CHECK_FAILED]: "The check failed." },
    flags: new Map(),
    positionals: { min: 0, max: 0 },
    json: true,
    children: [],
    builtin: true,
  }));
  return {
    name: "doctor",
    path: ["doctor"],
    about: "Run read-only health checks.",
    usage: ["[<check-id>]"],
    details: [
      "Runs every check, or only the named one. A check reports ok, warn or fail with a message and, when one exists, the command that repairs it.",
      "Never changes anything: a repair is its own command, named in the failing check's fix.",
    ],
    output: [`${shape} --pretty prints one row per check.`],
    exits: { [EXIT_CHECK_FAILED]: "A check failed (a warning still exits 0)." },
    flags: new Map(),
    positionals: { min: 0, max: 0 },
    json: true,
    children,
    builtin: true,
    isDoctor: true,
  };
}

function versionNode() {
  return {
    name: "version",
    path: ["version"],
    about: "Print the plugin version.",
    usage: [],
    details: ["Reads the version from the plugin's .claude-plugin/plugin.json."],
    output: ["{plugin_id, version}; --pretty prints `<name> <version>`."],
    exits: {},
    flags: new Map(),
    positionals: { min: 0, max: 0 },
    json: true,
    children: [],
    builtin: true,
    isVersion: true,
  };
}

function buildTree(spec) {
  if (spec === null || typeof spec !== "object") throw invalid("the spec must be an object");
  for (const key of ["name", "about", "root"]) {
    if (typeof spec[key] !== "string" || spec[key] === "") throw invalid(`spec.${key} must be a non-empty string`);
  }
  const commands = (spec.commands ?? []).map((def) => buildNode(def, []));
  const names = commands.map((command) => command.name);
  if (new Set(names).size !== names.length) throw invalid("two commands share one name");
  for (const name of names) if (RESERVED_COMMANDS.has(name)) throw invalid(`"${name}" is built in; the kit provides it`);
  const doctor = doctorNodes(spec);
  const root = {
    name: spec.name,
    path: [],
    about: spec.about,
    children: [...commands, doctor, versionNode()],
    isRoot: true,
    defaultPath: null,
  };
  if (spec.defaultCommand !== undefined) {
    const words = Array.isArray(spec.defaultCommand) ? spec.defaultCommand : String(spec.defaultCommand).split(/\s+/);
    let node = root;
    for (const word of words) node = node.children.find((child) => child.name === word) ?? invalid(`defaultCommand "${words.join(" ")}" names no command`);
    if (node instanceof Error) throw node;
    if (node.run === undefined) throw invalid(`defaultCommand "${words.join(" ")}" has no run function`);
    root.defaultPath = words;
  }
  return root;
}

function extractGlobals(argv) {
  const globals = { json: false, pretty: false, help: false, prefix: null, bad: null, rest: [] };
  let literal = false;
  for (const token of argv) {
    if (literal) globals.rest.push(token);
    else if (token === "--") {
      literal = true;
      globals.rest.push(token);
    } else if (token === "--json") globals.json = true;
    else if (token === "--pretty") globals.pretty = true;
    else if (token === "--help" || token === "-h") globals.help = true;
    else if (token.startsWith("--prefix=")) {
      const value = token.slice("--prefix=".length);
      if (value.trim() === "") globals.bad = "`--prefix` needs a name: --prefix=<name>";
      else globals.prefix = value;
    } else if (token === "--prefix") globals.bad = "`--prefix` takes its name after an equals sign: --prefix=<name>";
    else globals.rest.push(token);
  }
  return globals;
}

function readPlugin(root) {
  const file = path.join(root, ".claude-plugin", "plugin.json");
  try {
    return { file, json: JSON.parse(readFileSync(file, "utf8")), error: null };
  } catch (error) {
    return { file, json: null, error: error.message };
  }
}

function fullName(env, node) {
  return [env.name, ...node.path].join(" ");
}

function usageForms(env, node) {
  if (node.isRoot) return [`${env.name} <command> [args]`];
  const tails = node.usage.length > 0 ? node.usage : [node.children.length > 0 && node.run === undefined ? "<subcommand>" : ""];
  return tails.map((tail) => [fullName(env, node), tail].filter(Boolean).join(" "));
}

function exitRows(node) {
  const rows = [[EXIT_USAGE, "Usage error: an unknown command or flag, a missing argument, a misplaced `help`."]];
  for (const [code, about] of Object.entries(node.exits)) rows.push([Number(code), about]);
  return rows;
}

function ensureNewline(text) {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function generalHelp(env) {
  const { root } = env;
  const rows = [
    ...root.children.map((child) => [child.name, child.about]),
    ["help", "Show help for the CLI or one command."],
  ].sort((a, b) => a[0].localeCompare(b[0]));
  const lines = [
    env.name,
    "",
    root.about,
    "",
    "Usage:",
    `  ${env.name} <command> [args]`,
    `  ${env.name} help <command>`,
    `  ${env.name} <command> help`,
  ];
  if (root.defaultPath) lines.push(`  ${env.name}  # runs ${root.defaultPath.join(" ")}`);
  lines.push("", "Commands:", ...rows.map(([name, about]) => row(name, about)));
  lines.push(
    "",
    "Global flags:",
    row("--json", "Print the result as one JSON object, the default for commands that support it."),
    row("--pretty", "Print the result as human text instead of JSON."),
    row("--prefix=<name>", `Show <name> in help and hints in place of ${env.root.name}.`),
    row("-h, --help", "Same as help."),
  );
  return ensureNewline(lines.join("\n"));
}

function commandHelp(env, node) {
  const full = fullName(env, node);
  const lines = [full];
  if (node.about) lines.push("", node.about);
  lines.push("", "Usage:", ...usageForms(env, node).map((form) => `  ${form}`));
  lines.push(`  ${full} help`, `  ${env.name} help ${node.path.join(" ")}`);
  if (node.details.length > 0) lines.push("", "Details:", ...node.details.map((line) => `  ${line}`));
  lines.push("", "Output:");
  if (node.output.length > 0) lines.push(...node.output.map((line) => `  ${line}`));
  else lines.push(node.json ? "  One JSON object on stdout; --pretty prints human text." : "  Plain-text stdout; diagnostics on stderr.");
  lines.push(node.json ? "  Supports --json." : "  Does not support --json: it exits 2.");
  lines.push("", "Exit:", ...exitRows(node).map(([code, about]) => `  ${code}  ${about}`));
  if (node.children.length > 0) lines.push("", "Subcommands:", ...node.children.map((child) => row(child.name, child.about)));
  return ensureNewline(lines.join("\n"));
}

function flagJson(flag) {
  return { name: flag.name, short: flag.short, value: flag.value, about: flag.about };
}

function nodeJson(env, node) {
  if (node.isRoot) {
    return {
      name: env.name,
      about: node.about,
      default: node.defaultPath ? node.defaultPath.join(" ") : null,
      usage: [`${env.name} <command> [args]`, `${env.name} help <command>`, `${env.name} <command> help`],
      flags: [
        { name: "--json", short: null, value: null, about: "Print the result as one JSON object." },
        { name: "--pretty", short: null, value: null, about: "Print the result as human text." },
        { name: "--prefix", short: null, value: "name", about: "Show <name> in help and hints." },
        { name: "--help", short: "-h", value: null, about: "Same as help." },
      ],
      commands: node.children.map((child) => nodeJson(env, child)),
    };
  }
  return {
    name: node.name,
    path: node.path,
    about: node.about,
    usage: usageForms(env, node),
    json: node.json,
    exits: exitRows(node).map(([code, about]) => ({ code, about })),
    flags: [...new Set(node.flags.values())].map(flagJson),
    commands: node.children.map((child) => nodeJson(env, child)),
  };
}

function suggestion(word, options) {
  const best = closest(word, options);
  return best === null ? "" : `; did you mean \`${best}\`?`;
}

function unknownCommand(env, node, word) {
  if (node.children.length === 0) return new UsageError(`\`${fullName(env, node)}\` takes no subcommands, got \`${word}\``);
  const options = node.children.map((child) => child.name);
  if (node.isRoot) return new UsageError(`unknown command \`${word}\`${suggestion(word, [...options, "help"])}`);
  return new UsageError(`unknown subcommand \`${word}\` of \`${fullName(env, node)}\`${suggestion(word, options)}; it has ${options.join(", ")}`);
}

function helpMisplaced(env, words) {
  if (words.length === 0) {
    return new UsageError(`\`help\` takes a command name, not another \`help\`: run \`${env.name} help <command>\`, or \`${env.name} help\` for the commands`);
  }
  const joined = words.join(" ");
  return new UsageError(`\`help\` goes first or last, never in the middle: run \`${env.name} help ${joined}\` or \`${env.name} ${joined} help\``);
}

function takeFlag(env, state, tokens, index) {
  const token = tokens[index];
  const equals = token.startsWith("--") ? token.indexOf("=") : -1;
  const name = equals === -1 ? token : token.slice(0, equals);
  const flag = state.node.flags.get(name);
  if (flag === undefined) {
    const options = [...state.node.flags.keys()].filter((key) => key.startsWith("--"));
    const here = state.node.isRoot ? env.name : fullName(env, state.node);
    throw new UsageError(`unknown flag \`${name}\` for \`${here}\`${suggestion(name, options)}`);
  }
  let value = true;
  let next = index;
  if (flag.value !== null) {
    if (equals !== -1) value = token.slice(equals + 1);
    else if (tokens[index + 1] !== undefined && !tokens[index + 1].startsWith("--")) {
      next = index + 1;
      value = tokens[next];
    } else value = "";
    if (value === "") throw new UsageError(`\`${flag.name}\` needs a value: ${flag.name} <${flag.value}>`);
  } else if (equals !== -1) throw new UsageError(`\`${flag.name}\` takes no value`);
  if (flag.multiple) state.flags[flag.key] = [...(state.flags[flag.key] ?? []), value];
  else state.flags[flag.key] = value;
  return next;
}

function tokenIsFlag(token) {
  return token.startsWith("-") && token !== "-";
}

function showHelp(env, node, json) {
  env.stdout.write(json ? `${JSON.stringify(nodeJson(env, node))}\n` : node.isRoot ? generalHelp(env) : commandHelp(env, node));
  return 0;
}

function showTopicHelp(env, topic, json) {
  const words = topic.filter((word) => !tokenIsFlag(word));
  let node = env.root;
  env.current = node;
  for (const word of words) {
    if (word === "help") throw helpMisplaced(env, words.filter((other) => other !== "help"));
    const child = node.children.find((candidate) => candidate.name === word);
    if (child === undefined) throw unknownCommand(env, node, word);
    node = child;
    env.current = node;
  }
  return showHelp(env, node, json);
}

function pluginSummary(env) {
  const plugin = readPlugin(env.spec.root);
  const id = env.spec.pluginId ?? (typeof plugin.json?.name === "string" ? plugin.json.name : env.spec.name);
  return { plugin, id };
}

function contextFor(env, node, args, flags) {
  return {
    name: env.name,
    cli: env.spec.name,
    path: node.path,
    args,
    flags,
    json: env.json,
    pretty: env.pretty,
    cwd: env.cwd,
    env: env.environ,
    stdout: env.stdout,
    stderr: env.stderr,
    root: env.spec.root,
  };
}

async function builtinCheck(env, id) {
  const { plugin } = pluginSummary(env);
  if (id === "node_version") {
    const wanted = env.spec.node ?? MIN_NODE_MAJOR;
    const major = Number(env.nodeVersion.split(".")[0]);
    return major >= wanted ? ok(`Node ${env.nodeVersion} (needs ${wanted} or newer)`) : fail(`Node ${env.nodeVersion} is older than ${wanted}`, `Install Node ${wanted} or newer.`);
  }
  if (plugin.error !== null) return fail(`${plugin.file} is not readable JSON: ${plugin.error}`, "Restore .claude-plugin/plugin.json in the plugin.");
  if (typeof plugin.json.name !== "string" || typeof plugin.json.version !== "string") {
    return fail(`${plugin.file} needs a string name and a string version`, "Add the missing keys to .claude-plugin/plugin.json.");
  }
  return ok(`${plugin.json.name} ${plugin.json.version}`);
}

async function runDoctor(env, node, ids) {
  const own = new Map((env.spec.checks ?? []).map((check) => [check.id, check]));
  const checks = [];
  for (const check of node.children) {
    if (ids.length > 0 && !ids.includes(check.name)) continue;
    let outcome;
    try {
      outcome = own.has(check.name) ? await own.get(check.name).run(contextFor(env, check, [], {})) : await builtinCheck(env, check.name);
    } catch (error) {
      outcome = fail(`the check threw: ${error?.message ?? error}`);
    }
    const status = ["ok", "warn", "fail"].includes(outcome?.status) ? outcome.status : "fail";
    const message = status === outcome?.status ? String(outcome.message ?? "") : `the check returned no valid status: ${JSON.stringify(outcome)}`;
    checks.push({ id: check.name, status, message, fix: outcome?.fix ?? null });
  }
  const status = checks.some((check) => check.status === "fail") ? "fail" : checks.some((check) => check.status === "warn") ? "warn" : "ok";
  const report = { plugin_id: pluginSummary(env).id, status, checks };
  if (status === "fail") throw new CliError(EXIT_CHECK_FAILED, "", { result: report });
  return report;
}

function doctorRows(report) {
  const idWidth = Math.max(...report.checks.map((check) => check.id.length));
  return report.checks
    .map((check) => `${check.status.padEnd(4)}  ${check.id.padEnd(idWidth)}  ${check.message}${check.fix ? `  (fix: ${check.fix})` : ""}`)
    .join("\n");
}

function emit(env, node, result, ctx) {
  if (node.json) {
    const text = env.pretty ? renderPretty(env, node, result, ctx) : JSON.stringify(result ?? {});
    env.stdout.write(ensureNewline(text));
    return;
  }
  if (result === undefined || result === null) return;
  if (typeof result !== "string") throw new TypeError(`text-only command "${node.path.join(" ")}" must return a string or nothing, got ${typeof result}`);
  env.stdout.write(ensureNewline(result));
}

function renderPretty(env, node, result, ctx) {
  if (node.path[0] === "doctor") return doctorRows(result);
  if (node.isVersion) return `${env.name} ${result.version}`;
  if (typeof node.pretty === "function") return String(node.pretty(result, ctx));
  return JSON.stringify(result ?? {});
}

async function execute(env, globals) {
  const { root } = env;
  env.current = root;
  if (globals.bad) throw new UsageError(globals.bad);
  if (globals.json && globals.pretty) throw new UsageError("`--json` and `--pretty` cannot be combined: pick one");
  let tokens = globals.rest;
  if (tokens.length === 0 || tokenIsFlag(tokens[0])) {
    if (tokens.length > 0 && tokens[0] !== "--" && root.defaultPath === null) {
      throw new UsageError(`unknown flag \`${tokens[0].split("=")[0]}\` for \`${env.name}\`; flags go after a command`);
    }
    if (root.defaultPath !== null && !globals.help) tokens = [...root.defaultPath, ...tokens];
    else if (tokens.length === 0) return showHelp(env, root, globals.json);
  }
  if (tokens[0] === "help") return showTopicHelp(env, tokens.slice(1), globals.json);

  const state = { node: root, flags: {}, args: [] };
  let literal = false;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!literal && token === "--") {
      literal = true;
      continue;
    }
    if (!literal && tokenIsFlag(token)) {
      if (!globals.help) index = takeFlag(env, state, tokens, index);
      continue;
    }
    if (state.args.length === 0 && !literal) {
      const child = state.node.children.find((candidate) => candidate.name === token);
      if (child !== undefined) {
        state.node = child;
        env.current = child;
        continue;
      }
      if (token === "help") {
        const after = tokens.slice(index + 1).filter((word) => !tokenIsFlag(word));
        if (after.length > 0) throw helpMisplaced(env, [...state.node.path, ...after]);
        return showHelp(env, state.node, globals.json);
      }
      const open = state.node.children.length > 0 && !state.node.isRoot && state.node.run !== undefined && state.node.positionals.max > 0;
      if (state.node.children.length > 0 && !open) throw unknownCommand(env, state.node, token);
    }
    state.args.push(token);
  }

  const { node } = state;
  if (globals.help) return showHelp(env, node, globals.json);
  if (node.isRoot) return showHelp(env, node, globals.json);
  if (globals.json && !node.json) throw new UsageError(`\`${fullName(env, node)}\` is text-only and does not support \`--json\``);
  if (node.run === undefined && !node.builtin) {
    throw new UsageError(`\`${fullName(env, node)}\` needs a subcommand: ${node.children.map((child) => child.name).join(", ")}`);
  }
  for (const flag of new Set(node.flags.values())) {
    if (flag.required && state.flags[flag.key] === undefined) throw new UsageError(`missing required flag \`${flag.name}\``);
  }
  const { min, max } = node.positionals;
  if (state.args.length < min) throw new UsageError(`\`${fullName(env, node)}\` needs ${min === max ? min : `at least ${min}`} argument${min === 1 ? "" : "s"}, got ${state.args.length}`);
  if (state.args.length > max) throw new UsageError(`unexpected argument \`${state.args[max]}\` for \`${fullName(env, node)}\``);

  const ctx = contextFor(env, node, state.args, state.flags);
  let result;
  try {
    if (node.isVersion) {
      const { plugin, id } = pluginSummary(env);
      if (plugin.error !== null) throw new Error(`cannot read ${plugin.file}: ${plugin.error}`);
      result = { plugin_id: id, version: plugin.json.version };
    } else if (node.isDoctor) result = await runDoctor(env, node, []);
    else if (node.path[0] === "doctor") result = await runDoctor(env, env.root.children.find((child) => child.isDoctor), [node.name]);
    else result = await node.run(ctx);
  } catch (error) {
    if (error instanceof CliError) {
      if (!node.isDoctor && node.path[0] !== "doctor" && node.exits[error.code] === undefined) {
        throw new Error(`${fullName(env, node)} exited with undeclared code ${error.code}; add it to the command's exits (${error.message})`);
      }
      if (error.result !== undefined) emit(env, node, error.result, ctx);
      if (error.message) env.stderr.write(`${env.name}: ${error.message}\n`);
      return error.code;
    }
    throw error;
  }
  emit(env, node, result, ctx);
  return 0;
}

function usageText(env, error) {
  const node = error.node ?? env.current ?? env.root;
  const forms = usageForms(env, node);
  const lines = [`${env.name}: ${error.message}`];
  forms.forEach((form, index) => lines.push(`${index === 0 ? "Usage: " : "       "}${form}`));
  lines.push(node.isRoot ? `Run \`${env.name} help\` for the commands.` : `Run \`${fullName(env, node)} help\` for details.`);
  return `${lines.join("\n")}\n`;
}

export async function cliMain(spec, io = {}) {
  const {
    argv = process.argv.slice(2),
    stdout = process.stdout,
    stderr = process.stderr,
    cwd = process.cwd(),
    environ = process.env,
    nodeVersion = process.versions.node,
  } = io;
  const label = spec?.name ?? "cli";
  try {
    const root = buildTree(spec);
    const globals = extractGlobals(argv);
    const env = {
      spec,
      root,
      name: globals.prefix ?? spec.name,
      cwd,
      environ,
      stdout,
      stderr,
      nodeVersion,
      json: globals.json,
      pretty: globals.pretty,
      current: root,
    };
    try {
      return await execute(env, globals);
    } catch (error) {
      if (!(error instanceof UsageError)) throw error;
      stderr.write(usageText(env, error));
      return EXIT_USAGE;
    }
  } catch (error) {
    stderr.write(`${label}: ${error?.stack ?? error}\n`);
    return 1;
  }
}
