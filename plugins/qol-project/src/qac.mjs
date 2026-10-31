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
  ["qol-plugin-data", require("../bin/check-qol-plugin-data.cjs")],
  ["qol-plugin-contract", require("../bin/check-qol-plugin-contract.cjs")],
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

// Rules about added code compare each file with its content at the base
// revision: an unchanged file is its own baseline, a file new since the base
// has none. Without a base every line counts as added.
export function baselineReader(root, base, exec = execFileSync) {
  if (!base) return () => null;
  const run = args => exec("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const changed = new Set([
    ...run(["diff", "--name-only", "-z", base, "--"]).split("\0"),
    ...run(["ls-files", "-z", "--others", "--exclude-standard"]).split("\0"),
  ].filter(Boolean));
  return (file, content) => {
    if (!changed.has(file)) return content;
    try {
      return run(["show", `${base}:${file}`]);
    } catch {
      return null;
    }
  };
}

export function lintFiles(root, files, { hooks = HOOKS, read = readFileSync, onProgress = () => {}, sources = {}, baseline = () => null } = {}) {
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
    const before = baseline(file, content);
    for (const [hook, module] of hooks) {
      for (const message of module.lintFile(absolute, content, before)) {
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
  const baseline = baselineReader(root, deps.base, exec);
  const findings = lintFiles(root, files, { ...deps, sources, baseline });
  deps.onProgress?.(files.length, files.length);
  const byHook = {};
  for (const finding of findings) byHook[finding.hook] = (byHook[finding.hook] ?? 0) + 1;
  return { root, files: files.length, findings, byHook, sources, at: new Date().toISOString() };
}

export function renderHelp(prefix = "qac") {
  return [
    `${prefix} lint [path ...]  run the qol-arch-code, cross-platform, cicd, logging, plugin data and plugin-contract hooks over whole files (default: the whole repo)`,
    `  --base=<rev>           judge rules about added code against <rev>, as the edit-time hooks judge an edit`,
    `${prefix} fix [path ...]   hand the findings to this session to fix, then re-lint (default: the ${FIX_FILE_LIMIT} files with most findings)`,
    `${prefix} slip <pattern>   record a pattern qac missed; its first sight forks a claude (opus, high) lane to add the rule`,
    `  --from=<url>           where it was found, such as the pull request`,
    `  --added                mark the rule added; --infeasible=<reason> marks it infeasible, and no lane is forked for it again`,
    `  --rules-repo=<path>    the qol-skills clone the lane works in (default: this repo's main checkout or its qol-skills sibling)`,
    `${prefix} slip --fingerprint=<fp> --from=<source>  record a gate finding that a rule should catch; a fingerprint seen in two loops forks a rule lane`,
    `${prefix} slip --fingerprint=<fp> --added|--infeasible=<reason>  settle the existing entry of that fingerprint; --from is not needed`,
    `  --entry=<id>           settle exactly that ledger entry (ids look like fp-<repo>-<fp>); a lane brief always carries it, because two repos can share a fingerprint`,
    `  --judge=<id> --rule=<rule> --message=<text>  what the finding said`,
    `  --loop=<key>           the loop that saw it (sightings without one count by --from)`,
    `  --route=<route>        qac-check, repo-linter, tamper, agent-behaviour or judge-revert`,
    `${prefix} slips            list recorded patterns and their status`,
    `${prefix} gate            judge the working tree with the repo's judges and print a verdict as JSON (gate.json goes to --out); run from any folder of the repo, it judges the whole worktree`,
    `  --cwd=<dir>            the repo to judge (default: the current directory)`,
    `  --base=<rev>           compare with <rev> (default: HEAD)`,
    `  --out=<dir>            where gate.json and the judge logs go (default: <git-common-dir>/qac/last-gate)`,
    `  --accept=<file>        JSON array of { "id", "argv" } acceptance commands, each run as a test judge`,
    `  --owned=<file>         JSON array of globs; a changed file outside them is a tamper entry`,
    `  --spec=<file> --spec-sha=<sha>  the frozen spec and its sha256; a different sha is a tamper entry`,
    `  --baseline=<gate.json> findings already in that gate do not count`,
    `  --exclude-finding=<fp>=<file>  drop the findings with that fingerprint in that repo-relative file, and only those (repeatable; an empty file matches a finding with no file)`,
    `  --loop=<key> --attempt=<n>  tag the gate and its index line`,
    `  --keep                 keep the judge logs of earlier runs in --out`,
    `  A typed "${prefix} gate" prompt stops after 110 s, but judges it already started keep running to their own timeout; run long judge sets from a terminal.`,
    `${prefix} trust [approve]  exit 0 when every judge, setup command and --accept command is approved, 1 when anything is not; approve records the approval`,
    `  --accept=<file>        the acceptance commands to check or approve`,
    `${prefix} traps           list findings caught on the first attempt in several loops of this repo`,
    `  --min=<n>              loops needed (default: 2)`,
    `${prefix} init            write a starter judges config detected from the repo`,
    `  --exclude              keep the config out of the repository, in the per-user config folder`,
    `Every verb takes --pretty for text instead of JSON, and --cwd=<dir>.`,
    `Exit codes: 0 clean, 1 findings (trust: something untrusted), 2 usage, 3 not a git repository, 4 slip lane could not be forked, 5 could not judge, 6 only flaky judges failed.`,
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
