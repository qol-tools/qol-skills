#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { lint, renderHelp, renderLint } from "../src/qac.mjs";

export const EXIT = { clean: 0, findings: 1, usage: 2, notRepo: 3 };

export function parseArgs(argv) {
  const flags = argv.filter(arg => arg.startsWith("--"));
  const positionals = argv.filter(arg => !arg.startsWith("--"));
  const prefix = flags.find(flag => flag.startsWith("--prefix="))?.slice("--prefix=".length) || "qac";
  const cwd = flags.find(flag => flag.startsWith("--cwd="))?.slice("--cwd=".length) || process.cwd();
  return {
    verb: (positionals[0] ?? "help").toLowerCase(),
    paths: positionals.slice(1),
    pretty: flags.includes("--pretty"),
    prefix,
    cwd,
  };
}

export function run(argv, { out = text => process.stdout.write(`${text}\n`), deps = {} } = {}) {
  const args = parseArgs(argv);
  if (args.verb === "help") {
    out(args.pretty ? renderHelp(args.prefix) : JSON.stringify({ verbs: ["lint", "help"] }));
    return EXIT.clean;
  }
  if (args.verb !== "lint") {
    out(`${args.prefix}: unknown verb "${args.verb}"\n${renderHelp(args.prefix)}`);
    return EXIT.usage;
  }
  let result;
  try {
    result = lint(args.cwd, args.paths, deps);
  } catch (error) {
    out(`${args.prefix} lint: ${args.cwd} is not inside a git repository (${error.message.split("\n")[0]})`);
    return EXIT.notRepo;
  }
  if (args.pretty) {
    out(renderLint(result, args.prefix));
  } else {
    const findings = result.findings.map(({ message, ...finding }) => finding);
    out(JSON.stringify({ ...result, findings }));
  }
  return result.findings.length === 0 ? EXIT.clean : EXIT.findings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(run(process.argv.slice(2)));
