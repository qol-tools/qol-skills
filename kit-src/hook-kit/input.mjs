import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

export function readHookInput(fd = 0) {
  try {
    const input = JSON.parse(readFileSync(fd, "utf8") || "{}");
    return typeof input === "object" && input !== null ? input : null;
  } catch {
    return null;
  }
}

export function gitRoot(cwd) {
  const top = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return top.status === 0 && top.stdout.trim() !== "" ? top.stdout.trim() : cwd;
}
