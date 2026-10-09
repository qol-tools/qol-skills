// @generated hook-kit input.mjs sha256:b64bd67b358430b279f0b6b151e7e2ec0c7b3596e1f5b77128fd21036cef465e - do not edit; change qol-skills/kit-src/hook-kit, then run vs vendor
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
