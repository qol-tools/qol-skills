import { toFinding } from "./exit-code.mjs";

const TESTCASE = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/g;
const PROBLEM = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/;
const ATTR = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const ENTITIES = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

export function decodeXml(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, entity) => {
    if (entity[0] !== "#") return ENTITIES[entity] ?? all;
    const hex = entity[1].toLowerCase() === "x";
    return String.fromCodePoint(parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10));
  });
}

function readAttrs(text) {
  return Object.fromEntries([...text.matchAll(ATTR)].map(match => [match[1], decodeXml(match[2] ?? match[3])]));
}

function bodyText(text) {
  return decodeXml(text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")).trim();
}

function failedCase(match, cwd) {
  const problem = PROBLEM.exec(match[2] ?? "");
  if (!problem) return null;
  const attrs = readAttrs(match[1]);
  const problemAttrs = readAttrs(problem[2]);
  const rule = [attrs.classname, attrs.name].filter(Boolean).join(".") || "testcase";
  const message = problemAttrs.message || bodyText(problem[3] ?? "").split("\n")[0] || problem[1];
  return toFinding({ rule, file: attrs.file, line: attrs.line, message }, cwd);
}

export function parse(output, { cwd } = {}) {
  return [...String(output ?? "").matchAll(TESTCASE)]
    .map(match => failedCase(match, cwd))
    .filter(Boolean);
}
