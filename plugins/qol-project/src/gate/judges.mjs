import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { lint } from "../qac.mjs";
import { DEFAULTS, normalizeJudge } from "./config.mjs";
import { parse } from "./parsers/index.mjs";

function killTree(child) {
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    child.kill("SIGKILL");
  }
}

export function defaultSpawn(argv, { cwd, timeoutS = DEFAULTS.timeout_s, env = {} } = {}) {
  return new Promise(done => {
    const started = Date.now();
    const stdout = [];
    const stderr = [];
    let error = null;
    let settled = false;
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
    } catch {
      done({ exit: null, stdout: "", stderr: "", ms: 0, error: "not-found" });
      return;
    }
    const timer = setTimeout(() => {
      error = "timeout";
      killTree(child);
    }, timeoutS * 1000);
    const finish = exit => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      done({
        exit,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        ms: Date.now() - started,
        error,
      });
    };
    child.stdout.on("data", chunk => stdout.push(chunk));
    child.stderr.on("data", chunk => stderr.push(chunk));
    child.on("error", () => {
      error = error ?? "not-found";
      finish(null);
    });
    child.on("close", code => finish(code));
  });
}

function outcome(status, fields = {}) {
  return { status, exit: null, output: "", duration_ms: 0, findings: [], runs: 1, ...fields };
}

function skipped(argv, cwd) {
  return outcome("pass", { exit: 0, runs: 0, argv, cwd });
}

function changedExisting(changed, cwd, exists) {
  return changed.filter(file => exists(path.resolve(cwd, file)));
}

function reportText(judge, cwd, read) {
  try {
    return String(read(path.resolve(cwd, judge.report), "utf8"));
  } catch {
    return null;
  }
}

function judged(judge, result, cwd, deps) {
  const stdout = result.stdout ?? "";
  const output = `${stdout}${result.stderr ? `\n${result.stderr}` : ""}`;
  const base = { exit: result.exit, output, duration_ms: result.ms ?? 0, runs: 1 };
  if (result.error === "timeout") {
    const message = `${judge.argv.join(" ")} exceeded ${judge.timeout_s}s`;
    return outcome("timeout", { ...base, findings: [{ rule: "timeout", file: null, line: null, message }] });
  }
  if (result.error) return outcome("error", { ...base, output: `${judge.argv[0]}: ${result.error}` });
  let text = judge.parser === "exit-code" ? output : stdout;
  let readable = true;
  if (judge.report) {
    const report = reportText(judge, cwd, deps.read ?? readFileSync);
    if (report !== null) text = report;
    else if (result.exit === 0) return outcome("error", { ...base, output: `report ${judge.report} was not written` });
    else readable = false;
  }
  let findings;
  try {
    findings = readable ? parse(text, { cwd, judge, exit: result.exit }) : [];
  } catch (error) {
    return outcome("error", { ...base, output: `${judge.parser} output could not be parsed: ${error.message}` });
  }
  if (result.exit !== 0 && findings.length === 0) findings = parse(output, { cwd, judge: { parser: "exit-code" }, exit: result.exit });
  return outcome(result.exit !== 0 || findings.length > 0 ? "fail" : "pass", { ...base, findings });
}

async function once(judge, argv, cwd, deps) {
  const result = await (deps.spawn ?? defaultSpawn)(argv, { cwd, timeoutS: judge.timeout_s, env: {} });
  return judged(judge, result, cwd, deps);
}

async function runArgv(judge, { cwd, changed, defaults }, deps) {
  const exists = deps.exists ?? existsSync;
  let argv = judge.argv;
  if (judge.scope === "changed") {
    const files = changedExisting(changed, cwd, exists);
    if (files.length === 0) return skipped(argv, cwd);
    argv = [...argv, ...files];
  }
  const maxRuns = judge.kind === "test" ? (defaults.test_runs_on_red ?? DEFAULTS.test_runs_on_red) : 1;
  let first = null;
  let last = null;
  let runs = 0;
  let total = 0;
  while (runs < maxRuns) {
    last = await once(judge, argv, cwd, deps);
    runs += 1;
    total += last.duration_ms;
    if (last.status === "pass") break;
    first = first ?? last;
    if (last.status !== "fail") break;
  }
  const flaky = first !== null && last.status === "pass";
  const final = flaky ? { ...first, status: "flaky", exit: last.exit } : last;
  return { ...final, runs, duration_ms: total, argv, cwd };
}

function builtinFindings(result) {
  return result.findings.map(finding => ({
    rule: finding.rule,
    file: finding.file,
    line: finding.lines?.[0] ?? null,
    message: `[${finding.hook}] ${finding.summary}`,
  }));
}

async function runBuiltin(judge, { cwd, changed, base }, deps) {
  const argv = [judge.builtin];
  const exists = deps.exists ?? existsSync;
  let paths = [];
  if (judge.scope === "changed") {
    paths = changedExisting(changed, cwd, exists);
    if (paths.length === 0) return skipped(argv, cwd);
  }
  const started = Date.now();
  let result;
  try {
    result = (deps.lint ?? lint)(cwd, paths, { base });
  } catch (error) {
    return outcome("error", { output: `qac-lint failed: ${String(error.message).split("\n")[0]}`, argv, cwd });
  }
  const findings = builtinFindings(result);
  const output = findings.map(finding => `${finding.file}${finding.line ? `:${finding.line}` : ""} ${finding.message}`).join("\n");
  return outcome(findings.length > 0 ? "fail" : "pass", {
    exit: findings.length > 0 ? 1 : 0,
    output,
    duration_ms: Date.now() - started,
    findings,
    argv,
    cwd,
  });
}

export async function runJudge(judge, ctx, deps = {}) {
  const defaults = ctx.defaults ?? DEFAULTS;
  const spec = normalizeJudge(judge, defaults);
  const context = { cwd: ctx.cwd, changed: ctx.changed ?? [], base: ctx.base ?? null, defaults };
  return spec.builtin ? runBuiltin(spec, context, deps) : runArgv(spec, context, deps);
}
