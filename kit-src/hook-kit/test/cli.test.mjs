import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CliError, UsageError, cliMain, fail, ok, warn } from "../cli.mjs";

const roots = [];

function pluginRoot(plugin = { name: "demo-plugin", version: "1.2.3" }) {
  const root = mkdtempSync(path.join(tmpdir(), "cli-kit-"));
  roots.push(root);
  if (plugin !== null) {
    mkdirSync(path.join(root, ".claude-plugin"));
    writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), typeof plugin === "string" ? plugin : JSON.stringify(plugin));
  }
  return root;
}

test.after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function makeSpec(overrides = {}) {
  return {
    name: "demo",
    about: "Demo CLI.",
    root: pluginRoot(),
    commands: [
      {
        name: "sync",
        about: "Sync things.",
        usage: ["[--force] [--limit <n>] [--tag <t>]", "<name>"],
        details: ["Syncs everything.", "Never deletes."],
        output: "{synced, flags, args}",
        exits: { 3: "nothing to sync", 4: "the remote refused" },
        flags: { "--force": { short: "-f" }, "--limit": { value: "n" }, "--tag": { value: "t", multiple: true } },
        positionals: { min: 0, max: 1 },
        json: true,
        run: async (ctx) => {
          if (ctx.args[0] === "none") throw new CliError(3, "nothing to sync", { result: { synced: 0 } });
          if (ctx.args[0] === "bad") throw new UsageError("name must not be bad");
          if (ctx.args[0] === "boom") throw new Error("kaboom");
          if (ctx.args[0] === "undeclared") throw new CliError(9, "nope");
          return { synced: 1, flags: ctx.flags, args: ctx.args, cwd: ctx.cwd };
        },
        pretty: (result) => `synced ${result.synced}`,
      },
      {
        name: "serve",
        about: "Serve.",
        run: (ctx) => {
          ctx.stdout.write("serving\n");
        },
      },
      {
        name: "note",
        about: "Print a note.",
        usage: "<text>",
        positionals: 1,
        run: (ctx) => `note: ${ctx.args[0]}`,
      },
      {
        name: "autoinject",
        about: "Manage the autoinject list.",
        commands: [
          { name: "add", about: "Add an entry.", usage: "<entry>", positionals: 1, json: true, run: (ctx) => ({ added: ctx.args[0] }) },
          { name: "list", about: "List entries.", json: true, run: () => ({ entries: [] }) },
        ],
      },
    ],
    checks: [{ id: "bin_present", about: "The helper binary exists.", run: () => ok("found") }],
    ...overrides,
  };
}

async function run(spec, argv, extra = {}) {
  const out = [];
  const err = [];
  const code = await cliMain(spec, { argv, stdout: { write: (text) => out.push(text) }, stderr: { write: (text) => err.push(text) }, cwd: "/work", ...extra });
  return { code, out: out.join(""), err: err.join("") };
}

test("every help form of a command prints the same text", async () => {
  const spec = makeSpec();
  const forms = [["help", "sync"], ["sync", "help"], ["sync", "--help"], ["sync", "-h"], ["--help", "sync"], ["sync", "help", "--pretty"]];
  const [first, ...rest] = await Promise.all(forms.map((argv) => run(spec, argv)));
  assert.equal(first.code, 0);
  assert.match(first.out, /^demo sync\n\nSync things\.\n\nUsage:\n {2}demo sync \[--force\] \[--limit <n>\] \[--tag <t>\]\n {2}demo sync <name>\n {2}demo sync help\n {2}demo help sync\n/);
  for (const other of rest) assert.deepEqual(other, first);
});

test("command help has Details, Output and Exit sections and subcommand rows", async () => {
  const spec = makeSpec();
  const sync = (await run(spec, ["help", "sync"])).out;
  assert.match(sync, /\nDetails:\n {2}Syncs everything\.\n {2}Never deletes\.\n/);
  assert.match(sync, /\nOutput:\n {2}\{synced, flags, args\}\n {2}Supports --json\.\n/);
  assert.match(sync, /\nExit:\n {2}2 {2}Usage error[^\n]*\n {2}3 {2}nothing to sync\n {2}4 {2}the remote refused\n$/);
  const group = (await run(spec, ["autoinject", "help"])).out;
  assert.match(group, /\nSubcommands:\n {2}add {15} Add an entry\.\n {2}list {14} List entries\.\n$/);
  const note = (await run(spec, ["help", "note"])).out;
  assert.match(note, /Plain-text stdout; diagnostics on stderr\.\n {2}Does not support --json: it exits 2\./);
});

test("general help lists every command, doctor, version and help, and the global flags", async () => {
  const spec = makeSpec();
  const { code, out } = await run(spec, ["help"]);
  assert.equal(code, 0);
  assert.match(out, /^demo\n\nDemo CLI\.\n\nUsage:\n {2}demo <command> \[args\]\n {2}demo help <command>\n {2}demo <command> help\n\nCommands:\n/);
  const rows = out.split("\nCommands:\n")[1].split("\n\n")[0].split("\n").map((line) => line.trim().split(/\s+/)[0]);
  assert.deepEqual(rows, ["autoinject", "doctor", "help", "note", "serve", "sync", "version"]);
  assert.match(out, /\nGlobal flags:\n {2}--json /);
  assert.match(out, /--prefix=<name>/);
  assert.deepEqual(await run(spec, ["--help"]), await run(spec, ["help"]));
  assert.deepEqual(await run(spec, ["-h"]), await run(spec, ["help"]));
});

test("a bare call prints help, or runs the default command", async () => {
  assert.equal((await run(makeSpec(), [])).out, (await run(makeSpec(), ["help"])).out);
  const spec = makeSpec({ defaultCommand: "sync" });
  const bare = await run(spec, []);
  assert.equal(bare.code, 0);
  assert.equal(JSON.parse(bare.out).synced, 1);
  const flagged = await run(spec, ["--force", "--pretty"]);
  assert.equal(flagged.out, "synced 1\n");
  assert.match((await run(spec, ["help"])).out, /\n {2}demo {2}# runs sync\n/);
  const nested = makeSpec({ defaultCommand: ["autoinject", "list"] });
  assert.deepEqual(JSON.parse((await run(nested, [])).out), { entries: [] });
});

test("help in the middle exits 2 and names the right forms", async () => {
  const spec = makeSpec();
  for (const argv of [["autoinject", "help", "add"], ["help", "autoinject", "help"], ["sync", "help", "extra"]]) {
    const { code, out, err } = await run(spec, argv);
    assert.equal(code, 2, argv.join(" "));
    assert.equal(out, "");
    assert.match(err, /^demo: `help` goes first or last, never in the middle: run `demo help [^`]+` or `demo [^`]+ help`/);
  }
  assert.match((await run(spec, ["autoinject", "help", "add"])).err, /`demo help autoinject add` or `demo autoinject add help`/);
});

test("help help says that help takes a command name", async () => {
  const { code, out, err } = await run(makeSpec(), ["help", "help"]);
  assert.equal(code, 2);
  assert.equal(out, "");
  assert.match(err, /^demo: `help` takes a command name, not another `help`: run `demo help <command>`, or `demo help` for the commands\n/);
  assert.doesNotMatch(err, /goes first or last/);
  assert.match((await run(makeSpec(), ["--prefix=de", "help", "help", "--pretty"])).err, /run `de help <command>`/);
});

test("a literal help word follows --", async () => {
  const { code, out } = await run(makeSpec(), ["note", "--", "help"]);
  assert.equal(code, 0);
  assert.equal(out, "note: help\n");
});

test("help --json prints the command tree", async () => {
  const spec = makeSpec();
  const { code, out } = await run(spec, ["help", "--json"]);
  assert.equal(code, 0);
  const tree = JSON.parse(out);
  assert.equal(tree.name, "demo");
  assert.equal(tree.about, "Demo CLI.");
  assert.deepEqual(tree.commands.map((command) => command.name), ["sync", "serve", "note", "autoinject", "doctor", "version"]);
  const sync = tree.commands[0];
  assert.deepEqual(sync.exits.map((entry) => entry.code), [2, 3, 4]);
  assert.equal(sync.json, true);
  assert.equal(tree.commands[2].json, false);
  const add = tree.commands[3].commands[0];
  assert.deepEqual(add.path, ["autoinject", "add"]);
  assert.deepEqual(add.usage, ["demo autoinject add <entry>"]);
  assert.deepEqual(tree.commands[4].commands.map((check) => check.name), ["node_version", "plugin_json", "bin_present"]);
  const one = JSON.parse((await run(spec, ["help", "autoinject", "--json"])).out);
  assert.equal(one.name, "autoinject");
  assert.deepEqual((await run(spec, ["autoinject", "help", "--json"])).out, (await run(spec, ["help", "autoinject", "--json"])).out);
});

test("JSON is the default, --pretty renders text, --json is explicit, and both exit 2", async () => {
  const spec = makeSpec();
  const json = await run(spec, ["sync", "--force"]);
  assert.equal(json.code, 0);
  assert.equal(json.err, "");
  assert.deepEqual(JSON.parse(json.out), { synced: 1, flags: { force: true }, args: [], cwd: "/work" });
  assert.equal(json.out.trim().split("\n").length, 1);
  assert.equal((await run(spec, ["--pretty", "sync"])).out, "synced 1\n");
  assert.equal((await run(spec, ["sync", "--force", "--json"])).out, json.out);
  const both = await run(spec, ["sync", "--pretty", "--json"]);
  assert.equal(both.code, 2);
  assert.equal(both.out, "");
  assert.match(both.err, /^demo: `--json` and `--pretty` cannot be combined/);
  assert.equal((await run(spec, ["--json", "--pretty", "help"])).code, 2);
});

test("--json on a text-only command exits 2 before running it", async () => {
  const { code, out, err } = await run(makeSpec(), ["note", "hi", "--json"]);
  assert.equal(code, 2);
  assert.equal(out, "");
  assert.match(err, /^demo: `demo note` is text-only and does not support `--json`\nUsage: demo note <text>\nRun `demo note help` for details\.\n$/);
  assert.equal((await run(makeSpec(), ["note", "hi", "--pretty"])).out, "note: hi\n");
  assert.equal((await run(makeSpec(), ["serve"])).out, "serving\n");
});

test("--prefix replaces the displayed name in help, hints and errors", async () => {
  const spec = makeSpec();
  const help = await run(spec, ["--prefix=de", "help", "sync"]);
  assert.match(help.out, /^de sync\n/);
  assert.match(help.out, /\n {2}de help sync\n/);
  assert.doesNotMatch(help.out, /demo/);
  assert.match((await run(spec, ["help", "--prefix=de"])).out, /^de\n/);
  assert.match((await run(spec, ["sync", "--bogus", "--prefix=de"])).err, /`de sync`.*\nUsage: de sync \[--force\]/);
  assert.equal(JSON.parse((await run(spec, ["--prefix=de", "help", "--json"])).out).name, "de");
  assert.equal((await run(spec, ["--prefix="])).code, 2);
  assert.equal((await run(spec, ["--prefix", "de"])).code, 2);
});

test("an unknown command or flag exits 2 with a did-you-mean", async () => {
  const spec = makeSpec();
  const command = await run(spec, ["snyc"]);
  assert.equal(command.code, 2);
  assert.equal(command.out, "");
  assert.equal(command.err, "demo: unknown command `snyc`; did you mean `sync`?\nUsage: demo <command> [args]\nRun `demo help` for the commands.\n");
  assert.match((await run(spec, ["zzzzzz"])).err, /^demo: unknown command `zzzzzz`\n/);
  assert.match((await run(spec, ["help", "snyc"])).err, /did you mean `sync`/);
  assert.match((await run(spec, ["autoinject", "ad"])).err, /unknown subcommand `ad` of `demo autoinject`; did you mean `add`\?/);
  const flag = await run(spec, ["sync", "--forse"]);
  assert.equal(flag.code, 2);
  assert.match(flag.err, /^demo: unknown flag `--forse` for `demo sync`; did you mean `--force`\?\nUsage: demo sync/);
  assert.match((await run(spec, ["--force"])).err, /^demo: unknown flag `--force` for `demo`/);
  assert.equal((await run(spec, ["autoinject"])).code, 2);
  assert.match((await run(spec, ["autoinject"])).err, /needs a subcommand: add, list/);
});

test("flags: values, short forms, repeats, and refusals", async () => {
  const spec = makeSpec();
  const parsed = async (argv) => JSON.parse((await run(spec, argv)).out).flags;
  assert.deepEqual(await parsed(["sync", "--limit", "5", "-f"]), { limit: "5", force: true });
  assert.deepEqual(await parsed(["sync", "--limit=5"]), { limit: "5" });
  assert.deepEqual(await parsed(["sync", "--tag", "a", "--tag=b"]), { tag: ["a", "b"] });
  assert.match((await run(spec, ["sync", "--limit"])).err, /`--limit` needs a value: --limit <n>/);
  assert.match((await run(spec, ["sync", "--limit", "--force"])).err, /`--limit` needs a value/);
  assert.match((await run(spec, ["sync", "--force=1"])).err, /`--force` takes no value/);
});

test("positional limits", async () => {
  const spec = makeSpec();
  assert.match((await run(spec, ["note"])).err, /^demo: `demo note` needs 1 argument, got 0\n/);
  assert.match((await run(spec, ["note", "a", "b"])).err, /^demo: unexpected argument `b` for `demo note`\n/);
  assert.match((await run(spec, ["sync", "a", "b"])).err, /unexpected argument `b`/);
  assert.match((await run(spec, ["serve", "x"])).err, /unexpected argument `x`/);
});

test("a UsageError from a run function prints the command's usage and a help pointer", async () => {
  const { code, out, err } = await run(makeSpec(), ["sync", "bad"]);
  assert.equal(code, 2);
  assert.equal(out, "");
  assert.equal(err, "demo: name must not be bad\nUsage: demo sync [--force] [--limit <n>] [--tag <t>]\n       demo sync <name>\nRun `demo sync help` for details.\n");
});

test("a CliError with a declared code exits with it, result on stdout and message on stderr", async () => {
  const { code, out, err } = await run(makeSpec(), ["sync", "none"]);
  assert.equal(code, 3);
  assert.deepEqual(JSON.parse(out), { synced: 0 });
  assert.equal(err, "demo: nothing to sync\n");
});

test("an undeclared exit code, a thrown error and an invalid spec exit 1", async () => {
  const undeclared = await run(makeSpec(), ["sync", "undeclared"]);
  assert.equal(undeclared.code, 1);
  assert.match(undeclared.err, /undeclared code 9/);
  const boom = await run(makeSpec(), ["sync", "boom"]);
  assert.equal(boom.code, 1);
  assert.equal(boom.out, "");
  assert.match(boom.err, /kaboom\n\s+at /);
  assert.throws(() => new CliError(2, "x"), RangeError);
  const broken = await run(makeSpec({ commands: [{ name: "x", about: "x" }] }), ["help"]);
  assert.equal(broken.code, 1);
  assert.match(broken.err, /invalid cli spec/);
});

test("spec validation names the mistake", async () => {
  const bad = async (command, pattern) => {
    const { code, err } = await run(makeSpec({ commands: [{ about: "A.", run: () => {}, ...command }] }), ["help"]);
    assert.equal(code, 1);
    assert.match(err, pattern);
  };
  await bad({ name: "doctor" }, /"doctor" is built in/);
  await bad({ name: "Bad" }, /command name "Bad"/);
  await bad({ name: "x", exits: { 2: "usage" } }, /exit code 2/);
  await bad({ name: "x", flags: { "--json": {} }, usage: "[--json]" }, /reserved/);
  await bad({ name: "x", flags: { "--go": {} } }, /needs a usage line/);
  await bad({ name: "x", flags: { "--go": {} }, usage: "[--stop]" }, /usage does not mention --go/);
  await bad({ name: "x", about: "" }, /needs an about line/);
  const dup = await run(makeSpec({ checks: [{ id: "node_version", about: "A.", run: () => ok("x") }] }), ["help"]);
  assert.match(dup.err, /share one id/);
  const defaulted = await run(makeSpec({ defaultCommand: "missing" }), ["help"]);
  assert.match(defaulted.err, /defaultCommand "missing" names no command/);
});

test("version prints the plugin.json version", async () => {
  const spec = makeSpec();
  assert.deepEqual(JSON.parse((await run(spec, ["version", "--json"])).out), { plugin_id: "demo-plugin", version: "1.2.3" });
  assert.equal((await run(spec, ["version"])).code, 0);
  assert.equal((await run(spec, ["version", "--pretty"])).out, "demo 1.2.3\n");
  assert.equal((await run(spec, ["--prefix=de", "version", "--pretty"])).out, "de 1.2.3\n");
  assert.equal((await run(spec, ["help", "version"])).out, (await run(spec, ["version", "help"])).out);
  const missing = await run(makeSpec({ root: pluginRoot(null) }), ["version"]);
  assert.equal(missing.code, 1);
  assert.match(missing.err, /cannot read/);
});

test("doctor reports every check and exits 0 when none fails", async () => {
  const spec = makeSpec({ checks: [{ id: "bin_present", about: "x", run: () => warn("slow", "run `demo fix`") }] });
  const { code, out } = await run(spec, ["doctor"], { nodeVersion: "22.1.0" });
  assert.equal(code, 0);
  const report = JSON.parse(out);
  assert.deepEqual(report, {
    plugin_id: "demo-plugin",
    status: "warn",
    checks: [
      { id: "node_version", status: "ok", message: "Node 22.1.0 (needs 18 or newer)", fix: null },
      { id: "plugin_json", status: "ok", message: "demo-plugin 1.2.3", fix: null },
      { id: "bin_present", status: "warn", message: "slow", fix: "run `demo fix`" },
    ],
  });
  assert.equal((await run(spec, ["doctor", "--json"])).out, (await run(spec, ["--json", "doctor"])).out);
});

test("doctor exits 3 when a check fails and still prints the report", async () => {
  const spec = makeSpec({ checks: [{ id: "bin_present", about: "x", run: () => fail("missing", "run `demo install`") }, { id: "thrower", about: "x", run: () => { throw new Error("oops"); } }] });
  const { code, out } = await run(spec, ["doctor"]);
  assert.equal(code, 3);
  const report = JSON.parse(out);
  assert.equal(report.status, "fail");
  assert.deepEqual(report.checks.slice(2).map((check) => [check.id, check.status, check.fix]), [["bin_present", "fail", "run `demo install`"], ["thrower", "fail", null]]);
  assert.match(report.checks[3].message, /oops/);
});

test("doctor <check-id> runs one check, and an unknown id exits 2", async () => {
  const spec = makeSpec({ checks: [{ id: "bin_present", about: "x", run: () => fail("missing", "install it") }] });
  const one = await run(spec, ["doctor", "bin_present"]);
  assert.equal(one.code, 3);
  assert.deepEqual(JSON.parse(one.out).checks.map((check) => check.id), ["bin_present"]);
  const fine = await run(spec, ["doctor", "plugin_json"]);
  assert.equal(fine.code, 0);
  assert.equal(JSON.parse(fine.out).status, "ok");
  const unknown = await run(spec, ["doctor", "plugin_jsn"]);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /unknown subcommand `plugin_jsn` of `demo doctor`; did you mean `plugin_json`\?/);
});

test("doctor checks the node version and plugin.json", async () => {
  const old = await run(makeSpec(), ["doctor", "node_version"], { nodeVersion: "16.0.0" });
  assert.equal(old.code, 3);
  assert.equal(JSON.parse(old.out).checks[0].fix, "Install Node 18 or newer.");
  assert.equal((await run(makeSpec({ node: 20 }), ["doctor", "node_version"], { nodeVersion: "18.9.0" })).code, 3);
  for (const plugin of [null, "{nope", { name: "x" }]) {
    const { code, out } = await run(makeSpec({ root: pluginRoot(plugin) }), ["doctor"]);
    assert.equal(code, 3);
    const report = JSON.parse(out);
    assert.equal(report.checks.find((check) => check.id === "plugin_json").status, "fail");
    assert.equal(report.plugin_id, plugin && plugin.name ? "x" : "demo");
  }
});

test("doctor --pretty prints one row per check", async () => {
  const spec = makeSpec({ checks: [{ id: "bin_present", about: "x", run: () => fail("missing", "install it") }] });
  const { code, out } = await run(spec, ["doctor", "--pretty"], { nodeVersion: "22.0.0" });
  assert.equal(code, 3);
  assert.equal(out.trimEnd().split("\n").length, 3);
  assert.match(out, /^ok {4}node_version {2}Node 22\.0\.0/);
  assert.match(out, /\nfail {2}bin_present {3}missing {2}\(fix: install it\)\n$/);
});

test("doctor help lists the checks as subcommands and each check has its own help", async () => {
  const spec = makeSpec();
  const help = await run(spec, ["doctor", "help"]);
  assert.equal(help.out, (await run(spec, ["help", "doctor"])).out);
  assert.match(help.out, /\nSubcommands:\n {2}node_version {7}Node\.js is new enough/);
  assert.match(help.out, /\n {2}bin_present /);
  assert.match(help.out, /\n {2}3 {2}A check failed/);
  const check = await run(spec, ["doctor", "bin_present", "help"]);
  assert.equal(check.out, (await run(spec, ["help", "doctor", "bin_present"])).out);
  assert.match(check.out, /^demo doctor bin_present\n\nThe helper binary exists\./);
});

test("the run context carries the injected cwd, streams, environment and root", async () => {
  const seen = [];
  const spec = makeSpec({
    commands: [{ name: "probe", about: "Probe.", run: (ctx) => { seen.push(ctx); } }],
  });
  const environ = { HOME: "/h" };
  const { code } = await run(spec, ["probe", "--pretty"], { cwd: "/elsewhere", environ });
  assert.equal(code, 0);
  assert.equal(seen[0].cwd, "/elsewhere");
  assert.equal(seen[0].env, environ);
  assert.equal(seen[0].root, spec.root);
  assert.deepEqual(seen[0].path, ["probe"]);
  assert.equal(seen[0].pretty, true);
  assert.equal(seen[0].name, "demo");
});

test("a text-only command may not return an object", async () => {
  const spec = makeSpec({ commands: [{ name: "bad", about: "Bad.", run: () => ({ a: 1 }) }] });
  const { code, err } = await run(spec, ["bad"]);
  assert.equal(code, 1);
  assert.match(err, /must return a string or nothing/);
});
