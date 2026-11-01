#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError, UsageError, cliMain, fail, ok, warn } from "../hooks/_kit/cli.mjs";
import { EXIT, ReviewError } from "../src/errors.mjs";
import { commandRunner } from "../src/git.mjs";
import { runNext } from "../src/next.mjs";
import { LEVEL_NAMES } from "../src/plan.mjs";
import { prettyNext, prettyScope, prettySubmit } from "../src/pretty.mjs";
import { REFERENCES } from "../src/run.mjs";
import { runScope, scopeSummary } from "../src/scope.mjs";
import { runSubmit } from "../src/submit.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const AGENTS = ["review-finder.md", "review-verifier.md"];

function guarded(run) {
  try {
    return run();
  } catch (error) {
    if (!(error instanceof ReviewError)) throw error;
    if (error.code === EXIT.usage) throw new UsageError(error.message);
    throw new CliError(error.code, error.message, error.report ? { result: error.report } : {});
  }
}

function parseLevel(value) {
  if (value === undefined) return null;
  if (!LEVEL_NAMES.includes(value)) throw new UsageError(`\`--level\` takes one of ${LEVEL_NAMES.join(", ")}, got \`${value}\``);
  return value;
}

function parseCount(value) {
  if (value === undefined) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new UsageError("`--max-jobs` takes a positive integer");
  return number;
}

function readReply(flags) {
  if (flags.in !== undefined) return readFileSync(resolve(flags.in), "utf8");
  if (process.stdin.isTTY) throw new UsageError("pipe the lane's JSON reply on stdin, or pass `--in <file>`");
  return readFileSync(0, "utf8");
}

function engineRoot(env) {
  return env.CODE_REVIEW_ENGINE_DIR || join(tmpdir(), process.getuid ? `code-review-engine-${process.getuid()}` : "code-review-engine");
}

const SPEC = {
  name: "review-engine",
  about: "Scope, plan, gate and save a code review run by the qol-code-review skill.",
  root: ROOT,
  node: 20,
  commands: [
    {
      name: "scope",
      about: "Resolve the change, triage it, plan the review and write the run folder.",
      usage: ["[<target>] [--level <level>] [--paths <a,b>] [--base <ref>] [--solo] [--max-jobs <n>]"],
      details: [
        "<target> is auto (the default), worktree, staged, branch, a branch name, a commit, a..b, a...b, #<number>, pr:<number> or a pull request URL.",
        "auto and branch review the current branch with its uncommitted changes against the default base; on the base branch itself auto reviews the uncommitted changes.",
        "The level (quick, standard, deep or max) comes from the triage, never above deep; --level max asks for the exhaustive plan.",
        "A diff over 8000 reviewable changed lines is refused: review it in parts with --paths.",
        "Exclusions (lockfiles, generated, vendored and binary files) rest on the base ref's attributes and files, never on what the head claims.",
        "Running scope again on the same head and options resumes the same run folder with the lane outputs already submitted.",
        "--solo plans one session-run pass with every lens; use it only when the user asked for a review without agents.",
      ],
      output: ["{run_dir, target, base, head, pr, level, stats, high_risk, excluded, chunks, plan, rules, rules_changed, shallow, intent, notes, next}; --pretty prints a summary."],
      exits: { [EXIT.input]: "The target cannot be reviewed as asked: a clean tree, an unresolved ref, a diff of only excluded files, or an oversized diff.", [EXIT.tool]: "A git or gh command failed." },
      positionals: { min: 0, max: 1 },
      flags: {
        "--level": { value: "level", about: "Override the suggested level: quick, standard, deep or max." },
        "--paths": { value: "paths", multiple: true, about: "Review only these comma-separated pathspecs." },
        "--base": { value: "ref", about: "Base ref for branch targets." },
        "--solo": { about: "Plan for one agent that runs every job itself." },
        "--max-jobs": { value: "n", about: "Raise or lower the finder job cap." },
      },
      json: true,
      run: (ctx) =>
        guarded(() => {
          const options = {
            level: parseLevel(ctx.flags.level),
            paths: (ctx.flags.paths ?? []).flatMap((value) => value.split(",")).map((path) => path.trim()).filter(Boolean),
            base: ctx.flags.base ?? null,
            solo: ctx.flags.solo === true,
            maxJobs: parseCount(ctx.flags.maxJobs),
          };
          return scopeSummary(runScope(ctx.args[0] ?? "auto", options, { cwd: ctx.cwd, env: ctx.env }));
        }),
      pretty: prettyScope,
    },
    {
      name: "next",
      about: "Check what the stages wrote so far and print the next stage, its jobs and any problems.",
      usage: ["<run-dir>"],
      details: [
        "Stages run in order: intent, ledger, find, hunt, verify, review, done.",
        "Each call recomputes the merge from the finder outputs, so a stale verifier result or a review written for an earlier merge is pruned or refused.",
        "The done stage writes the saved review through the qol-code-review writer and prints its paths.",
      ],
      output: ["{run_dir, stage, level, solo, action, jobs, problems, ...}; the done stage adds verdict, statement, counts, findings, review, summary and next_step. --pretty prints the stage and its jobs."],
      exits: { [EXIT.input]: "The folder is not a run of this engine.", [EXIT.tool]: "A git command failed.", [EXIT.contract]: "A stage's output broke its contract; the JSON lists every problem on stdout." },
      positionals: { min: 1, max: 1 },
      json: true,
      run: (ctx) => guarded(() => runNext(ctx.args[0], { env: ctx.env })),
      pretty: prettyNext,
    },
    {
      name: "submit",
      about: "Validate one lane's JSON reply and store it as the job's output.",
      usage: ["<run-dir> <job-id> [--agent-id <id>] [--in <file>]"],
      details: [
        "The lane replies with its result and writes nothing; the session submits the reply, so no lane needs a shell or a write tool.",
        "The reply is read from stdin, or from --in; a surrounding code fence is removed.",
        "A multi-agent run needs --agent-id, the id the runtime gave the lane, because the agent board records it.",
        "A verifier reply is stamped with the merge its job file was written for.",
      ],
      output: ["{run_dir, job, output, agent_id, failed, next}; --pretty prints one line."],
      exits: { [EXIT.input]: "The folder is not a run, or the job id is not one of its jobs.", [EXIT.contract]: "The reply broke the contract; the problems are on stderr and nothing was stored." },
      positionals: { min: 2, max: 2 },
      flags: {
        "--agent-id": { value: "id", about: "The agent id the runtime returned for the lane." },
        "--in": { value: "file", about: "Read the reply from this file instead of stdin." },
      },
      json: true,
      run: (ctx) =>
        guarded(() => {
          const reply = readReply(ctx.flags);
          return runSubmit(ctx.args[0], ctx.args[1], reply, { agentId: ctx.flags.agentId });
        }),
      pretty: prettySubmit,
    },
  ],
  checks: [
    {
      id: "git",
      about: "git is installed.",
      run: (ctx) => {
        const version = commandRunner("git", ctx.cwd, { env: ctx.env })(["--version"], { allowFail: true });
        return version ? ok(version.trim()) : fail("git is not on the PATH", "Install git.");
      },
    },
    {
      id: "gh",
      about: "gh is installed, which pull request targets need.",
      run: (ctx) => {
        const version = commandRunner("gh", ctx.cwd, { env: ctx.env })(["--version"], { allowFail: true });
        return version ? ok(version.split("\n")[0]) : warn("gh is not on the PATH, so pull request targets cannot be resolved", "Install gh and run gh auth login.");
      },
    },
    {
      id: "agents",
      about: "The lane agents exist and can only read.",
      run: () => {
        for (const name of AGENTS) {
          const file = join(ROOT, "agents", name);
          if (!existsSync(file)) return fail(`${name} is missing`, "Restore the plugin's agents folder.");
          const tools = /^tools:\s*(.+)$/m.exec(readFileSync(file, "utf8"))?.[1].split(",").map((tool) => tool.trim()).join(",");
          if (tools !== "Read,Glob,Grep") return fail(`${name} grants ${tools ?? "no tools line"}, not Read, Glob, Grep`, "Restore the plugin's agents folder.");
        }
        return ok("review-finder and review-verifier read only");
      },
    },
    {
      id: "references",
      about: "The lane prompts and the lens guide exist.",
      run: () => {
        const missing = ["engine-finder-prompt.md", "engine-verifier-prompt.md", "engine-ledger-prompt.md", "engine-hunt-prompt.md", "engine-lenses.md"].filter((name) => !existsSync(join(REFERENCES, name)));
        return missing.length === 0 ? ok("lane prompts and the lens guide are present") : fail(`missing ${missing.join(", ")}`, "Restore the skill's references folder.");
      },
    },
    {
      id: "run_root",
      about: "The run folder is private to you.",
      run: (ctx) => {
        const root = engineRoot(ctx.env);
        if (!existsSync(root)) return ok(`${root} will be created with mode 0700`);
        const stat = statSync(root);
        const uid = process.getuid?.();
        if (uid !== undefined && (stat.uid !== uid || (stat.mode & 0o077) !== 0)) return fail(`${root} is open to other users`, `Remove ${root}, or set CODE_REVIEW_ENGINE_DIR to another folder.`);
        return ok(`${root} is private`);
      },
    },
  ],
};

export const run = (io) => cliMain(SPEC, io);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await run();
}
