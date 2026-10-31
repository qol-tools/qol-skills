import { extractJson, toFinding } from "./exit-code.mjs";

export function parse(output, { cwd } = {}) {
  const document = extractJson(String(output ?? ""), "[");
  if (!Array.isArray(document)) throw new Error("eslint output is not a JSON array");
  return document.flatMap(result => (result.messages ?? [])
    .filter(message => message.severity === 2 || message.fatal)
    .map(message => toFinding({
      rule: message.ruleId ?? (message.fatal ? "fatal" : "eslint"),
      file: result.filePath,
      line: message.line,
      message: message.message,
    }, cwd)));
}
