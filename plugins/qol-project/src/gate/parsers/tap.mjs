import { toFinding } from "./exit-code.mjs";

const NOT_OK = /^\s*not ok\b\s*\d*\s*(?:-\s*)?(.*)$/;
const BAIL = /^\s*Bail out!\s*(.*)$/;
const DIRECTIVE = /(?:^|\s)#\s*(?:todo|skip)\b/i;
const KEY = /^\s*([\w-]+):\s*(.*)$/;
const LOCATION = /^(.*?):(\d+)(?::\d+)?$/;

function indentOf(line) {
  return line.length - line.trimStart().length;
}

function unquote(value) {
  const single = /^'(.*)'$/.exec(value);
  if (single) return single[1].replace(/''/g, "'");
  const double = /^"(.*)"$/.exec(value);
  return double ? double[1] : value;
}

export function readDiagnostics(lines, start) {
  if (lines[start]?.trim() !== "---") return {};
  const out = {};
  let key = null;
  let keyIndent = -1;
  let block = false;
  for (let at = start + 1; at < lines.length && lines[at].trim() !== "..."; at++) {
    const line = lines[at];
    const indent = indentOf(line);
    const pair = KEY.exec(line);
    if (pair && (keyIndent < 0 || indent <= keyIndent)) {
      keyIndent = indent;
      key = pair[1];
      block = /^[|>][-+]?$/.test(pair[2]);
      out[key] = block ? "" : unquote(pair[2]);
    } else if (block && line.trim() !== "" && indent > keyIndent) {
      out[key] = out[key] ? `${out[key]}\n${line.trim()}` : line.trim();
    }
  }
  return out;
}

function splitLocation(text) {
  const match = LOCATION.exec(text);
  return match ? [match[1], Number(match[2])] : [text || null, null];
}

function failedTest(lines, index, description, cwd) {
  if (DIRECTIVE.test(description)) return null;
  const diagnostics = readDiagnostics(lines, index + 1);
  if (diagnostics.failureType === "subtestsFailed") return null;
  const rule = description.replace(/\s+#.*$/, "").trim() || "test";
  const [file, line] = splitLocation(diagnostics.location ?? diagnostics.at ?? "");
  return toFinding({ rule, file, line, message: diagnostics.message || diagnostics.error || rule }, cwd);
}

export function parse(output, { cwd } = {}) {
  const lines = String(output ?? "").split(/\r?\n/);
  return lines.map((line, index) => {
    const bail = BAIL.exec(line);
    if (bail) return toFinding({ rule: "bail-out", message: bail[1] || "bail out" }, cwd);
    const notOk = NOT_OK.exec(line);
    return notOk ? failedTest(lines, index, notOk[1], cwd) : null;
  }).filter(Boolean);
}
