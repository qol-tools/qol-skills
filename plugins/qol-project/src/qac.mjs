import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

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

export function listFiles(root, paths = [], exec = execFileSync) {
  const output = exec(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", ...paths],
    { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  return [...new Set(output.split("\0").filter(Boolean))].sort();
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

export function lintFiles(root, files, { hooks = HOOKS, read = readFileSync } = {}) {
  const findings = [];
  for (const file of files) {
    const absolute = path.join(root, file);
    let content;
    try {
      content = read(absolute, "utf8");
    } catch {
      continue;
    }
    for (const [hook, module] of hooks) {
      for (const message of module.lintFile(absolute, content)) {
        findings.push({ file, hook, summary: summarize(message), message });
      }
    }
  }
  return findings;
}

export function lint(cwd, paths = [], deps = {}) {
  const exec = deps.exec ?? execFileSync;
  const root = repoRoot(cwd, exec);
  const files = listFiles(root, paths, exec);
  const findings = lintFiles(root, files, deps);
  const byHook = {};
  for (const finding of findings) byHook[finding.hook] = (byHook[finding.hook] ?? 0) + 1;
  return { root, files: files.length, findings, byHook };
}

export function renderLint(result, prefix = "qac") {
  const lines = [`${prefix} lint: ${result.files} files, ${result.findings.length} findings`];
  for (const [hook] of HOOKS) {
    const findings = result.findings.filter(finding => finding.hook === hook);
    if (findings.length === 0) continue;
    lines.push("", `${hook} (${findings.length})`);
    for (const finding of findings) lines.push(`  ${finding.file}  ${finding.summary}`);
  }
  return lines.join("\n");
}

export function renderHelp(prefix = "qac") {
  return [
    `${prefix} lint [path ...]  run the qol-arch-code, cross-platform, cicd and logging hooks over whole files (default: the whole repo)`,
    `${prefix} help             list these verbs`,
  ].join("\n");
}
