import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { approvalSha, repoId as repoIdOf, setupSha, sha256, writeText } from "./config.mjs";

export function trustFile(env = process.env) {
  const state = env.XDG_STATE_HOME || path.join(env.HOME || homedir(), ".local", "state");
  return path.join(state, "qac", "trust.json");
}

export const argvSha = argv => sha256(JSON.stringify(argv));

export function hasPrefix(argv, prefix) {
  return prefix.length > 0 && prefix.length <= argv.length && prefix.every((part, at) => argv[at] === part);
}

export function readTrust(deps = {}) {
  const file = trustFile(deps.env ?? process.env);
  try {
    const parsed = JSON.parse(String((deps.read ?? readFileSync)(file, "utf8")));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function localJudgeArgv(config) {
  return (config?.judges ?? [])
    .filter(judge => judge.argv && judge.where !== "ci")
    .map(judge => judge.argv);
}

export function trustState({ cwd, config, accept = [], repoId }, deps = {}) {
  const id = repoId ?? repoIdOf(cwd, deps);
  const entry = readTrust(deps)[id];
  const sha = config ? approvalSha(config) : null;
  const untrusted = [];
  if (config) {
    if (entry?.judges_sha !== sha) {
      for (const argv of localJudgeArgv(config)) untrusted.push({ source: "judges", argv });
    }
    if ((config.setup ?? []).length > 0 && entry?.setup_sha !== setupSha(config)) {
      for (const argv of config.setup) untrusted.push({ source: "judges", argv });
    }
  }
  const prefixes = entry?.judges_sha === sha ? (config?.accept_prefixes ?? []) : [];
  const approved = new Set(entry?.accept ?? []);
  for (const item of accept) {
    const known = prefixes.some(prefix => hasPrefix(item.argv, prefix)) || approved.has(argvSha(item.argv));
    if (!known) untrusted.push({ source: "accept", argv: item.argv });
  }
  return { trusted: untrusted.length === 0, judges_sha: sha, untrusted };
}

export function approveTrust({ cwd, config, accept = [], repoId }, deps = {}) {
  const id = repoId ?? repoIdOf(cwd, deps);
  const file = trustFile(deps.env ?? process.env);
  const all = readTrust(deps);
  const prefixes = config?.accept_prefixes ?? [];
  const added = accept
    .filter(item => !prefixes.some(prefix => hasPrefix(item.argv, prefix)))
    .map(item => argvSha(item.argv));
  const before = all[id]?.accept ?? [];
  const entry = {
    judges_sha: config ? approvalSha(config) : (all[id]?.judges_sha ?? null),
    setup_sha: config ? setupSha(config) : (all[id]?.setup_sha ?? null),
    accept: [...new Set([...before, ...added])],
    approved_at: (deps.now ?? (() => new Date().toISOString()))(),
  };
  all[id] = entry;
  (deps.write ?? writeText)(file, `${JSON.stringify(all, null, 2)}\n`);
  return { approved: true, repo_id: id, judges_sha: entry.judges_sha, accept: entry.accept, path: file };
}
