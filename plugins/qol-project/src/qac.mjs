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

export function lintFiles(root, files, { hooks = HOOKS, read = readFileSync, onProgress = () => {} } = {}) {
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
        findings.push({ file, hook, summary, ...splitRule(summary, file), message });
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
  deps.onProgress?.(files.length, files.length);
  const byHook = {};
  for (const finding of findings) byHook[finding.hook] = (byHook[finding.hook] ?? 0) + 1;
  return { root, files: files.length, findings, byHook, at: new Date().toISOString() };
}

export function renderHelp(prefix = "qac") {
  return [
    `${prefix} lint [path ...]  run the qol-arch-code, cross-platform, cicd and logging hooks over whole files (default: the whole repo)`,
    `${prefix} help             list these verbs`,
  ].join("\n");
}
