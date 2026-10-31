import { extractJson, toFinding } from "./exit-code.mjs";

const REPORTED = new Set(["error", "warning"]);

function located(run, result, cwd) {
  const definition = run.tool?.driver?.rules?.[result.ruleIndex];
  const rule = result.ruleId ?? definition?.id ?? "sarif";
  const location = result.locations?.[0]?.physicalLocation;
  return toFinding({
    rule,
    file: location?.artifactLocation?.uri,
    line: location?.region?.startLine,
    message: result.message?.text ?? result.message?.markdown ?? rule,
  }, cwd);
}

function level(run, result) {
  const definition = run.tool?.driver?.rules?.[result.ruleIndex];
  return result.level ?? definition?.defaultConfiguration?.level ?? "warning";
}

export function parse(output, { cwd } = {}) {
  const document = extractJson(String(output ?? ""), "{");
  return (document.runs ?? []).flatMap(run => (run.results ?? [])
    .filter(result => !(result.suppressions?.length > 0) && REPORTED.has(level(run, result)))
    .map(result => located(run, result, cwd)));
}
