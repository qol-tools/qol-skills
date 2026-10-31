#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { HOOKS, fixBrief, lint, renderHelp } from "../src/qac.mjs";
import { progressReporter } from "../src/progress.mjs";
import { openReport, writeReport } from "../src/report.mjs";
import { ROUTES, listSlips, recordFingerprint, recordSlip, renderSlip, renderSlips } from "../src/slips.mjs";
import { loadConfig, repoId } from "../src/gate/config.mjs";
import { GATE_EXIT, readAccept, renderGate, runGate } from "../src/gate/gate.mjs";
import { findTraps, readGates } from "../src/gate/index.mjs";
import { initConfig } from "../src/gate/init.mjs";
import { gitCommonDir } from "../src/gate/tree.mjs";
import { approveTrust, trustState } from "../src/gate/trust.mjs";

export const EXIT = { ...GATE_EXIT, forkFailed: 4 };

export const VERBS = ["lint", "fix", "slip", "slips", "gate", "trust", "traps", "init"];
export { ROUTES };

const VALUE_FLAGS = [
  "prefix", "cwd", "base", "from", "infeasible", "rules-repo",
  "out", "accept", "owned", "spec", "spec-sha", "baseline", "exclude-finding",
  "loop", "attempt", "min", "fingerprint", "entry", "judge", "rule", "message", "route",
];
const REPEATABLE_FLAGS = ["exclude-finding"];
const DEFAULT_MIN_LOOPS = 2;

export function parseArgs(argv) {
  const values = {};
  const lists = {};
  const flags = [];
  const positionals = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (!VALUE_FLAGS.includes(name)) {
      flags.push(arg);
      continue;
    }
    const value = inline !== undefined ? inline : argv[++index] ?? "";
    if (REPEATABLE_FLAGS.includes(name)) (lists[name] ??= []).push(value);
    else values[name] = value;
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
    out: values.out || null,
    accept: values.accept || null,
    owned: values.owned || null,
    spec: values.spec || null,
    specSha: values["spec-sha"] || null,
    baseline: values.baseline || null,
    excludeFindings: lists["exclude-finding"] ?? [],
    removedExcludeFlag: flags.some(flag => flag.split("=")[0] === "--exclude-fingerprint"),
    loop: values.loop || null,
    attempt: values.attempt ?? null,
    min: values.min ?? null,
    fingerprint: values.fingerprint || null,
    entry: values.entry || null,
    judge: values.judge || null,
    rule: values.rule || null,
    message: values.message || null,
    route: values.route || null,
    keep: flags.includes("--keep"),
    exclude: flags.includes("--exclude"),
  };
}

export function summaryLine(result, prefix) {
  const count = result.findings.length;
  const hooks = Object.entries(result.byHook).map(([hook, n]) => `${hook} ${n}`).join(", ");
  const tail = count === 0 ? "clean" : `${count} findings (${hooks})`;
  return `${prefix} lint: ${result.files} files, ${tail}`;
}

function fail(out, args, message, code) {
  out(args.pretty ? `${args.prefix} ${args.verb}: ${message}` : JSON.stringify({ error: message }));
  return code;
}

function integerFlag(value, fallback) {
  if (value === null) return fallback;
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function parseExcludeFindings(values) {
  const rules = [];
  for (const value of values) {
    const at = value.indexOf("=");
    if (at <= 0) return null;
    rules.push({ fingerprint: value.slice(0, at), file: value.slice(at + 1) });
  }
  return rules;
}

async function gateVerb(args, out, gateDeps) {
  if (args.removedExcludeFlag) return fail(out, args, "--exclude-fingerprint was removed; use --exclude-finding <fingerprint>=<repo-relative file>", EXIT.usage);
  const attempt = integerFlag(args.attempt, undefined);
  if (attempt === null) return fail(out, args, "--attempt must be a positive integer", EXIT.usage);
  const excludeFindings = parseExcludeFindings(args.excludeFindings);
  if (excludeFindings === null) return fail(out, args, "--exclude-finding must be <fingerprint>=<repo-relative file>", EXIT.usage);
  const result = await (gateDeps.runGate ?? runGate)({
    cwd: args.cwd,
    base: args.base || "HEAD",
    out: args.out,
    accept: args.accept,
    owned: args.owned,
    spec: args.spec,
    specSha: args.specSha,
    baseline: args.baseline,
    excludeFindings,
    loop: args.loop,
    attempt: attempt ?? null,
    keep: args.keep,
  }, gateDeps);
  if (result.gate === null) return fail(out, args, result.error, result.exit);
  const indexNote = result.indexError ? { index_error: result.indexError } : {};
  out(args.pretty
    ? `${renderGate(result.gate, args.prefix)}\ngate: ${result.path}${result.indexError ? `\nindex: ${result.indexError}` : ""}`
    : JSON.stringify({ ...result.gate, path: result.path, ...indexNote }));
  return result.exit;
}

function trustVerb(args, out, gateDeps) {
  const action = args.paths[0];
  if (action !== undefined && action !== "approve") return fail(out, args, `unknown action "${action}"; use trust or trust approve`, EXIT.usage);
  let accept;
  let loaded;
  try {
    accept = readAccept(args.accept, args.cwd, gateDeps);
  } catch (error) {
    return fail(out, args, error.message, EXIT.usage);
  }
  try {
    loaded = loadConfig({ cwd: args.cwd, base: args.base || "HEAD" }, gateDeps);
  } catch (error) {
    return fail(out, args, `${args.cwd} is not inside a git repository`, EXIT.notRepo);
  }
  if (loaded.errors.length > 0) return fail(out, args, `invalid judges config: ${loaded.errors.join("; ")}`, EXIT.findings);
  if (loaded.config === null && accept.length === 0) return fail(out, args, "no judges: run qac init", EXIT.findings);
  const input = { cwd: args.cwd, config: loaded.config, accept, repoId: loaded.repoId };
  const before = trustState(input, gateDeps);
  if (action === "approve") {
    const approved = approveTrust(input, gateDeps);
    const summary = before.untrusted.map(item => `${item.source}: ${item.argv.join(" ")}`);
    out(args.pretty
      ? `${args.prefix} trust: approved ${summary.length} commands for ${approved.repo_id}${summary.map(line => `\n  ${line}`).join("")}`
      : JSON.stringify({ ...approved, trusted: true, newly_approved: before.untrusted }));
    return EXIT.clean;
  }
  if (args.pretty) {
    const lines = before.untrusted.map(item => `\n  ${item.source}: ${item.argv.join(" ")}`);
    out(before.trusted ? `${args.prefix} trust: trusted` : `${args.prefix} trust: ${before.untrusted.length} untrusted; run ${args.prefix} trust approve${lines.join("")}`);
  } else {
    out(JSON.stringify({ trusted: before.trusted, repo_id: loaded.repoId, judges_sha: before.judges_sha, untrusted: before.untrusted }));
  }
  return before.trusted ? EXIT.clean : EXIT.findings;
}

function trapsVerb(args, out, gateDeps) {
  const min = integerFlag(args.min, DEFAULT_MIN_LOOPS);
  if (min === null) return fail(out, args, "--min must be a positive integer", EXIT.usage);
  let commonDir;
  try {
    commonDir = (gateDeps.gitCommonDir ?? gitCommonDir)(args.cwd, gateDeps);
  } catch {
    return fail(out, args, `${args.cwd} is not inside a git repository`, EXIT.notRepo);
  }
  const found = (gateDeps.findTraps ?? findTraps)(
    (gateDeps.readGates ?? readGates)(commonDir, gateDeps),
    { repoId: repoId(args.cwd, gateDeps), min },
  );
  const traps = Array.isArray(found) ? found : found.traps;
  if (!args.pretty) {
    out(JSON.stringify({ traps }));
    return EXIT.clean;
  }
  const lines = traps.map(trap => `${trap.fingerprint} ${trap.judge} ${trap.rule}: ${String(trap.message).split("\n")[0]} (${trap.loops} loops)`);
  out(traps.length === 0 ? `${args.prefix} traps: none seen in ${min} loops` : [`${args.prefix} traps: ${traps.length}`, ...lines].join("\n"));
  return EXIT.clean;
}

function initVerb(args, out, gateDeps) {
  try {
    (gateDeps.gitCommonDir ?? gitCommonDir)(args.cwd, gateDeps);
  } catch {
    return fail(out, args, `${args.cwd} is not inside a git repository`, EXIT.notRepo);
  }
  let result;
  try {
    result = (gateDeps.initConfig ?? initConfig)({ cwd: args.cwd, exclude: args.exclude, env: gateDeps.env ?? process.env }, gateDeps);
  } catch (error) {
    return fail(out, args, error.message, EXIT.usage);
  }
  const ids = (result.config?.judges ?? []).map(judge => judge.id);
  if (result.reason && !result.created) {
    out(args.pretty ? `${args.prefix} init: ${result.reason}; wrote nothing` : JSON.stringify(result));
    return EXIT.clean;
  }
  out(args.pretty
    ? `${args.prefix} init: ${result.created ? "wrote" : "kept"} ${result.path} (${ids.length} judges${ids.length ? `: ${ids.join(", ")}` : ""}); run ${args.prefix} trust approve to trust them`
    : JSON.stringify(result));
  return EXIT.clean;
}

function settleTarget({ fingerprint, entry }, ledger) {
  const matches = listSlips(ledger).filter(item => item.kind === "fingerprint" && item.fingerprint === fingerprint);
  if (entry) return matches.find(item => item.id === entry) ?? null;
  return matches.find(item => item.status === "open") ?? matches[0] ?? null;
}

function fingerprintSlip(args, out, ledger) {
  const settling = Boolean(args.added || args.infeasible);
  if (!settling && !args.from) return fail(out, args, "--fingerprint needs --from <source>", EXIT.usage);
  if (args.route && !ROUTES.includes(args.route)) return fail(out, args, `--route must be one of ${ROUTES.join(", ")}`, EXIT.usage);
  const known = settling ? settleTarget(args, ledger) : null;
  if (settling && known === null) return fail(out, args, `no ledger entry${args.entry ? ` ${args.entry}` : ""} for fingerprint ${args.fingerprint}`, EXIT.usage);
  let repo = known ? known.repo_id : null;
  if (!known) {
    try {
      repo = repoId(args.cwd, ledger);
    } catch {
      repo = null;
    }
  }
  const result = (ledger.recordFingerprint ?? recordFingerprint)({
    fingerprint: args.fingerprint,
    judge: known?.judge ?? args.judge,
    rule: known?.rule ?? args.rule,
    message: known?.message ?? args.message,
    from: args.from,
    loop: args.loop,
    route: args.route,
    repoId: repo,
    cwd: args.cwd,
    added: args.added,
    infeasible: args.infeasible,
  }, ledger);
  if (!args.pretty) {
    out(JSON.stringify(result));
  } else {
    const outcome = result.error
      ? `; ${result.error}`
      : result.forked ? "; forked a rule lane"
        : result.handover ? "; qol is not on PATH, hand this brief to a lane" : result.due ? "; due" : "";
    out(`${args.prefix} slip: fingerprint ${args.fingerprint} recorded${outcome}${result.handover && result.brief ? `\n${result.brief}` : ""}`);
  }
  return result.error ? EXIT.forkFailed : EXIT.clean;
}

export function run(argv, {
  out = text => process.stdout.write(`${text}\n`),
  deps = {},
  ledger = {},
  gateDeps = {},
  progress = progressReporter,
  write = writeReport,
  open = openReport,
} = {}) {
  const args = parseArgs(argv);
  if (args.verb === "help") {
    out(args.pretty ? renderHelp(args.prefix) : JSON.stringify({ verbs: VERBS, exit: EXIT }));
    return EXIT.clean;
  }
  if (args.verb === "gate") return gateVerb(args, out, gateDeps);
  if (args.verb === "trust") return trustVerb(args, out, gateDeps);
  if (args.verb === "traps") return trapsVerb(args, out, gateDeps);
  if (args.verb === "init") return initVerb(args, out, gateDeps);
  if (args.verb === "slips") {
    const slips = listSlips(ledger);
    out(args.pretty ? renderSlips(slips, args.prefix) : JSON.stringify({ slips }));
    return EXIT.clean;
  }
  if (args.verb === "slip" && args.fingerprint) return fingerprintSlip(args, out, ledger);
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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  Promise.resolve()
    .then(() => run(process.argv.slice(2)))
    .then(code => process.exit(code))
    .catch(error => {
      process.stdout.write(`${JSON.stringify({ error: String(error?.message ?? error).split("\n")[0] })}\n`);
      process.exit(EXIT.couldNotJudge);
    });
}
