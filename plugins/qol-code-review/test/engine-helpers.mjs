import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test as nodeTest } from "node:test";
import { toolError } from "../src/errors.mjs";

const LOCATION_VARIABLES = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_PREFIX", "GIT_NAMESPACE"];
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "code-review-engine-saved-"));
process.on("exit", () => fs.rmSync(OUT, { recursive: true, force: true }));

export const ENV = {
  ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !LOCATION_VARIABLES.includes(name))),
  CODE_REVIEW_OUT_DIR: OUT,
  GIT_AUTHOR_NAME: "t",
  GIT_AUTHOR_EMAIL: "t@t",
  GIT_COMMITTER_NAME: "t",
  GIT_COMMITTER_EMAIL: "t@t",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
};

export function sh(cwd, ...args) {
  return execFileSync("git", args, { cwd, env: ENV, encoding: "utf8" }).trim();
}

export function tempRoot(prefix = "code-review-engine-test-") {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

export function write(cwd, file, text) {
  const full = path.join(cwd, file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, text);
}

export function commit(cwd, files, message) {
  for (const [file, text] of Object.entries(files)) {
    if (text === null) fs.rmSync(path.join(cwd, file), { force: true });
    else write(cwd, file, text);
  }
  sh(cwd, "add", "-A");
  sh(cwd, "commit", "-qm", message);
  return sh(cwd, "rev-parse", "HEAD");
}

export function makeRepo(root, name = "repo") {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  sh(dir, "init", "-q", "-b", "main");
  return dir;
}

export function numbered(count, prefix = "line") {
  return `${Array.from({ length: count }, (_, index) => `${prefix} ${index + 1}`).join("\n")}\n`;
}

export function fakeGh(handler = () => null) {
  const calls = [];
  const gh = (args, options = {}) => {
    calls.push({ args, input: options.input ?? null });
    const out = handler(args, options);
    if (out === null || out === undefined) {
      if (options.allowFail) return null;
      throw toolError(`gh ${args.join(" ")} failed`);
    }
    return out;
  };
  gh.calls = calls;
  return gh;
}

export function depsFor(repoDir, out, gh = fakeGh()) {
  return { cwd: repoDir, env: { ...ENV, CODE_REVIEW_ENGINE_DIR: out }, gh };
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function finderOutput(scope, job, candidates = [], extra = {}) {
  const chunk = scope.chunks.find((item) => item.id === job.chunk);
  const files = chunk ? chunk.files.map((file) => file.path) : scope.files.filter((file) => !file.excluded).map((file) => file.path);
  return { job: job.id, candidates, files_read: files.map((file) => ({ path: file, read: "full" })), declined: [], agent_id: `agent-${job.id}`, ...extra };
}

export function writeFinds(scope, byJob = {}) {
  for (const job of scope.plan.jobs) writeJson(path.join(scope.run_dir, "finds", `${job.id}.json`), finderOutput(scope, job, byJob[job.id] ?? []));
}

export function candidate(overrides = {}) {
  return {
    lens: "correctness",
    title: "Off by one in the loop bound",
    severity: "medium",
    confidence: "medium",
    locations: [{ file: "src/app.js", line: 10 }],
    trigger: "A list with exactly one element.",
    observed: "The loop skips the last element.",
    expected: "Every element is visited.",
    required_action: "Change the bound from length - 1 to length.",
    evidence: ["src/app.js:10 loops to length - 1"],
    ...overrides,
  };
}

export function catching(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

export function verifierResult(scope, group, value) {
  const candidates = readJson(path.join(scope.run_dir, "candidates.json"));
  const result = { group, finds_digest: candidates.digest, agent_id: `agent-verify-${group}`, ...value };
  writeJson(path.join(scope.run_dir, "verify", `${group}.result.json`), result);
  return result;
}

export const test = process.platform === "win32" ? (name, ...rest) => nodeTest.skip(name, ...rest) : nodeTest;
