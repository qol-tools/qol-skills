#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { HOOKS, fixBrief, lint, renderHelp } from "../src/qac.mjs";
import { progressReporter } from "../src/progress.mjs";
import { openReport, writeReport } from "../src/report.mjs";
import { listSlips, recordSlip, renderSlip, renderSlips } from "../src/slips.mjs";

export const EXIT = { clean: 0, findings: 1, usage: 2, notRepo: 3, forkFailed: 4 };

const VALUE_FLAGS = ["prefix", "cwd", "base", "from", "infeasible", "rules-repo"];

export function parseArgs(argv) {
  const values = {};
  const flags = [];
  const positionals = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (!VALUE_FLAGS.includes(name)) flags.push(arg);
    else if (inline !== undefined) values[name] = inline;
    else values[name] = argv[++index] ?? "";
  }
  return {
    verb: (positionals[0] ?? "help").toLowerCase(),
    paths: positionals.slice(1),
    pretty: flags.includes("--pretty"),
    open: flags.includes("--open"),
    added: flags.includes("--added"),
    prefix: values.prefix || "qac",
    cwd: values.cwd || process.cwd(),
    base: values.base || null,
    from: values.from || null,
    infeasible: values.infeasible || null,
    rulesRepo: values["rules-repo"] || null,
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
  ledger = {},
  progress = progressReporter,
  write = writeReport,
  open = openReport,
} = {}) {
  const args = parseArgs(argv);
  if (args.verb === "help") {
    out(args.pretty ? renderHelp(args.prefix) : JSON.stringify({ verbs: ["lint", "fix", "slip", "slips"] }));
    return EXIT.clean;
  }
  if (args.verb === "slips") {
    const slips = listSlips(ledger);
    out(args.pretty ? renderSlips(slips, args.prefix) : JSON.stringify({ slips }));
    return EXIT.clean;
  }
  if (args.verb === "slip") {
    const pattern = args.paths.join(" ").trim();
    if (!/[a-z0-9]/i.test(pattern)) {
      out(`${args.prefix} slip: name the pattern qac missed\n${renderHelp(args.prefix)}`);
      return EXIT.usage;
    }
    const result = recordSlip(pattern, { ...args, cli: fileURLToPath(import.meta.url) }, ledger);
    out(args.pretty ? renderSlip(result, args.prefix) : JSON.stringify(result));
    return result.error ? EXIT.forkFailed : EXIT.clean;
  }
  if (args.verb !== "lint" && args.verb !== "fix") {
    out(`${args.prefix}: unknown verb "${args.verb}"\n${renderHelp(args.prefix)}`);
    return EXIT.usage;
  }
  const bar = progress("qac", `${args.prefix} ${args.verb}`);
  let result;
  try {
    result = lint(args.cwd, args.paths, { ...deps, base: args.base, onProgress: bar.step });
  } catch (error) {
    bar.finish("not a git repository", "bad");
    out(`${args.prefix} lint: ${args.cwd} is not inside a git repository (${error.message.split("\n")[0]})`);
    return EXIT.notRepo;
  }
  const count = result.findings.length;
  bar.finish(count === 0 ? "clean" : `${count} findings`, count === 0 ? "ok" : "warn");
  if (args.verb === "fix") {
    if (count === 0) {
      out(`${args.prefix} fix: ${result.files} files, nothing to fix`);
      return EXIT.clean;
    }
    const brief = fixBrief(result, { explicit: args.paths.length > 0, cli: fileURLToPath(import.meta.url) });
    out(args.pretty ? brief.text : JSON.stringify({ files: brief.files, count: brief.count, brief: brief.text }));
    return EXIT.findings;
  }
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
