import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { PARSERS } from "./parsers/index.mjs";
import { runGit } from "./tree.mjs";

export const CONFIG_PATH = ".qac/judges.json";
export const ALWAYS_PROTECTED = Object.freeze([
  ".qac/**",
  "**/rustfmt.toml",
  "**/.rustfmt.toml",
  "**/clippy.toml",
  "**/.clippy.toml",
  "**/.cargo/**",
  "**/.claude/**",
  "**/.gitattributes",
]);
const BUILTINS = Object.freeze(["qac-lint"]);
const SCOPES = Object.freeze(["changed", "repo"]);
const WHERES = Object.freeze(["local", "ci"]);
const KINDS = Object.freeze(["lint", "test"]);
export const DEFAULTS = Object.freeze({ test_runs_on_red: 3, timeout_s: 600 });
export const DEFAULT_RETENTION_LOOPS = 50;

export const sha256 = text => createHash("sha256").update(text).digest("hex");
export const sha16 = text => sha256(text).slice(0, 16);

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, sortKeys(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

export function judgesSha(config) {
  return sha256(canonicalJson(config?.judges ?? []));
}

export function approvalSha(config) {
  return sha256(canonicalJson({ judges: config?.judges ?? [], accept_prefixes: config?.accept_prefixes ?? [] }));
}

export function setupSha(config) {
  return sha256(canonicalJson(config?.setup ?? []));
}

export function writeText(file, text) {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, text);
  renameSync(temporary, file);
}

export function normalizeRemote(url) {
  return String(url)
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^[^@/]+@/, "")
    .replace(/^([^/:]+):(?!\d+(?:\/|$))/, "$1/")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

export function repoId(cwd, deps = {}) {
  let remote = "";
  try {
    remote = runGit(cwd, ["remote", "get-url", "origin"], { exec: deps.exec }).trim();
  } catch {
    remote = "";
  }
  if (remote) return sha16(normalizeRemote(remote));
  const common = runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { exec: deps.exec }).trim();
  return sha16(path.dirname(path.resolve(cwd, common)));
}

export function userConfigPath(id, env = process.env) {
  const config = env.XDG_CONFIG_HOME || path.join(env.HOME || homedir(), ".config");
  return path.join(config, "qac", "judges", `${id}.json`);
}

const isObject = value => value !== null && typeof value === "object" && !Array.isArray(value);
const isStringArray = value => Array.isArray(value) && value.every(item => typeof item === "string");
const isArgv = value => isStringArray(value) && value.length > 0 && value[0].trim() !== "";
const isPositiveInt = value => Number.isInteger(value) && value > 0;
const isPositive = value => typeof value === "number" && Number.isFinite(value) && value > 0;

function judgeErrors(judge, index, ids) {
  const at = `judges[${index}]`;
  if (!isObject(judge)) return [`${at} must be an object`];
  const errors = [];
  if (typeof judge.id !== "string" || judge.id.trim() === "") errors.push(`${at}.id must be a non-empty string`);
  else if (ids.has(judge.id)) errors.push(`${at}.id "${judge.id}" is not unique`);
  ids.add(judge.id);
  const hasArgv = judge.argv !== undefined;
  const hasBuiltin = judge.builtin !== undefined;
  if (hasArgv === hasBuiltin) errors.push(`${at} needs exactly one of argv or builtin`);
  else if (hasArgv && !isArgv(judge.argv)) errors.push(`${at}.argv must be a non-empty argv array of strings`);
  else if (hasBuiltin && !BUILTINS.includes(judge.builtin)) errors.push(`${at}.builtin must be one of ${BUILTINS.join(", ")}`);
  if (judge.parser !== undefined && !PARSERS.includes(judge.parser)) errors.push(`${at}.parser must be one of ${PARSERS.join(", ")}`);
  if (judge.scope !== undefined && !SCOPES.includes(judge.scope)) errors.push(`${at}.scope must be one of ${SCOPES.join(", ")}`);
  if (judge.where !== undefined && !WHERES.includes(judge.where)) errors.push(`${at}.where must be one of ${WHERES.join(", ")}`);
  if (judge.kind !== undefined && !KINDS.includes(judge.kind)) errors.push(`${at}.kind must be one of ${KINDS.join(", ")}`);
  if (judge.timeout_s !== undefined && !isPositive(judge.timeout_s)) errors.push(`${at}.timeout_s must be a positive number`);
  for (const key of ["rules_home", "report"]) {
    if (judge[key] !== undefined && (typeof judge[key] !== "string" || judge[key] === "")) errors.push(`${at}.${key} must be a non-empty string`);
  }
  return errors;
}

export function validateConfig(config) {
  if (!isObject(config)) return ["config must be a JSON object"];
  const errors = [];
  if (config.version !== 1) errors.push("version must be 1");
  if (config.setup !== undefined) {
    if (!Array.isArray(config.setup) || !config.setup.every(isArgv)) errors.push("setup must be an array of non-empty argv arrays");
  }
  for (const key of ["protected", "tests"]) {
    if (config[key] !== undefined && !isStringArray(config[key])) errors.push(`${key} must be an array of glob strings`);
  }
  if (config.accept_prefixes !== undefined) {
    if (!Array.isArray(config.accept_prefixes) || !config.accept_prefixes.every(isArgv)) errors.push("accept_prefixes must be an array of non-empty argv arrays");
  }
  if (config.defaults !== undefined) {
    if (!isObject(config.defaults)) errors.push("defaults must be an object");
    else {
      if (config.defaults.test_runs_on_red !== undefined && !isPositiveInt(config.defaults.test_runs_on_red)) errors.push("defaults.test_runs_on_red must be a positive integer");
      if (config.defaults.timeout_s !== undefined && !isPositive(config.defaults.timeout_s)) errors.push("defaults.timeout_s must be a positive number");
    }
  }
  if (config.retention !== undefined) {
    if (!isObject(config.retention) || (config.retention.loops !== undefined && !isPositiveInt(config.retention.loops))) errors.push("retention.loops must be a positive integer");
  }
  if (!Array.isArray(config.judges)) errors.push("judges must be an array");
  else {
    const ids = new Set();
    config.judges.forEach((judge, index) => errors.push(...judgeErrors(judge, index, ids)));
  }
  return errors;
}

export function normalizeConfig(raw) {
  return {
    ...raw,
    setup: raw.setup ?? [],
    protected: [...new Set([...ALWAYS_PROTECTED, ...(raw.protected ?? [])])],
    tests: raw.tests ?? [],
    accept_prefixes: raw.accept_prefixes ?? [],
    defaults: { ...DEFAULTS, ...raw.defaults },
    retention: { loops: DEFAULT_RETENTION_LOOPS, ...raw.retention },
    judges: raw.judges,
  };
}

export function normalizeJudge(judge, defaults = DEFAULTS) {
  return {
    parser: "exit-code",
    scope: "repo",
    where: "local",
    kind: "lint",
    timeout_s: defaults.timeout_s ?? DEFAULTS.timeout_s,
    ...judge,
  };
}

function readSource(base, cwd, id, deps) {
  try {
    return { text: runGit(cwd, ["show", `${base}:${CONFIG_PATH}`], { exec: deps.exec }), source: "base", where: `${base}:${CONFIG_PATH}` };
  } catch {
    const file = userConfigPath(id, deps.env ?? process.env);
    try {
      return { text: String((deps.read ?? readFileSync)(file, "utf8")), source: "user", where: file };
    } catch {
      return null;
    }
  }
}

export function loadConfig({ cwd, base = "HEAD" } = {}, deps = {}) {
  const id = repoId(cwd, deps);
  const found = readSource(base, cwd, id, deps);
  if (found === null) return { config: null, source: null, repoId: id, judgesSha: null, errors: [] };
  let raw;
  try {
    raw = JSON.parse(found.text);
  } catch (error) {
    return { config: null, source: found.source, repoId: id, judgesSha: null, errors: [`${found.where} is not valid JSON: ${error.message}`] };
  }
  const errors = validateConfig(raw).map(message => `${found.where}: ${message}`);
  if (errors.length > 0) return { config: null, source: found.source, repoId: id, judgesSha: null, errors };
  const config = normalizeConfig(raw);
  return { config, source: found.source, repoId: id, judgesSha: judgesSha(config), errors: [] };
}
