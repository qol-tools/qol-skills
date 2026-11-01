import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after } from "node:test";
import { run } from "../scripts/review-engine.mjs";
import { ENV, candidate, commit, finderOutput, makeRepo, numbered, tempRoot, writeJson, test } from "./engine-helpers.mjs";

const root = tempRoot();
after(() => fs.rmSync(root, { recursive: true, force: true }));

async function cli(argv, { cwd = root, environ = {} } = {}) {
  let out = "";
  let err = "";
  const code = await run({ argv, cwd, environ: { ...ENV, ...environ }, stdout: { write: (text) => (out += text) }, stderr: { write: (text) => (err += text) } });
  return { code, out, err };
}

function repo(name) {
  const dir = makeRepo(root, name);
  commit(dir, { "src/app.js": numbered(20) }, "base");
  const head = commit(dir, { "src/app.js": numbered(60) }, "change");
  return { dir, head, environ: { CODE_REVIEW_ENGINE_DIR: path.join(root, `${name}-out`) } };
}

test("help, version and doctor follow the CLI standard", async () => {
  const help = await cli(["help"]);
  assert.equal(help.code, 0);
  for (const verb of ["scope", "next", "submit", "doctor", "version"]) assert.match(help.out, new RegExp(`^  ${verb}\\s`, "m"));
  const scope = await cli(["scope", "help"]);
  assert.equal(scope.code, 0);
  for (const flag of ["--level", "--paths", "--base", "--solo", "--max-jobs"]) assert.ok(scope.out.includes(flag), flag);
  assert.deepEqual((await cli(["help", "scope"])).out, scope.out);
  const version = await cli(["version"]);
  assert.deepEqual(JSON.parse(version.out), { plugin_id: "qol-code-review", version: JSON.parse(fs.readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8")).version });
  const doctor = JSON.parse((await cli(["doctor"], { environ: { CODE_REVIEW_ENGINE_DIR: path.join(root, "doctor-out") } })).out);
  assert.equal(doctor.plugin_id, "qol-code-review");
  assert.deepEqual(doctor.checks.map((check) => check.id), ["node_version", "plugin_json", "git", "gh", "agents", "references", "run_root"]);
  assert.equal(doctor.checks.find((check) => check.id === "agents").status, "ok");
  assert.equal((await cli(["doctor", "agents"])).code, 0);
});

test("usage errors exit 2", async () => {
  for (const argv of [["scope", "--level", "turbo"], ["scope", "--max-jobs", "0"], ["scope", "--bogus"], ["next"], ["submit", "only-one"], ["scope", "--json", "--pretty"], ["frobnicate"]]) {
    const result = await cli(argv);
    assert.equal(result.code, 2, argv.join(" "));
  }
});

test("scope prints one JSON object, and next and submit carry a run through the engine", async () => {
  const { dir, head, environ } = repo("cli-run");
  const scoped = await cli(["scope", head, "--level", "standard"], { cwd: dir, environ });
  assert.equal(scoped.code, 0, scoped.err);
  const summary = JSON.parse(scoped.out);
  assert.equal(summary.level.used, "standard");
  assert.equal(summary.next, `next ${summary.run_dir}`);
  const pretty = await cli(["scope", head, "--level", "standard", "--pretty"], { cwd: dir, environ });
  assert.match(pretty.out, /^run .*\ntarget commit .*\nlevel standard/m);
  assert.match(pretty.out, new RegExp(`next review-engine next ${summary.run_dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  const first = await cli(["next", summary.run_dir], { environ });
  assert.equal(JSON.parse(first.out).stage, "intent");
  writeJson(path.join(summary.run_dir, "intent.json"), { source: "none", summary: "no stated intent", requirements: [], claims: [] });
  const find = JSON.parse((await cli(["next", summary.run_dir], { environ })).out);
  assert.equal(find.stage, "find");
  const job = find.jobs[0];
  const reply = path.join(root, "reply.json");
  const scope = JSON.parse(fs.readFileSync(path.join(summary.run_dir, "scope.json"), "utf8"));
  fs.writeFileSync(reply, JSON.stringify(finderOutput(scope, scope.plan.jobs[0], [candidate()], { agent_id: undefined })));
  const missing = await cli(["submit", summary.run_dir, job.id, "--in", reply], { environ });
  assert.equal(missing.code, 2);
  const stored = await cli(["submit", summary.run_dir, job.id, "--in", reply, "--agent-id", "agent-1"], { environ });
  assert.equal(stored.code, 0, stored.err);
  assert.equal(JSON.parse(stored.out).agent_id, "agent-1");
  fs.writeFileSync(reply, "not json");
  const bad = await cli(["submit", summary.run_dir, find.jobs[1].id, "--in", reply, "--agent-id", "agent-2"], { environ });
  assert.equal(bad.code, 5);
  assert.match(bad.err, /the reply is not JSON/);
});

test("next exits 3 outside a run and 5 with the problems on stdout", async () => {
  const outside = await cli(["next", path.join(root, "nowhere")]);
  assert.equal(outside.code, 3);
  assert.match(outside.err, /is not a code-review engine run/);
  const { dir, head, environ } = repo("cli-problems");
  const summary = JSON.parse((await cli(["scope", head], { cwd: dir, environ })).out);
  writeJson(path.join(summary.run_dir, "intent.json"), { source: "stated" });
  const broken = await cli(["next", summary.run_dir], { environ });
  assert.equal(broken.code, 5);
  assert.equal(JSON.parse(broken.out).stage, "intent");
  assert.equal(JSON.parse(broken.out).problems.length, 2);
  const pretty = await cli(["next", summary.run_dir, "--pretty"], { environ });
  assert.match(pretty.out, /^problem intent\.summary is missing/m);
});

test("scope exits 3 for a target that cannot be reviewed", async () => {
  const { dir, environ } = repo("cli-clean");
  const result = await cli(["scope", "worktree"], { cwd: dir, environ });
  assert.equal(result.code, 3);
  assert.match(result.err, /the working tree has no uncommitted changes/);
});
