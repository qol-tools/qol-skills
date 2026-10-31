import path from "node:path";
import { fileURLToPath } from "node:url";

export function tailLines(text, count = 20) {
  return String(text ?? "")
    .split(/\r?\n/)
    .filter(line => line.trim() !== "")
    .slice(-count)
    .join("\n");
}

export function repoPath(file, cwd) {
  if (typeof file !== "string" || file === "") return null;
  let plain = file;
  if (file.startsWith("file:")) {
    try {
      plain = fileURLToPath(file);
    } catch {
      plain = file.replace(/^file:\/*/, "/");
    }
  }
  const inside = cwd && path.isAbsolute(plain) ? path.relative(cwd, plain) : plain;
  const chosen = inside.startsWith("..") ? plain : inside;
  return chosen.replace(/\\/g, "/");
}

export function toFinding({ rule, file = null, line = null, message }, cwd) {
  const number = Number(line);
  const text = String(message ?? "").trim() || String(rule);
  return {
    rule: String(rule),
    file: repoPath(file, cwd),
    line: Number.isInteger(number) && number > 0 ? number : null,
    message: text,
  };
}

export function extractJson(text, open) {
  const close = open === "[" ? "]" : "}";
  const start = text.indexOf(open);
  const end = text.lastIndexOf(close);
  if (start < 0 || end < start) throw new Error(`no JSON ${open} in output`);
  return JSON.parse(text.slice(start, end + 1));
}

export function parse(output, { exit = 1 } = {}) {
  if (exit === 0) return [];
  const tail = tailLines(output);
  return [{ rule: "exit", file: null, line: null, message: tail ? `exited ${exit}\n${tail}` : `exited ${exit}` }];
}
