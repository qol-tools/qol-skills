import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { sha256 } from "./config.mjs";

const LOCKFILES = ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "uv.lock", "poetry.lock", "go.sum"];
const MARKER_LENGTH = 16;
const DEFAULT_TIMEOUT_S = 600;
const MAX_BUFFER = 64 * 1024 * 1024;
const STDERR_TAIL = 400;

export function setupMarker({ cwd, commonDir }, deps = {}) {
  const exists = deps.exists ?? existsSync;
  const read = deps.read ?? readFileSync;
  const hashes = LOCKFILES
    .map(name => path.join(cwd, name))
    .filter(file => exists(file))
    .map(file => sha256(read(file)));
  const key = sha256(`${path.resolve(cwd)}\n${hashes.join("\n")}`).slice(0, MARKER_LENGTH);
  return path.join(commonDir, "qac", "setup", `${key}.done`);
}

function validArgv(argv) {
  return Array.isArray(argv) && argv.length > 0 && argv.every(part => typeof part === "string");
}

function failure(argv, result) {
  const cause = result.error ? result.error.message : `exited ${result.status ?? result.signal}`;
  const tail = String(result.stderr ?? "").trim().slice(-STDERR_TAIL);
  return `setup ${argv.join(" ")} ${cause}${tail ? `: ${tail}` : ""}`;
}

export function ensureSetup({ cwd, config, commonDir }, deps = {}) {
  const exists = deps.exists ?? existsSync;
  const marker = setupMarker({ cwd, commonDir }, deps);
  const commands = config?.setup ?? [];
  if (exists(marker) || commands.length === 0) return { ran: false, ok: true, marker, error: null };
  const spawn = deps.spawn ?? spawnSync;
  const timeout = (config?.defaults?.timeout_s ?? DEFAULT_TIMEOUT_S) * 1000;
  for (const argv of commands) {
    if (!validArgv(argv)) return { ran: true, ok: false, marker, error: `setup entry is not an argv array: ${JSON.stringify(argv)}` };
    const result = spawn(argv[0], argv.slice(1), {
      cwd,
      encoding: "utf8",
      env: deps.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout,
      maxBuffer: MAX_BUFFER,
    });
    if (result.error || result.status !== 0) return { ran: true, ok: false, marker, error: failure(argv, result) };
  }
  const write = deps.write ?? writeFileSync;
  const at = deps.now ? deps.now() : new Date().toISOString();
  mkdirSync(path.dirname(marker), { recursive: true });
  write(marker, `${JSON.stringify({ at, setup: commands })}\n`);
  return { ran: true, ok: true, marker, error: null };
}
