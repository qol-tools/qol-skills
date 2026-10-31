import { mkdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

const LOCK_WAIT_MS = 2000;
const LOCK_STALE_MS = 10000;
const LOCK_POLL_MS = 25;

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function quietly(action) {
  try {
    action();
  } catch {
    return false;
  }
  return true;
}

export function withLock(file, fn, deps = {}) {
  const lock = `${file}.lock`;
  const nowMs = deps.nowMs ?? Date.now;
  const sleep = deps.sleep ?? sleepSync;
  const create = deps.createLock ?? (target => writeFileSync(target, String(process.pid), { flag: "wx" }));
  const age = deps.lockAge ?? (target => nowMs() - statSync(target).mtimeMs);
  const remove = deps.removeLock ?? unlinkSync;
  mkdirSync(path.dirname(file), { recursive: true });
  const deadline = nowMs() + LOCK_WAIT_MS;
  for (;;) {
    try {
      create(lock);
      break;
    } catch (failure) {
      if (failure.code !== "EEXIST") throw failure;
    }
    let stale = false;
    const aged = quietly(() => {
      stale = age(lock) > LOCK_STALE_MS;
    });
    if (aged && stale && quietly(() => remove(lock))) continue;
    if (nowMs() >= deadline) throw Object.assign(new Error(`could not lock ${file}`), { code: "ELOCK" });
    if (aged) sleep(LOCK_POLL_MS);
  }
  try {
    return fn();
  } finally {
    quietly(() => remove(lock));
  }
}
