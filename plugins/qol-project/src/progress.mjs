import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const THROTTLE_MS = 250;

export function progressFile(name, env = process.env) {
  return join(env.XDG_RUNTIME_DIR || tmpdir(), "agent-progress", `${name}.json`);
}

export function writeProgress(file, entry, env = process.env) {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  const window = env.KITTY_WINDOW_ID ? { window: env.KITTY_WINDOW_ID } : {};
  writeFileSync(temp, JSON.stringify({
    ...entry,
    ...window,
    pid: process.pid,
    updated_at: new Date().toISOString(),
  }));
  renameSync(temp, file);
}

export function progressReporter(name, label, { write = writeProgress, now = Date.now, env = process.env } = {}) {
  const file = progressFile(name, env);
  let written = -Infinity;
  return {
    step(done, total) {
      const at = now();
      if (at - written < THROTTLE_MS && done < total) return;
      written = at;
      write(file, { label, done, total }, env);
    },
    finish(detail, tone) {
      write(file, { label, done: 0, total: 0, finished: true, detail, tone }, env);
    },
  };
}
