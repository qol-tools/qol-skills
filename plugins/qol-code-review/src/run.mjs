import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inputError } from "./errors.mjs";

export const REFERENCES = fileURLToPath(new URL("../skills/qol-code-review/references/", import.meta.url));
export const RUBRIC = fileURLToPath(new URL("../skills/qol-code-review/SKILL.md", import.meta.url));

export function privateDir(path) {
  try {
    mkdirSync(path, { mode: 0o700, recursive: true });
  } catch (error) {
    if (error.code !== "EEXIST") throw error;
  }
  const stat = lstatSync(path);
  const uid = process.getuid?.();
  if (!stat.isDirectory() || (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o077) !== 0))) throw inputError(`${path} is not a folder only you can open; remove it, or set CODE_REVIEW_ENGINE_DIR to another folder`);
  return path;
}

export function outRoot(env = process.env) {
  if (env.CODE_REVIEW_ENGINE_DIR) return privateDir(env.CODE_REVIEW_ENGINE_DIR);
  const uid = process.getuid?.();
  return privateDir(join(tmpdir(), uid === undefined ? "code-review-engine" : `code-review-engine-${uid}`));
}

export function runPaths(runDir) {
  return {
    dir: runDir,
    scope: join(runDir, "scope.json"),
    diff: join(runDir, "diff.patch"),
    rules: join(runDir, "rules.md"),
    intentSources: join(runDir, "intent-sources.md"),
    intent: join(runDir, "intent.json"),
    context: join(runDir, "context.json"),
    ledger: join(runDir, "ledger.json"),
    candidates: join(runDir, "candidates.json"),
    review: join(runDir, "review.json"),
    template: join(runDir, "review.template.json"),
    report: join(runDir, "report.json"),
    markdown: join(runDir, "review.md"),
    summary: join(runDir, "summary.json"),
    saved: join(runDir, "saved.json"),
    shallow: join(runDir, "shallow-wrappers.json"),
    chunks: join(runDir, "chunks"),
    jobs: join(runDir, "jobs"),
    finds: join(runDir, "finds"),
    verify: join(runDir, "verify"),
  };
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function tryJson(path) {
  if (!existsSync(path)) return { missing: true };
  try {
    return { value: readJson(path) };
  } catch (error) {
    return { error: `${path} is not valid JSON: ${error.message}` };
  }
}

export function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const staging = `${path}.tmp-${process.pid}`;
  writeFileSync(staging, text);
  renameSync(staging, path);
}

export function writeJson(path, value) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export function loadScope(runDir) {
  const paths = runPaths(runDir);
  if (!existsSync(paths.scope)) throw inputError(`${runDir} is not a code-review engine run: scope.json is missing`);
  return { paths, scope: readJson(paths.scope) };
}

export function jobInputs(scope, paths, { ledger = true } = {}) {
  return {
    intent: paths.intent,
    intent_sources: paths.intentSources,
    rules: scope.rules.length > 0 ? paths.rules : null,
    ledger: ledger && scope.plan.ledger ? paths.ledger : null,
    context: scope.plan.context ? paths.context : null,
    shallow_wrappers: scope.shallow.entries.length > 0 ? paths.shallow : null,
    diff: paths.diff,
  };
}

export function outputPath(paths, job) {
  return job.kind === "ledger" ? paths.ledger : join(paths.finds, `${job.id}.json`);
}
