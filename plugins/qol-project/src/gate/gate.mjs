import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { loadConfig, normalizeConfig, normalizeJudge, sha256, writeText } from "./config.mjs";
import * as fingerprintModule from "./fingerprint.mjs";
import * as indexModule from "./index.mjs";
import { runJudge } from "./judges.mjs";
import * as setupModule from "./setup.mjs";
import * as tamperModule from "./tamper.mjs";
import * as treeModule from "./tree.mjs";
import { trustState } from "./trust.mjs";

export const GATE_EXIT = { clean: 0, findings: 1, usage: 2, notRepo: 3, couldNotJudge: 5, flakyOnly: 6 };

const VERDICT_EXIT = {
  clean: GATE_EXIT.clean,
  findings: GATE_EXIT.findings,
  could_not_judge: GATE_EXIT.couldNotJudge,
  flaky_only: GATE_EXIT.flakyOnly,
};

const LOG_LIMIT = 200 * 1024;
const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isArgv = value => Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string") && value[0] !== "";

function readJson(file, cwd, label, deps) {
  const resolved = path.resolve(cwd, file);
  let text;
  try {
    text = String((deps.read ?? readFileSync)(resolved, "utf8"));
  } catch (error) {
    throw new Error(`${label} ${file} cannot be read: ${error.message}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} ${file} is not valid JSON: ${error.message}`);
  }
}

export function readAccept(file, cwd, deps = {}) {
  if (!file) return [];
  const raw = readJson(file, cwd, "--accept", deps);
  if (!Array.isArray(raw)) throw new Error(`--accept ${file} must be a JSON array of { id, argv }`);
  const ids = new Set();
  return raw.map((item, at) => {
    if (!isObject(item) || typeof item.id !== "string" || item.id.trim() === "" || !isArgv(item.argv)) {
      throw new Error(`--accept ${file}[${at}] must be { "id": "<name>", "argv": ["<command>", ...] }`);
    }
    if (ids.has(item.id)) throw new Error(`--accept ${file}: id "${item.id}" is not unique`);
    ids.add(item.id);
    return { id: item.id, argv: item.argv };
  });
}

export function acceptJudges(accept) {
  return accept.map(item => ({
    id: `accept:${item.id}`,
    argv: item.argv,
    parser: "exit-code",
    kind: "test",
    scope: "repo",
    where: "local",
  }));
}

function readOwned(file, cwd, deps) {
  if (!file) return null;
  const raw = readJson(file, cwd, "--owned", deps);
  if (!Array.isArray(raw) || !raw.every(item => typeof item === "string")) throw new Error(`--owned ${file} must be a JSON array of globs`);
  return raw;
}

function readBaseline(file, cwd, deps) {
  if (!file) return [];
  const raw = readJson(file, cwd, "--baseline", deps);
  if (!isObject(raw) || !Array.isArray(raw.findings)) throw new Error(`--baseline ${file} is not a gate.json`);
  return raw.findings.filter(finding => finding.fingerprint).map(finding => ({ fingerprint: finding.fingerprint, output_sha: finding.output_sha ?? null }));
}

function inBaseline(baseline, finding) {
  return baseline.some(known => known.fingerprint === finding.fingerprint
    && (finding.promotable || (finding.output_sha !== undefined && known.output_sha === finding.output_sha)));
}

function readInputs(options, cwd, deps) {
  if ((options.spec && !options.specSha) || (!options.spec && options.specSha)) throw new Error("--spec and --spec-sha go together");
  return {
    accept: readAccept(options.accept, cwd, deps),
    owned: readOwned(options.owned, cwd, deps),
    baseline: readBaseline(options.baseline, cwd, deps),
  };
}

function safeName(id) {
  return id.replace(/[^\w.-]+/g, "_");
}

function modulesOf(deps) {
  return {
    tree: deps.tree ?? treeModule,
    fingerprint: deps.fingerprint ?? fingerprintModule,
    tamper: deps.tamper ?? tamperModule,
    setup: deps.setup ?? setupModule,
    index: deps.index ?? indexModule,
  };
}

function emptyGate(context) {
  return {
    schema: 1,
    repo_id: context.repoId,
    base: context.base,
    tree: context.tree,
    judges_sha: context.judgesSha,
    spec_sha: context.specSha,
    loop: context.loop,
    attempt: context.attempt,
    verdict: "could_not_judge",
    reason: null,
    changed: context.changed,
    judges: [],
    findings: [],
    tamper: [],
    omitted: [],
  };
}

function stopped(context, reason) {
  return { ...emptyGate(context), reason };
}

function omittedEntry(judge, cwd) {
  return {
    id: judge.id,
    argv: judge.argv ?? [judge.builtin],
    cwd,
    exit: null,
    duration_ms: 0,
    scope: judge.scope,
    kind: judge.kind,
    where: judge.where,
    status: "omitted",
    runs: 0,
    findings: 0,
  };
}

function promotable(judge, finding, status) {
  if (judge.id.startsWith("accept:") || status === "timeout" || finding.rule === "timeout") return false;
  return judge.builtin ? true : judge.parser !== "exit-code";
}

function describeUntrusted(untrusted) {
  const names = untrusted.map(item => `${item.source}: ${item.argv.join(" ")}`);
  return `untrusted argv: ${names.join("; ")}; run qac trust approve`;
}

async function judgeAll(judges, context, deps, m, filters) {
  const entries = [];
  const findings = [];
  const flaky = [];
  const logs = [];
  const errored = [];
  const omitted = [];
  for (const judge of judges) {
    if (judge.where === "ci") {
      entries.push(omittedEntry(judge, context.cwd));
      omitted.push(judge.id);
      continue;
    }
    const result = await (deps.runJudge ?? runJudge)(judge, {
      cwd: context.cwd,
      changed: context.changed,
      base: context.base,
      defaults: context.defaults,
    }, deps);
    logs.push({ id: judge.id, text: result.output ?? "" });
    const marked = result.findings.map(finding => {
      const canPromote = promotable(judge, finding, result.status);
      return {
        judge: judge.id,
        rule: finding.rule,
        file: finding.file ?? null,
        line: finding.line ?? null,
        message: finding.message,
        fingerprint: m.fingerprint.fingerprint(judge.id, finding.rule, finding.message),
        promotable: canPromote,
        ...(canPromote ? {} : { output_sha: sha256(fingerprintModule.normalizeMessage(result.output)) }),
      };
    });
    let kept = [];
    if (result.status === "flaky") flaky.push(...marked);
    else if (result.status === "error") errored.push(judge.id);
    else kept = marked.filter(finding => !filters.exclude.has(finding.fingerprint));
    const numbered = kept.map((finding, at) => ({
      id: `${judge.id}#${at + 1}`,
      ...finding,
      baseline: inBaseline(filters.baseline, finding),
    }));
    findings.push(...numbered);
    entries.push({
      id: judge.id,
      argv: result.argv ?? judge.argv ?? [judge.builtin],
      cwd: context.cwd,
      exit: result.exit ?? null,
      duration_ms: result.duration_ms ?? 0,
      scope: judge.scope,
      kind: judge.kind,
      where: judge.where,
      status: result.status,
      runs: result.runs ?? 1,
      findings: numbered.length,
    });
  }
  return { entries, findings, flaky, logs, errored, omitted };
}

function verdictOf({ findings, tamper, entries, errored }) {
  if (tamper.length > 0 || findings.some(finding => !finding.baseline)) return { verdict: "findings", reason: null };
  if (errored.length > 0) return { verdict: "could_not_judge", reason: `judge error: ${errored.join(", ")}` };
  const flaky = entries.filter(entry => entry.status === "flaky").map(entry => entry.id);
  if (flaky.length > 0) return { verdict: "flaky_only", reason: `flaky: ${flaky.join(", ")}` };
  return { verdict: "clean", reason: null };
}

function indexLine(gate, flaky, at) {
  const line = finding => ({
    fingerprint: finding.fingerprint,
    judge: finding.judge,
    rule: finding.rule,
    message: finding.message,
  });
  return {
    at,
    repo_id: gate.repo_id,
    loop: gate.loop,
    attempt: gate.attempt,
    tree: gate.tree,
    judges_sha: gate.judges_sha,
    verdict: gate.verdict,
    findings: [
      ...gate.findings.map(finding => ({ ...line(finding), status: finding.baseline ? "baseline" : "caught" })),
      ...flaky.map(finding => ({ ...line(finding), status: "flaky" })),
    ],
  };
}

function persist(gate, logs, out, options, deps) {
  const write = deps.write ?? writeText;
  const remove = deps.rm ?? ((target) => rmSync(target, { recursive: true, force: true }));
  if (!options.keep) remove(path.join(out, "logs"));
  for (const log of logs) {
    const text = log.text.length > LOG_LIMIT ? log.text.slice(-LOG_LIMIT) : log.text;
    write(path.join(out, "logs", `${safeName(log.id)}.log`), text);
  }
  const file = path.join(out, "gate.json");
  write(file, `${JSON.stringify(gate, null, 2)}\n`);
  return file;
}

export async function runGate(options, deps = {}) {
  const m = modulesOf(deps);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const base = options.base || "HEAD";
  let commonDir;
  try {
    commonDir = m.tree.gitCommonDir(cwd, deps);
  } catch (error) {
    return { exit: GATE_EXIT.notRepo, gate: null, path: null, error: `${cwd} is not inside a git repository (${String(error.message).split("\n")[0]})` };
  }
  let inputs;
  try {
    inputs = readInputs(options, cwd, deps);
  } catch (error) {
    return { exit: GATE_EXIT.usage, gate: null, path: null, error: error.message };
  }
  const out = path.resolve(cwd, options.out ?? path.join(commonDir, "qac", "last-gate"));
  const context = {
    cwd,
    base,
    repoId: null,
    tree: null,
    judgesSha: null,
    specSha: options.specSha ?? null,
    loop: options.loop ?? null,
    attempt: options.attempt ?? null,
    changed: [],
    defaults: undefined,
    retention: null,
  };
  const finish = (gate, logs = [], flaky = [], index = false) => {
    const file = persist(gate, logs, out, options, deps);
    let indexError = null;
    if (index) {
      try {
        m.index.appendGate(commonDir, indexLine(gate, flaky, (deps.now ?? (() => new Date().toISOString()))()), {
          ...deps,
          retentionLoops: context.retention,
        });
      } catch (error) {
        indexError = error.message;
      }
    }
    return { exit: VERDICT_EXIT[gate.verdict], gate, path: file, indexError };
  };

  let loaded;
  try {
    loaded = (deps.loadConfig ?? loadConfig)({ cwd, base }, deps);
    context.repoId = loaded.repoId;
    context.judgesSha = loaded.judgesSha;
    context.tree = m.tree.treeId(cwd, deps);
    context.changed = m.tree.changedFiles(cwd, base, deps);
  } catch (error) {
    return finish(stopped(context, `could not read the repository: ${String(error.message).split("\n")[0]}`));
  }
  if (loaded.errors.length > 0) return finish(stopped(context, `invalid judges config: ${loaded.errors.join("; ")}`));
  if (loaded.config === null) return finish(stopped(context, "no judges: run qac init"));
  const config = loaded.config.defaults ? loaded.config : normalizeConfig(loaded.config);
  context.defaults = config.defaults;
  context.retention = config.retention.loops;

  const trust = (deps.trustState ?? trustState)({ cwd, config, accept: inputs.accept, repoId: loaded.repoId }, deps);
  if (!trust.trusted) return finish(stopped(context, describeUntrusted(trust.untrusted)));

  let setup;
  try {
    setup = await m.setup.ensureSetup({ cwd, config, commonDir }, deps);
  } catch (error) {
    setup = { ran: false, ok: false, error: error.message };
  }
  if (!setup.ok) return finish(stopped(context, `setup failed: ${setup.error ?? "unknown error"}`));

  const judges = [...config.judges, ...acceptJudges(inputs.accept)].map(judge => normalizeJudge(judge, config.defaults));
  const judged = await judgeAll(judges, context, deps, m, {
    exclude: new Set(options.excludeFingerprints ?? []),
    baseline: inputs.baseline,
  });

  let tamper;
  try {
    tamper = await m.tamper.tamperChecks({
      cwd,
      base,
      config,
      owned: inputs.owned,
      specPath: options.spec ? path.resolve(cwd, options.spec) : null,
      specSha: options.specSha ?? null,
    }, deps);
  } catch (error) {
    return finish(stopped(context, `tamper check failed: ${String(error.message).split("\n")[0]}`), judged.logs);
  }
  const marked = tamper.map((entry, at) => ({ id: `tamper#${at + 1}`, kind: entry.kind, file: entry.file ?? null, detail: entry.detail ?? "" }));
  const { verdict, reason } = verdictOf({ findings: judged.findings, tamper: marked, entries: judged.entries, errored: judged.errored });
  const gate = {
    ...emptyGate(context),
    verdict,
    reason,
    judges: judged.entries,
    findings: judged.findings,
    tamper: marked,
    omitted: judged.omitted,
  };
  return finish(gate, judged.logs, judged.flaky, verdict !== "could_not_judge");
}

export function renderGate(gate, prefix = "qac") {
  const head = `${prefix} gate: ${gate.verdict}${gate.reason ? ` (${gate.reason})` : ""}`;
  const lines = [head];
  for (const judge of gate.judges) {
    lines.push(`  ${judge.id}: ${judge.status}${judge.runs > 1 ? `, ${judge.runs} runs` : ""}${judge.findings ? `, ${judge.findings} findings` : ""}`);
  }
  for (const finding of gate.findings) {
    const at = finding.file ? ` ${finding.file}${finding.line ? `:${finding.line}` : ""}` : "";
    lines.push(`  [${finding.id}]${finding.baseline ? " (baseline)" : ""}${at} ${finding.rule}: ${finding.message.split("\n")[0]}`);
  }
  for (const entry of gate.tamper) lines.push(`  [${entry.id}] ${entry.kind}${entry.file ? ` ${entry.file}` : ""}: ${entry.detail}`);
  if (gate.omitted.length > 0) lines.push(`  omitted (ci only): ${gate.omitted.join(", ")}`);
  return lines.join("\n");
}
