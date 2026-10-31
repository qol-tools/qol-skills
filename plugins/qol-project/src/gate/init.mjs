import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { ALWAYS_PROTECTED, repoId } from "./config.mjs";
import { topLevel } from "./tree.mjs";

const PYTHON = process.platform === "win32" ? "python" : "python3";
const TEST_GLOBS = ["**/test/**", "**/tests/**", "**/__tests__/**", "**/*.test.*", "**/*.spec.*", "**/*_test.*", "**/test_*.py"];
const NODE_TEST = /^\s*node\s+(?:\S+\s+)*--test(?:\s|$)/;
const SHELL_CHAIN = /[;&|<>`]|\$\(/;
const NO_TEST = /no test specified/;
const NODE_LOCKS = [
  ["package-lock.json", ["npm", "ci"]],
  ["npm-shrinkwrap.json", ["npm", "ci"]],
  ["pnpm-lock.yaml", ["pnpm", "install", "--frozen-lockfile"]],
  ["yarn.lock", ["yarn", "install", "--frozen-lockfile"]],
];

function files(deps) {
  const exists = deps.exists ?? existsSync;
  const read = deps.read ?? readFileSync;
  return {
    has: (root, name) => exists(path.join(root, name)),
    text: (root, name) => {
      try {
        return String(read(path.join(root, name), "utf8"));
      } catch {
        return null;
      }
    },
  };
}

function firstPresent(fs, root, names) {
  return names.find(name => fs.has(root, name)) ?? null;
}

function cargo(fs, root) {
  if (!fs.has(root, "Cargo.toml")) return null;
  return {
    accept: [["cargo", "test"]],
    setup: [],
    judges: [
      { id: "fmt", argv: ["cargo", "fmt", "--all", "--check"], parser: "exit-code", scope: "repo", timeout_s: 120 },
      {
        id: "clippy",
        argv: ["cargo", "clippy", "--all-targets", "--message-format=json", "--", "-D", "warnings"],
        parser: "cargo-json",
        scope: "repo",
        timeout_s: 1200,
        rules_home: firstPresent(fs, root, ["clippy.toml", ".clippy.toml"]) ?? "Cargo.toml",
      },
      { id: "cargo-test", argv: ["cargo", "test"], parser: "exit-code", scope: "repo", kind: "test", timeout_s: 1200 },
    ],
  };
}

function npmTest(script) {
  if (NODE_TEST.test(script) && !SHELL_CHAIN.test(script) && !script.includes("--test-reporter")) {
    return { id: "npm-test", argv: ["npm", "test", "--", "--test-reporter=tap"], parser: "tap", scope: "repo", kind: "test" };
  }
  return { id: "npm-test", argv: ["npm", "test"], parser: "exit-code", scope: "repo", kind: "test" };
}

function node(fs, root) {
  const raw = fs.text(root, "package.json");
  if (raw === null) return null;
  let scripts;
  try {
    scripts = JSON.parse(raw)?.scripts ?? {};
  } catch {
    return null;
  }
  const lock = NODE_LOCKS.find(([name]) => fs.has(root, name));
  const judges = [];
  if (typeof scripts.lint === "string") {
    judges.push({ id: "npm-lint", argv: ["npm", "run", "lint"], parser: "exit-code", scope: "repo" });
  }
  if (typeof scripts.test === "string" && !NO_TEST.test(scripts.test)) judges.push(npmTest(scripts.test));
  return { accept: [["node", "--test"]], setup: lock ? [lock[1]] : [], judges };
}

function python(fs, root) {
  const pyproject = fs.text(root, "pyproject.toml");
  const ruffConfig = firstPresent(fs, root, ["ruff.toml", ".ruff.toml"]) ?? (/\[tool\.ruff/.test(pyproject ?? "") ? "pyproject.toml" : null);
  const pytest = fs.has(root, "pytest.ini") || /\[tool\.pytest|\bpytest\b/.test(pyproject ?? "");
  const judges = [];
  if (ruffConfig) {
    judges.push({ id: "ruff", argv: ["ruff", "check", "--output-format=sarif", "."], parser: "sarif", scope: "repo", rules_home: ruffConfig });
  }
  if (pytest) {
    judges.push({ id: "pytest", argv: [PYTHON, "-m", "pytest", "-q"], parser: "exit-code", scope: "repo", kind: "test" });
  }
  if (judges.length === 0) return null;
  return { accept: pytest ? [[PYTHON, "-m", "pytest"]] : [], setup: fs.has(root, "uv.lock") ? [["uv", "sync"]] : [], judges };
}

function go(fs, root) {
  if (!fs.has(root, "go.mod")) return null;
  return {
    accept: [["go", "test"]],
    setup: [],
    judges: [
      { id: "go-vet", argv: ["go", "vet", "./..."], parser: "exit-code", scope: "repo" },
      { id: "go-test", argv: ["go", "test", "./..."], parser: "exit-code", scope: "repo", kind: "test" },
    ],
  };
}

function qacLint(fs, root) {
  if (!fs.has(root, ".qac")) return null;
  return { accept: [], setup: [], judges: [{ id: "qac", builtin: "qac-lint", scope: "changed" }] };
}

function uniqueArgv(list) {
  const seen = new Set();
  return list.filter(argv => {
    const key = JSON.stringify(argv);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function detectConfig(cwd, deps = {}) {
  const fs = files(deps);
  const parts = [cargo, node, python, go, qacLint].map(detect => detect(fs, cwd)).filter(Boolean);
  return {
    version: 1,
    setup: uniqueArgv(parts.flatMap(part => part.setup)),
    protected: [...ALWAYS_PROTECTED],
    tests: TEST_GLOBS,
    accept_prefixes: uniqueArgv(parts.flatMap(part => part.accept)),
    defaults: { test_runs_on_red: 3, timeout_s: 600 },
    judges: parts.flatMap(part => part.judges),
    retention: { loops: 50 },
  };
}

function configHome(env) {
  return env.XDG_CONFIG_HOME || path.join(env.HOME || homedir(), ".config");
}

function readExisting(file, deps) {
  try {
    return JSON.parse(String((deps.read ?? readFileSync)(file, "utf8")));
  } catch {
    return null;
  }
}

export function initConfig({ cwd, exclude = false, env = process.env }, deps = {}) {
  const root = topLevel(cwd, deps);
  const target = exclude
    ? path.join(configHome(env), "qac", "judges", `${(deps.repoId ?? repoId)(root, deps)}.json`)
    : path.join(root, ".qac", "judges.json");
  if ((deps.exists ?? existsSync)(target)) return { path: target, config: readExisting(target, deps), created: false };
  const config = detectConfig(root, deps);
  if (config.judges.length === 0) return { path: target, config, created: false, reason: "no judges detected" };
  mkdirSync(path.dirname(target), { recursive: true });
  (deps.write ?? writeFileSync)(target, `${JSON.stringify(config, null, 2)}\n`);
  return { path: target, config, created: true };
}
