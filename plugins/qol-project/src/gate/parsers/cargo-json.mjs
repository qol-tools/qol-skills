import { toFinding } from "./exit-code.mjs";

function diagnostic(line) {
  if (!line.startsWith("{")) return null;
  let row;
  try {
    row = JSON.parse(line);
  } catch {
    return null;
  }
  const message = row?.reason === "compiler-message" ? row.message : null;
  if (!message || message.level !== "error") return null;
  return message.code || message.spans?.length ? message : null;
}

function located(message, cwd) {
  const span = message.spans?.find(s => s.is_primary) ?? message.spans?.[0];
  return toFinding({
    rule: message.code?.code ?? message.level,
    file: span?.file_name,
    line: span?.line_start,
    message: message.message,
  }, cwd);
}

export function parse(output, { cwd } = {}) {
  const seen = new Set();
  return String(output ?? "")
    .split(/\r?\n/)
    .map(line => diagnostic(line.trim()))
    .filter(Boolean)
    .map(message => located(message, cwd))
    .filter(finding => {
      const key = `${finding.rule}:${finding.file}:${finding.line}:${finding.message}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
