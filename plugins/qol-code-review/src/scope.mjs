import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { classifyFile, generatedMarker } from "./classify.mjs";
import { changedLines, headRange, pairSections, parseNameStatus, runs, sectionText } from "./diff.mjs";
import { inputError, toolError } from "./errors.mjs";
import { commandRunner, materializeTree } from "./git.mjs";
import { CHUNK_LINES, MAX_CHANGED, buildChunks, buildPlan, reviewableChanged, suggestLevel } from "./plan.mjs";
import { REFERENCES, RUBRIC, jobInputs, outRoot, outputPath, runPaths, writeJson, writeText } from "./run.mjs";
import { collectContext, commitsInRange, findRules, intentMarkdown, isRuleFile, rulesMarkdown } from "./sources.mjs";
import { LIMITS } from "./schema.mjs";
import { linkedIssues, pullRequestInfo, viewPullRequest } from "./github.mjs";
import { branchName, parseTarget, resolveTarget } from "./target.mjs";

const require = createRequire(import.meta.url);
const DETECTOR = require.resolve("../skills/qol-code-review/scripts/shallow-wrappers.cjs");
const DIFF_ARGS = ["-c", "core.quotePath=false", "-c", "diff.interHunkContext=0", "-c", "diff.algorithm=myers", "diff", "--no-color", "--no-ext-diff", "--no-textconv", "--submodule=short", "-M", "--src-prefix=a/", "--dst-prefix=b/", "-U3"];
export { LIMITS };

const NUL_WINDOW = 8000;

function basePreview(git, base, file) {
  if (file.status === "A" || file.binary) return "";
  return (git(["show", `${base.sha}:${file.old_path ?? file.path}`], { allowFail: true }) ?? "").slice(0, 1024);
}

function baseBinary(git, base, file) {
  if (file.status === "A" || !file.binary) return null;
  const text = git(["show", `${base.sha}:${file.old_path ?? file.path}`], { allowFail: true });
  return text === null ? null : text.slice(0, NUL_WINDOW).includes("\0");
}

function attributes(git, sha, paths) {
  const raw = git(["check-attr", `--source=${sha}`, "-z", "--stdin", "linguist-generated", "linguist-vendored"], { input: `${paths.join("\0")}\0`, allowFail: true }) ?? "";
  const fields = raw.split("\0");
  const result = { generated: new Set(), vendored: new Set() };
  for (let at = 0; at + 2 < fields.length; at += 3) {
    if (!["set", "true"].includes(fields[at + 2])) continue;
    (fields[at + 1] === "linguist-generated" ? result.generated : result.vendored).add(fields[at]);
  }
  return result;
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "repo";
}

function shortHash(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 6);
}

function breakdown(files) {
  const byDir = new Map();
  for (const file of files.filter((item) => !item.excluded)) {
    const top = file.path.includes("/") ? file.path.slice(0, file.path.indexOf("/")) : ".";
    byDir.set(top, (byDir.get(top) ?? 0) + file.added + file.removed);
  }
  return [...byDir].sort((left, right) => right[1] - left[1]).slice(0, 8).map(([dir, count]) => `${dir} (${count})`).join(", ");
}

function publicFile(file) {
  const { path, old_path, status, kind, language, added, removed, excluded, exclude_reason, signals, tier } = file;
  const addedLines = file.hunks.flatMap((hunk) => changedLines(hunk).added.map((item) => item.line));
  return { path, old_path, status, kind, language, added, removed, excluded, exclude_reason, signals, tier, head_hunks: file.hunks.map(headRange).filter(Boolean), added_runs: runs(addedLines) };
}

function shallowWrappers(tree, diff) {
  const report = require(DETECTOR).run({ root: tree, diff, files: [], includeTests: false });
  const entries = [
    ...report.wrappers.map((item) => ({ file: item.file, line: item.line, name: item.name, callee: item.callee })),
    ...report.reexports.map((item) => ({ file: item.file, line: item.line, name: item.alias, callee: item.path })),
  ].sort((left, right) => (left.file < right.file ? -1 : left.file > right.file ? 1 : left.line - right.line));
  return { scanned: report.scanned, entries, report };
}

function descriptor(job, context) {
  const { paths, scope, chunks } = context;
  const base = {
    id: job.id,
    kind: job.kind,
    run_dir: paths.dir,
    repo: scope.repo,
    tree: scope.tree,
    base_tree: scope.base_tree,
    base: scope.base,
    head: { ref: scope.head.ref, sha: scope.head.sha },
    rubric: RUBRIC,
    instructions: join(REFERENCES, job.kind === "finder" ? "engine-finder-prompt.md" : `engine-${job.kind}-prompt.md`),
    lens_guide: join(REFERENCES, "engine-lenses.md"),
    inputs: jobInputs(scope, paths, { ledger: job.kind !== "ledger" }),
    output: outputPath(paths, job),
    limits: LIMITS,
  };
  if (job.kind === "finder") {
    const chunk = chunks.find((item) => item.id === job.chunk);
    return {
      ...base,
      lenses: job.lenses,
      pass: job.pass,
      chunk: { id: chunk.id, patch: join(paths.chunks, `${chunk.id}.patch`), changed: chunk.changed, files: chunk.files.map(({ path, changed, focus }) => ({ path, changed, focus })) },
      file_order: job.file_order,
      hunk_order: job.hunk_order,
    };
  }
  if (job.kind === "ledger") return { ...base, items: job.items };
  return { ...base, lenses: scope.plan.lenses, inputs: { ...base.inputs, candidates: paths.candidates } };
}

export function runScope(input, options = {}, deps = {}) {
  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const probe = commandRunner("git", cwd, { exec: deps.exec, env });
  const toplevel = (probe(["rev-parse", "--show-toplevel"], { allowFail: true }) ?? "").trim();
  if (!toplevel) throw inputError(`${cwd} is not inside a git repository`);
  const git = commandRunner("git", toplevel, { exec: deps.exec, env });
  const gh = deps.gh ?? commandRunner("gh", toplevel, { exec: deps.exec, env });
  const target = resolveTarget(parseTarget(input), { git, gh, base: options.base ?? null });
  const pathspecs = options.paths ?? [];
  const range = [target.base.sha, target.head.sha, "--", ...pathspecs];
  const entries = parseNameStatus(git([...DIFF_ARGS, "--name-status", "-z", ...range]));
  if (entries.length === 0) {
    throw inputError(`nothing to review: ${target.head.ref} has no changes against ${target.base.ref}${pathspecs.length ? ` under ${pathspecs.join(", ")}` : ""}`);
  }
  const patch = git([...DIFF_ARGS, "--patch", ...range]);
  const diffFiles = pairSections(entries, patch);
  if (!diffFiles) throw toolError("git diff printed a patch that does not match its file list");
  const root = outRoot(env);
  const tree = materializeTree(git, target.head.sha, root);
  const baseTree = materializeTree(git, target.base.sha, root);
  const attrs = attributes(git, target.base.sha, entries.flatMap((entry) => [entry.path, entry.old_path]).filter(Boolean));
  const files = diffFiles.map((file) => {
    const named = (set) => set.has(file.path) || set.has(file.old_path);
    const generated = named(attrs.generated) || generatedMarker(basePreview(git, target.base, file));
    return { ...file, ...classifyFile({ ...file, generated, vendored: named(attrs.vendored), base_binary: baseBinary(git, target.base, file) }) };
  });
  if (files.every((file) => file.excluded)) {
    throw inputError(`nothing to review: every changed file is excluded (${files.slice(0, 8).map((file) => `${file.path}: ${file.exclude_reason}`).join(", ")})`);
  }
  const changed = reviewableChanged(files);
  if (changed > MAX_CHANGED) {
    throw inputError(`the diff has ${changed} reviewable changed lines, over the ${MAX_CHANGED}-line limit; review it in parts with --paths (largest: ${breakdown(files)})`);
  }
  const suggestion = suggestLevel(files);
  const level = options.level ?? suggestion.level;
  const chunks = buildChunks(files, CHUNK_LINES);
  const runId = [
    slug(basename(toplevel)),
    target.head.sha.slice(0, 7),
    target.base.sha.slice(0, 7),
    level,
    options.solo ? "solo" : null,
    pathspecs.length ? shortHash(pathspecs.join("\0")) : null,
    options.maxJobs ? `j${options.maxJobs}` : null,
  ].filter(Boolean).join("-");
  const plan = buildPlan({ chunks, files, level, solo: Boolean(options.solo), maxJobs: options.maxJobs ?? null, seed: runId });
  if (plan.over_cap) {
    throw inputError(`the ${level} plan needs more than ${plan.job_cap} finder jobs even with every lens in one job per chunk; raise --max-jobs or narrow --paths`);
  }
  const paths = runPaths(join(root, "runs", runId));
  writeText(paths.diff, patch);
  const shallow = shallowWrappers(tree, paths.diff);
  writeJson(paths.shallow, shallow.report);
  const rules = findRules(git, target.base.tip, files.flatMap((file) => [file.path, file.old_path].filter(Boolean)));
  let pr = target.pr ?? null;
  const notes = [...target.notes];
  if (!pr && target.kind === "branch" && target.head.ref !== "HEAD" && options.lookupPr !== false) {
    const view = viewPullRequest(gh, target.head.ref);
    if (view && view.state === "OPEN") {
      const diffed = branchName(git, target.base.ref);
      if (view.baseRefName === diffed) pr = pullRequestInfo(view);
      else notes.push(`open pull request #${view.number} targets ${view.baseRefName}, not ${diffed}; pass --base ${view.baseRefName} to review it against that base`);
    }
  }
  if (pr) pr.head_matches = pr.head_sha === target.head.sha;
  const commits = commitsInRange(git, target.base, target.head);
  const issues = linkedIssues(gh, pr);
  const scope = {
    version: 1,
    run_id: runId,
    run_dir: paths.dir,
    repo: toplevel,
    tree,
    base_tree: baseTree,
    target: { kind: target.kind, input: target.input },
    base: target.base,
    head: target.head,
    pr: pr ? { ...pr, body: undefined } : null,
    notes,
    paths: pathspecs,
    stats: {
      files: files.length,
      reviewable_files: files.filter((file) => !file.excluded).length,
      excluded_files: files.filter((file) => file.excluded).length,
      added: files.reduce((sum, file) => sum + file.added, 0),
      removed: files.reduce((sum, file) => sum + file.removed, 0),
      reviewable_changed: changed,
      tiers: Object.fromEntries(["high", "medium", "low"].map((tier) => [tier, files.filter((file) => tier === file.tier).length])),
    },
    files: files.map(publicFile),
    chunks: chunks.map((chunk) => ({ ...chunk, files: chunk.files.map(({ path, changed: lines, focus }) => ({ path, changed: lines, focus })), patch: join(paths.chunks, `${chunk.id}.patch`) })),
    level: { used: level, suggested: suggestion.level, forced: Boolean(options.level), trivial: suggestion.trivial, reasons: suggestion.reasons },
    plan,
    rules,
    rules_changed: files.filter((file) => isRuleFile(file.path) || (file.old_path && isRuleFile(file.old_path))).map((file) => file.path),
    intent: { sources: paths.intentSources, pr: Boolean(pr), commits: commits.length, issues: issues.length },
    shallow: { scanned: shallow.scanned, entries: shallow.entries },
    limits: { chunk_lines: CHUNK_LINES, max_changed: MAX_CHANGED, ...LIMITS },
  };
  const byName = new Map(files.map((file) => [file.path, file]));
  for (const chunk of chunks) {
    writeText(join(paths.chunks, `${chunk.id}.patch`), `${chunk.files.map((entry) => sectionText(byName.get(entry.path), entry.hunks)).join("\n")}\n`);
  }
  const markdown = rulesMarkdown(git, target.base, rules);
  if (markdown) writeText(paths.rules, markdown);
  writeText(paths.intentSources, intentMarkdown({ target, pr, commits, issues }));
  if (plan.context) writeJson(paths.context, collectContext(git, target, files));
  const context = { paths, scope, chunks };
  for (const job of [...plan.jobs, plan.ledger, plan.hunt].filter(Boolean)) {
    writeJson(join(paths.jobs, `${job.id}.json`), descriptor(job, context));
  }
  writeJson(paths.scope, scope);
  return scope;
}

export function scopeSummary(scope) {
  return {
    run_dir: scope.run_dir,
    target: scope.target,
    base: { ref: scope.base.ref, sha: scope.base.sha },
    head: { ref: scope.head.ref, sha: scope.head.sha, snapshot: scope.head.snapshot },
    pr: scope.pr ? { number: scope.pr.number, url: scope.pr.url, draft: scope.pr.draft, head_matches: scope.pr.head_matches } : null,
    level: scope.level,
    stats: scope.stats,
    high_risk: scope.files.filter((file) => file.tier === "high").map((file) => ({ path: file.path, signals: file.signals })),
    excluded: scope.files.filter((file) => file.excluded).map((file) => ({ path: file.path, reason: file.exclude_reason })),
    chunks: scope.chunks.length,
    plan: {
      solo: scope.plan.solo,
      lenses: scope.plan.lenses,
      passes: scope.plan.passes,
      finder_jobs: scope.plan.jobs.length,
      reductions: scope.plan.reductions,
      ledger: Boolean(scope.plan.ledger),
      hunt: Boolean(scope.plan.hunt),
      verify: scope.plan.verify,
    },
    rules: scope.rules.map((rule) => rule.path),
    rules_changed: scope.rules_changed,
    shallow: { scanned: scope.shallow.scanned, entries: scope.shallow.entries.length },
    intent: scope.intent,
    notes: scope.notes,
    next: `next ${scope.run_dir}`,
  };
}
