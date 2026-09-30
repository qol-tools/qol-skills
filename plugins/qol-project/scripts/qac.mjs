#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { HOOKS, lint, renderHelp } from "../src/qac.mjs";
import { progressReporter } from "../src/progress.mjs";
import { openReport, writeReport } from "../src/report.mjs";

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
    open: flags.includes("--open"),
    prefix,
    cwd,
  };
}

export function summaryLine(result, prefix) {
  const count = result.findings.length;
  const hooks = Object.entries(result.byHook).map(([hook, n]) => `${hook} ${n}`).join(", ");
  const tail = count === 0 ? "clean" : `${count} findings (${hooks})`;
  return `${prefix} lint: ${result.files} files, ${tail}`;
}

export function run(argv, {
  out = text => process.stdout.write(`${text}\n`),
  deps = {},
  progress = progressReporter,
  write = writeReport,
  open = openReport,
} = {}) {
  const args = parseArgs(argv);
  if (args.verb === "help") {
    out(args.pretty ? renderHelp(args.prefix) : JSON.stringify({ verbs: ["lint", "help"] }));
    return EXIT.clean;
  }
  if (args.verb !== "lint") {
    out(`${args.prefix}: unknown verb "${args.verb}"\n${renderHelp(args.prefix)}`);
    return EXIT.usage;
  }
  const bar = progress("qac", `${args.prefix} lint`);
  let result;
  try {
    result = lint(args.cwd, args.paths, { ...deps, onProgress: bar.step });
  } catch (error) {
    bar.finish("not a git repository", "bad");
    out(`${args.prefix} lint: ${args.cwd} is not inside a git repository (${error.message.split("\n")[0]})`);
    return EXIT.notRepo;
  }
  const count = result.findings.length;
  bar.finish(count === 0 ? "clean" : `${count} findings`, count === 0 ? "ok" : "warn");
  const report = write(result, HOOKS.map(([hook]) => hook));
  if (args.open) open(report);
  if (args.pretty) {
    out(`${summaryLine(result, args.prefix)}\n${args.open ? "report opened: " : "report: "}${report}`);
  } else {
    const { sources, ...summary } = result;
    const findings = result.findings.map(({ message, ...finding }) => finding);
    out(JSON.stringify({ ...summary, findings, report }));
  }
  return result.findings.length === 0 ? EXIT.clean : EXIT.findings;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(run(process.argv.slice(2)));
