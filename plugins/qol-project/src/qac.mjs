import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { locate } from "./locate.mjs";

const require = createRequire(import.meta.url);

export const HOOKS = [
  ["qol-arch-code", require("../bin/check-qol-arch-code.cjs")],
  ["qol-arch-cross-platform", require("../bin/check-qol-arch-cross-platform.cjs")],
  ["qol-arch-cicd", require("../bin/check-qol-arch-cicd.cjs")],
  ["qol-logging", require("../bin/check-qol-logging.cjs")],
];

export function repoRoot(cwd, exec = execFileSync) {
  return exec("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" }).trim();
}

const IGNORED = /^(?:vendor|third_party)\//;
const MAX_SOURCE_BYTES = 400 * 1024;

export function listFiles(root, paths = [], exec = execFileSync) {
  const output = exec(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths],
    { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  return [...new Set(output.split("\0").filter(file => file && !IGNORED.test(file)))].sort();
}

export function summarize(message) {
  const paragraphs = message
    .split(/\n\s*\n/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean);
  const body = paragraphs.length > 1 ? paragraphs.slice(1) : paragraphs;
  let summary = body[0] ?? "";
  if (summary.endsWith(":") && body[1]) summary = `${summary} ${body[1]}`;
  summary = summary.replace(/\s*\n\s*-\s*/g, "; ").replace(/\s+/g, " ").replace(/:;/g, ":");
  return summary.length > 240 ? `${summary.slice(0, 237)}...` : summary;
}

function ruleTitle(text, file) {
  const sentence = text.split(/(?<=\.)\s/)[0].replace(/\.$/, "");
  const general = sentence.replace(` in ${path.basename(file)}`, "").replace(/^This edit /, "");
  return general.charAt(0).toUpperCase() + general.slice(1);
}

export function splitRule(summary, file = "") {
  const at = summary.indexOf(":");
  if (at < 0) return { rule: ruleTitle(summary, file), detail: "" };
  return {
    rule: ruleTitle(summary.slice(0, at).trim(), file),
    detail: summary.slice(at + 1).replace(/^\s*-\s*/, "").trim(),
  };
}

export function lintFiles(root, files, { hooks = HOOKS, read = readFileSync, onProgress = () => {}, sources = {} } = {}) {
  const findings = [];
  for (const [index, file] of files.entries()) {
    onProgress(index, files.length);
    const absolute = path.join(root, file);
    let content;
    try {
      content = read(absolute, "utf8");
    } catch {
      continue;
    }
    for (const [hook, module] of hooks) {
      for (const message of module.lintFile(absolute, content)) {
        const summary = summarize(message);
        const lines = locate(message, content, file, module.LOCATORS);
        findings.push({ file, hook, summary, ...splitRule(summary, file), lines, message });
        if (!(file in sources)) sources[file] = content.length > MAX_SOURCE_BYTES ? null : content;
      }
    }
  }
  return findings;
}

export function lint(cwd, paths = [], deps = {}) {
  const exec = deps.exec ?? execFileSync;
  const root = repoRoot(cwd, exec);
  const files = listFiles(root, paths, exec);
  const sources = {};
  const findings = lintFiles(root, files, { ...deps, sources });
  deps.onProgress?.(files.length, files.length);
  const byHook = {};
  for (const finding of findings) byHook[finding.hook] = (byHook[finding.hook] ?? 0) + 1;
  return { root, files: files.length, findings, byHook, sources, at: new Date().toISOString() };
}

export function renderHelp(prefix = "qac") {
  return [
    `${prefix} lint [path ...]  run the qol-arch-code, cross-platform, cicd and logging hooks over whole files (default: the whole repo)`,
    `${prefix} fix [path ...]   hand the findings to this session to fix, then re-lint (default: the ${FIX_FILE_LIMIT} files with most findings)`,
  ].join("\n");
}

export const FIX_FILE_LIMIT = 8;

export function fixGuidance(message) {
  return message
    .split(/\n\s*\n/)
    .filter(paragraph => !/^\s*(Bypass|\[qol-)/.test(paragraph))
    .join("\n\n")
    .trim();
}

export function fixBrief(result, { explicit = false, cli = "qac.mjs" } = {}) {
  const byFile = new Map();
  for (const finding of result.findings) {
    if (!byFile.has(finding.file)) byFile.set(finding.file, []);
    byFile.get(finding.file).push(finding);
  }
  const ranked = [...byFile.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const chosen = explicit ? ranked : ranked.slice(0, FIX_FILE_LIMIT);
  const files = chosen.map(([file]) => file);
  const count = chosen.reduce((sum, [, findings]) => sum + findings.length, 0);
  const rest = result.findings.length - count;
  const lines = [
    `qac fix: ${count} findings in ${files.length} files${rest > 0 ? ` (${rest} more elsewhere; run qac fix again after these)` : ""}.`,
    "Fix every finding below in place, following the qol-project:qol-arch-code and qol-arch-cross-platform skills.",
    "Never create a bypass marker, add an allow attribute, or delete code just to silence a hook. If a finding needs a design decision, stop and ask.",
    `When done, verify with: node "${cli}" lint ${files.map(file => JSON.stringify(file)).join(" ")} --pretty (expect 0 findings), then run the repo's own checks.`,
  ];
  for (const [file, findings] of chosen) {
    lines.push("", `## ${file}`);
    for (const finding of findings) {
      const at = finding.lines?.length ? ` (line ${finding.lines.join(", ")})` : "";
      lines.push("", `### [${finding.hook}] ${finding.rule}${at}`, fixGuidance(finding.message));
    }
  }
  return { text: lines.join("\n"), files, count };
}
