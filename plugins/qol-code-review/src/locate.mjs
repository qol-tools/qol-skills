import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

function count(text) {
  if (text === null) return null;
  if (text.length === 0) return 0;
  return text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
}

export function repoPath(file) {
  return typeof file === "string" && file.length > 0 && !file.startsWith("/") && !/^[A-Za-z]:/.test(file) && !file.split(/[\\/]/).includes("..");
}

export function locator(scope, git) {
  const counts = new Map();
  const lineCount = (side, file) => {
    const key = `${side}:${file}`;
    if (!counts.has(key)) {
      let text = null;
      if (side === "base") text = git(["show", `${scope.base.sha}:${file}`], { allowFail: true });
      else {
        const path = join(scope.tree, file);
        text = existsSync(path) && statSync(path).isFile() ? readFileSync(path, "utf8") : null;
      }
      counts.set(key, count(text));
    }
    return counts.get(key);
  };
  return (location) => {
    if (!repoPath(location.file)) return `${location.file} is not a repository-relative path`;
    const side = location.side ?? "head";
    const lines = lineCount(side, location.file);
    if (lines === null) return `${location.file} does not exist at the ${side} of this review`;
    const last = location.end_line ?? location.line;
    if (last > lines) return `${location.file}:${last} is past the end of the file, which has ${lines} lines at the ${side}`;
    return null;
  };
}
