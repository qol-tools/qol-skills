function fence(text, info = "") {
  const body = String(text ?? "").replace(/\n+$/, "");
  const longest = Math.max(2, ...[...body.matchAll(/`+/g)].map((match) => match[0].length));
  const marker = "`".repeat(longest + 1);
  return `${marker}${info}\n${body}\n${marker}`;
}

function oneLine(text) {
  return String(text ?? "").trim().replace(/\s*\n\s*/g, " ");
}

function location(finding) {
  const file = finding.file ?? "(no file)";
  return finding.line ? `${file}:${finding.line}` : file;
}

function findingLine(finding) {
  const id = finding.id ? `${finding.id} ` : "";
  return `- ${id}${finding.judge ?? "judge"} / ${finding.rule ?? "rule"} at ${location(finding)}: ${oneLine(finding.message)}`;
}

function trapLine(trap) {
  const loops = Array.isArray(trap.loops) ? trap.loops.length : trap.loops;
  const seen = loops ? ` (caught first time in ${loops} earlier loops)` : "";
  return `- ${trap.judge ?? "judge"} / ${trap.rule ?? "rule"}: ${oneLine(trap.message)}${seen}`;
}

function verdictLines(verdict) {
  return [
    `- blame: ${verdict.blame ?? "impl"}`,
    ...(verdict.finding ? [`- finding: ${verdict.finding}`] : []),
    ...(verdict.hunk ? [`- hunk: ${verdict.hunk}`] : []),
    ...(verdict.why ? [`- why: ${oneLine(verdict.why)}`] : []),
  ];
}

function acceptLines(accept) {
  return accept.map((entry) => `- ${entry.id}: ${entry.argv.join(" ")}`);
}

export const LANE_RULES = [
  "Edit only the owned paths above. A change anywhere else fails the gate.",
  "Never run build, test, lint, format or git commands. The gate runs the checks after you finish.",
  "Never weaken, skip or delete tests, and never add lint, type or test suppressions.",
  "Add no code comments and use no em-dash character anywhere.",
  "Implement the spec exactly as written: no extra features, no unrelated changes.",
  "If you are blocked and cannot continue without a decision, stop and end your final text with a line that starts with QUESTION: followed by the question.",
];

export function buildBrief({ spec, traps = [], findings = [], verdict = null, answer = null } = {}) {
  const front = spec?.front ?? {};
  const owned = front.owned ?? [];
  const accept = front.accept ?? [];
  const sections = [
    "# Lane brief",
    "Role: implement",
    ["## Owned paths", owned.length > 0 ? owned.map((glob) => `- ${glob}`).join("\n") : "- (none declared)"].join("\n"),
    ["## Spec document", spec?.path ?? "(the spec is embedded below)"].join("\n"),
    ["## Rules", LANE_RULES.map((rule) => `- ${rule}`).join("\n")].join("\n"),
    [
      "## Report",
      "End with the files and lines you changed plus any conscious deviations from the spec, and nothing else.",
    ].join("\n"),
  ];
  if (traps.length > 0) {
    sections.push(
      [
        "## Known traps",
        "Earlier lanes in this repository failed these checks on their first attempt. Avoid every one of them.",
        traps.map(trapLine).join("\n"),
      ].join("\n"),
    );
  }
  if (findings.length > 0) {
    sections.push(
      [
        "## Gate findings",
        "Your previous attempt was rejected by the gate. Its changes are still in this worktree. Fix every finding below.",
        findings.map(findingLine).join("\n"),
      ].join("\n"),
    );
  }
  if (verdict) sections.push(["## Architect verdict", "The architect reviewed the rejected attempt and ruled on it.", verdictLines(verdict).join("\n")].join("\n"));
  if (answer) sections.push(["## Answer", "The architect answered your question:", String(answer).trim()].join("\n"));
  if (accept.length > 0) {
    sections.push(["## Acceptance checks", "The gate runs these after you finish. You never run them.", acceptLines(accept).join("\n")].join("\n"));
  }
  sections.push(["## Spec", fence(spec?.body ?? "", "markdown")].join("\n"));
  return `${sections.join("\n\n")}\n`;
}
