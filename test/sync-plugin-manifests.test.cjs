const assert = require("node:assert/strict");
const { execFileSync, spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const repoRoot = path.resolve(__dirname, "..");
const script = path.join(repoRoot, "scripts", "sync-plugin-manifests.cjs");

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function rewriteWithCrlf(file) {
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\n/g, "\r\n"));
}

function git(root, args) {
  execFileSync("git", args, { cwd: root, stdio: "pipe" });
}

function commandText(error) {
  return [
    error.stdout?.toString(),
    error.stderr?.toString(),
    error.message,
  ].filter(Boolean).join("\n");
}

function assertCommandFails(fn, pattern) {
  let error = null;
  try {
    fn();
  } catch (caught) {
    error = caught;
  }

  assert.ok(error, "expected command to fail");
  assert.match(commandText(error), pattern);
}

function runScript(args, options = {}) {
  return spawnSync("node", [script, ...args], {
    env: options.env,
    encoding: "utf8",
  });
}

function expectScript(args, options = {}) {
  const result = runScript(args, options);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result;
}

function expectScriptFailure(args, options = {}) {
  const result = runScript(args, options);
  assert.notEqual(result.status, 0, result.stderr || result.stdout);
  return result;
}

function commitRepo(root) {
  git(root, ["init"]);
  git(root, ["config", "user.name", "Test User"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
}

function makeRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qol-skills-manifests-"));

  fs.mkdirSync(path.join(root, "plugins", "alpha", "skills", "alpha"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "plugins", "alpha", "skills", "alpha", "SKILL.md"),
    "---\ndescription: Alpha skill.\n---\n",
  );
  writeJson(path.join(root, "plugins", "alpha", ".claude-plugin", "plugin.json"), {
    name: "alpha",
    description: "Alpha plugin.",
    version: "0.2.0",
    author: { name: "KMRH47" },
  });

  fs.mkdirSync(path.join(root, "plugins", "beta", "skills", "beta"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "plugins", "beta", "skills", "beta", "SKILL.md"),
    "---\ndescription: Beta skill.\n---\n",
  );
  writeJson(path.join(root, "plugins", "beta", ".codex-plugin", "plugin.json"), {
    name: "beta",
    version: "0.3.0",
    description: "Beta plugin.",
    author: { name: "KMRH47" },
    skills: "./skills/",
    interface: {
      displayName: "Beta",
    },
  });

  fs.mkdirSync(path.join(root, "plugins", "gamma", "skills", "gamma"), { recursive: true });
  fs.writeFileSync(
    path.join(root, "plugins", "gamma", "skills", "gamma", "SKILL.md"),
    "---\ndescription: Gamma skill.\n---\n",
  );
  writeJson(path.join(root, "plugins", "gamma", ".claude-plugin", "plugin.json"), {
    name: "gamma",
    description: "Gamma plugin.",
    version: "0.4.0",
    author: { name: "KMRH47" },
  });
  writeJson(path.join(root, "plugins", "gamma", ".codex-plugin", "plugin.json"), {
    name: "gamma",
    version: "0.1.0",
    description: "Stale gamma plugin.",
    author: { name: "KMRH47" },
    skills: "./skills/",
    interface: {
      displayName: "Gamma",
    },
  });

  writeJson(path.join(root, ".claude-plugin", "marketplace.json"), {
    name: "qol-skills",
    owner: { name: "KMRH47" },
    plugins: [
      {
        name: "alpha",
        source: "./plugins/alpha",
      },
      {
        name: "stale",
        source: "./plugins/stale",
      },
    ],
  });

  writeJson(path.join(root, ".agents", "plugins", "marketplace.json"), {
    name: "qol-skills",
    interface: {
      displayName: "qol-skills",
    },
    plugins: [
      {
        name: "stale",
        source: {
          source: "local",
          path: "./plugins/stale",
        },
        policy: {
          installation: "INSTALLED_BY_DEFAULT",
          authentication: "ON_INSTALL",
        },
        category: "Productivity",
      },
    ],
  });

  return root;
}

test("generates missing manifests and removes stale marketplace entries", () => {
  const root = makeRepo();

  assert.throws(
    () => execFileSync("node", [script, "--root", root, "--check"], { stdio: "pipe" }),
    /Command failed/,
  );

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });

  const alphaCodex = readJson(path.join(root, "plugins", "alpha", ".codex-plugin", "plugin.json"));
  const betaClaude = readJson(path.join(root, "plugins", "beta", ".claude-plugin", "plugin.json"));
  const gammaCodex = readJson(path.join(root, "plugins", "gamma", ".codex-plugin", "plugin.json"));
  const claudeMarketplace = readJson(path.join(root, ".claude-plugin", "marketplace.json"));
  const codexMarketplace = readJson(path.join(root, ".agents", "plugins", "marketplace.json"));

  assert.equal(alphaCodex.name, "alpha");
  assert.equal(alphaCodex.version, "0.2.0");
  assert.equal(alphaCodex.skills, "./skills/");
  assert.equal(betaClaude.name, "beta");
  assert.equal(betaClaude.displayName, "Beta");
  assert.equal(gammaCodex.version, "0.4.0");
  assert.equal(gammaCodex.description, "Gamma plugin.");
  assert.equal(gammaCodex.interface.displayName, "Gamma");
  assert.deepEqual(claudeMarketplace.plugins.map((entry) => entry.name), ["alpha", "beta", "gamma"]);
  assert.deepEqual(codexMarketplace.plugins.map((entry) => entry.name), ["alpha", "beta", "gamma"]);
  assert.deepEqual(
    codexMarketplace.plugins.map((entry) => entry.source.path),
    ["./plugins/alpha", "./plugins/beta", "./plugins/gamma"],
  );

  execFileSync("node", [script, "--root", root, "--check"], { stdio: "pipe" });
});

test("unescapes a quoted skill description when generating missing manifests", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qol-skills-manifests-"));
  const skillDir = path.join(root, "plugins", "delta", "skills", "delta");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    '---\ndescription: "Triggers on \\"locate bugs\\", \\"find bugs\\"."\n---\n',
  );
  commitRepo(root);

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });

  const claude = readJson(path.join(root, "plugins", "delta", ".claude-plugin", "plugin.json"));
  const codex = readJson(path.join(root, "plugins", "delta", ".codex-plugin", "plugin.json"));
  const kimi = readJson(path.join(root, "plugins", "delta", ".kimi-plugin", "plugin.json"));
  const expected = 'Triggers on "locate bugs", "find bugs".';
  assert.equal(claude.description, expected);
  assert.equal(codex.description, expected);
  assert.equal(kimi.description, expected);
  assert.doesNotMatch(JSON.stringify(claude), /\\\\/);
});

test("folds a block-scalar skill description when generating missing manifests", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qol-skills-manifests-"));
  const skillDir = path.join(root, "plugins", "epsilon", "skills", "epsilon");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\ndescription: >\n  Triggers on \"a\", \"b\".\n  Second line with a blank after.\n\n  New paragraph.\n---\n",
  );
  const zetaDir = path.join(root, "plugins", "zeta", "skills", "zeta");
  fs.mkdirSync(zetaDir, { recursive: true });
  fs.writeFileSync(
    path.join(zetaDir, "SKILL.md"),
    "---\ndescription: |\n  Line one.\n  Line two.\n---\n",
  );
  commitRepo(root);

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });

  const epsilon = readJson(path.join(root, "plugins", "epsilon", ".claude-plugin", "plugin.json"));
  const zeta = readJson(path.join(root, "plugins", "zeta", ".claude-plugin", "plugin.json"));
  assert.equal(
    epsilon.description,
    'Triggers on "a", "b". Second line with a blank after.\n\nNew paragraph.',
  );
  assert.equal(zeta.description, "Line one.\nLine two.");
});

test("keeps a trailing quote on an unquoted skill description scalar", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "qol-skills-manifests-"));
  const skillDir = path.join(root, "plugins", "eta", "skills", "eta");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(path.join(skillDir, "SKILL.md"), "---\ndescription: Ask for \"help\"\n---\n");
  commitRepo(root);

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });

  const claude = readJson(path.join(root, "plugins", "eta", ".claude-plugin", "plugin.json"));
  assert.equal(claude.description, 'Ask for "help"');
});

test("rejects manifest names that do not match plugin folders", () => {
  const root = makeRepo();

  writeJson(path.join(root, "plugins", "alpha", ".claude-plugin", "plugin.json"), {
    name: "wrong-name",
    description: "Alpha plugin.",
    version: "0.2.0",
    author: { name: "KMRH47" },
  });

  assert.throws(
    () => execFileSync("node", [script, "--root", root], { stdio: "pipe" }),
    /Command failed/,
  );
});

test("syncs existing Claude manifest from Codex-side shared metadata edits", () => {
  const root = makeRepo();

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });
  commitRepo(root);

  const codexFile = path.join(root, "plugins", "beta", ".codex-plugin", "plugin.json");
  const codex = readJson(codexFile);
  codex.version = "0.5.0";
  codex.description = "Beta plugin from Codex.";
  writeJson(codexFile, codex);

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });

  const claude = readJson(path.join(root, "plugins", "beta", ".claude-plugin", "plugin.json"));
  const syncedCodex = readJson(codexFile);

  assert.equal(claude.version, "0.5.0");
  assert.equal(claude.description, "Beta plugin from Codex.");
  assert.equal(claude.displayName, "Beta");
  assert.equal(syncedCodex.interface.displayName, "Beta");
  execFileSync("node", [script, "--root", root, "--check"], { stdio: "pipe" });
});

test("rejects conflicting shared metadata edits on both manifest sides", () => {
  const root = makeRepo();

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });
  commitRepo(root);

  const claudeFile = path.join(root, "plugins", "beta", ".claude-plugin", "plugin.json");
  const codexFile = path.join(root, "plugins", "beta", ".codex-plugin", "plugin.json");
  const claude = readJson(claudeFile);
  const codex = readJson(codexFile);
  claude.version = "0.5.0";
  codex.version = "0.6.0";
  writeJson(claudeFile, claude);
  writeJson(codexFile, codex);

  assert.throws(
    () => execFileSync("node", [script, "--root", root], { stdio: "pipe" }),
    /Command failed/,
  );
});

test("rejects unresolved explicit base refs", () => {
  const root = makeRepo();

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });
  commitRepo(root);

  const codexFile = path.join(root, "plugins", "beta", ".codex-plugin", "plugin.json");
  const codex = readJson(codexFile);
  codex.version = "0.5.0";
  writeJson(codexFile, codex);

  assertCommandFails(
    () => execFileSync("node", [script, "--root", root, "--base-ref", "deadbeef"], { stdio: "pipe" }),
    /Could not resolve manifest sync base ref "deadbeef"/,
  );
});

test("ignores unresolved environment base refs when shared metadata matches", () => {
  const root = makeRepo();

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });
  commitRepo(root);

  const result = expectScript(["--root", root, "--check"], {
    env: {
      ...process.env,
      PLUGIN_SYNC_BASE_REF: "deadbeef",
    },
  });

  assert.match(
    result.stderr,
    /Could not resolve manifest sync base ref "deadbeef"; changed-file provenance is unavailable/,
  );
});

test("rejects unresolved environment base refs when shared metadata differs", () => {
  const root = makeRepo();

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });
  commitRepo(root);

  const codexFile = path.join(root, "plugins", "beta", ".codex-plugin", "plugin.json");
  const codex = readJson(codexFile);
  codex.version = "0.5.0";
  writeJson(codexFile, codex);

  const result = expectScriptFailure(["--root", root], {
    env: {
      ...process.env,
      PLUGIN_SYNC_BASE_REF: "deadbeef",
    },
  });

  assert.match(
    result.stderr,
    /Cannot resolve shared manifest metadata edits in plugins\/beta/,
  );
});

test("treats all-zero environment base refs as unknown provenance", () => {
  const root = makeRepo();

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });
  commitRepo(root);

  const result = expectScript(["--root", root, "--check"], {
    env: {
      ...process.env,
      PLUGIN_SYNC_BASE_REF: "0000000000000000000000000000000000000000",
    },
  });

  assert.match(
    result.stderr,
    /Could not resolve manifest sync base ref "0000000000000000000000000000000000000000"; changed-file provenance is unavailable: all-zero ref/,
  );
});

test("rejects all-zero environment base refs when shared metadata differs", () => {
  const root = makeRepo();

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });
  commitRepo(root);

  const codexFile = path.join(root, "plugins", "beta", ".codex-plugin", "plugin.json");
  const codex = readJson(codexFile);
  codex.version = "0.5.0";
  writeJson(codexFile, codex);

  const result = expectScriptFailure(["--root", root], {
    env: {
      ...process.env,
      PLUGIN_SYNC_BASE_REF: "0000000000000000000000000000000000000000",
    },
  });

  assert.match(result.stderr, /changed-file provenance is unavailable: all-zero ref/);
  assert.match(
    result.stderr,
    /Cannot resolve shared manifest metadata edits in plugins\/beta/,
  );
});

test("rejects unsafe base refs before git diff", () => {
  const root = makeRepo();

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });
  commitRepo(root);

  assertCommandFails(
    () => execFileSync("node", [script, "--root", root, "--base-ref", "--relative=scripts"], { stdio: "pipe" }),
    /Invalid manifest sync base ref "--relative=scripts"/,
  );

  const result = expectScriptFailure(["--root", root, "--check"], {
    env: {
      ...process.env,
      PLUGIN_SYNC_BASE_REF: "--relative=scripts",
    },
  });

  assert.match(result.stderr, /Invalid manifest sync base ref "--relative=scripts"/);
});

test("escapes unsafe base refs in diagnostics", () => {
  const root = makeRepo();

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });
  commitRepo(root);

  const result = expectScriptFailure(["--root", root, "--check"], {
    env: {
      ...process.env,
      PLUGIN_SYNC_BASE_REF: "bad\n::error::spoofed",
    },
  });

  assert.match(result.stderr, /Invalid manifest sync base ref "bad\\n::error::spoofed"/);
  assert.doesNotMatch(result.stderr, /\n::error::spoofed/);
});

test("accepts CRLF-normalized marketplace files from Windows checkouts", () => {
  const root = makeRepo();

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });
  rewriteWithCrlf(path.join(root, ".claude-plugin", "marketplace.json"));
  rewriteWithCrlf(path.join(root, ".agents", "plugins", "marketplace.json"));

  execFileSync("node", [script, "--root", root, "--check"], { stdio: "pipe" });
});

test("generates kimi manifests from resolved base metadata", () => {
  const root = makeRepo();

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });

  const alphaKimi = readJson(path.join(root, "plugins", "alpha", ".kimi-plugin", "plugin.json"));
  const betaKimi = readJson(path.join(root, "plugins", "beta", ".kimi-plugin", "plugin.json"));
  const gammaKimi = readJson(path.join(root, "plugins", "gamma", ".kimi-plugin", "plugin.json"));

  assert.equal(alphaKimi.name, "alpha");
  assert.equal(alphaKimi.version, "0.2.0");
  assert.equal(alphaKimi.description, "Alpha plugin.");
  assert.deepEqual(alphaKimi.author, { name: "KMRH47" });
  assert.deepEqual(alphaKimi.skills, ["./skills/"]);
  assert.equal(alphaKimi.interface, undefined);

  assert.equal(betaKimi.name, "beta");
  assert.equal(betaKimi.version, "0.3.0");
  assert.equal(betaKimi.description, "Beta plugin.");
  assert.deepEqual(betaKimi.interface, { displayName: "Beta" });

  assert.equal(gammaKimi.version, "0.4.0");
  assert.equal(gammaKimi.description, "Gamma plugin.");
  assert.deepEqual(gammaKimi.interface, { displayName: "Gamma" });

  execFileSync("node", [script, "--root", root, "--check"], { stdio: "pipe" });
});

test("preserves kimi-only extras and a hand-written interface across re-sync", () => {
  const root = makeRepo();

  writeJson(path.join(root, "plugins", "alpha", ".kimi-plugin", "plugin.json"), {
    name: "alpha",
    version: "0.0.1",
    description: "Stale alpha.",
    author: { name: "KMRH47" },
    keywords: ["alpha", "test"],
    homepage: "https://example.com/alpha",
    sessionStart: { skill: "alpha-start" },
    skillInstructions: "Extra alpha instructions.",
    commands: "./commands/",
    interface: {
      displayName: "Alpha Custom",
      websiteURL: "https://example.com/alpha",
    },
  });

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });

  const kimi = readJson(path.join(root, "plugins", "alpha", ".kimi-plugin", "plugin.json"));

  assert.equal(kimi.version, "0.2.0");
  assert.equal(kimi.description, "Alpha plugin.");
  assert.deepEqual(kimi.author, { name: "KMRH47" });
  assert.deepEqual(kimi.skills, ["./skills/"]);
  assert.deepEqual(kimi.keywords, ["alpha", "test"]);
  assert.equal(kimi.homepage, "https://example.com/alpha");
  assert.deepEqual(kimi.sessionStart, { skill: "alpha-start" });
  assert.equal(kimi.skillInstructions, "Extra alpha instructions.");
  assert.equal(kimi.commands, "./commands/");
  assert.deepEqual(kimi.interface, {
    displayName: "Alpha Custom",
    websiteURL: "https://example.com/alpha",
  });

  execFileSync("node", [script, "--root", root, "--check"], { stdio: "pipe" });
});

test("rejects kimi manifest names that do not match plugin folders", () => {
  const root = makeRepo();

  writeJson(path.join(root, "plugins", "alpha", ".kimi-plugin", "plugin.json"), {
    name: "wrong-name",
    version: "0.2.0",
    description: "Alpha plugin.",
    author: { name: "KMRH47" },
  });

  const result = expectScriptFailure(["--root", root]);

  assert.match(result.stderr, /Kimi manifest name mismatch in plugins\/alpha: wrong-name/);
});

function writeAlphaHooks(root, document) {
  fs.mkdirSync(path.join(root, "plugins", "alpha", "hooks"), { recursive: true });
  writeJson(path.join(root, "plugins", "alpha", "hooks", "hooks.json"), document);
}

test("translates claude-format hooks into inline kimi hook rules", () => {
  const root = makeRepo();

  writeAlphaHooks(root, {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: "node -e 'const fs=require(\"node:fs\");' alpha bin/one.cjs" },
            { type: "command", command: "node -e 'const fs=require(\"node:fs\");' alpha bin/two.cjs" },
          ],
        },
      ],
      UserPromptSubmit: [
        {
          hooks: [
            { type: "command", command: "node -e 'const fs=require(\"node:fs\");' alpha bin/three.cjs" },
          ],
        },
      ],
    },
  });

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });

  const kimi = readJson(path.join(root, "plugins", "alpha", ".kimi-plugin", "plugin.json"));

  assert.deepEqual(kimi.hooks, [
    { event: "PreToolUse", matcher: "Bash", command: "node bin/one.cjs" },
    { event: "PreToolUse", matcher: "Bash", command: "node bin/two.cjs" },
    { event: "UserPromptSubmit", command: "node bin/three.cjs" },
  ]);

  execFileSync("node", [script, "--root", root, "--check"], { stdio: "pipe" });
});

test("passes non-wrapper hook commands through verbatim", () => {
  const root = makeRepo();

  writeAlphaHooks(root, {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [
            { type: "command", command: "node -e 'const fs=require(\"node:fs\");' other bin/one.cjs" },
            { type: "command", command: "python3 scripts/check.py --flag" },
          ],
        },
      ],
    },
  });

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });

  const kimi = readJson(path.join(root, "plugins", "alpha", ".kimi-plugin", "plugin.json"));

  assert.deepEqual(kimi.hooks, [
    { event: "PreToolUse", matcher: "Bash", command: "node -e 'const fs=require(\"node:fs\");' other bin/one.cjs" },
    { event: "PreToolUse", matcher: "Bash", command: "python3 scripts/check.py --flag" },
  ]);
});

test("preserves hand-written kimi hooks when no hooks.json exists", () => {
  const root = makeRepo();

  writeJson(path.join(root, "plugins", "alpha", ".kimi-plugin", "plugin.json"), {
    name: "alpha",
    version: "0.2.0",
    description: "Alpha plugin.",
    author: { name: "KMRH47" },
    hooks: [{ event: "SessionStart", command: "node bootstrap.cjs" }],
  });

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });

  const kimi = readJson(path.join(root, "plugins", "alpha", ".kimi-plugin", "plugin.json"));

  assert.deepEqual(kimi.hooks, [{ event: "SessionStart", command: "node bootstrap.cjs" }]);
});

test("fails loudly on malformed hooks.json", () => {
  const root = makeRepo();

  fs.mkdirSync(path.join(root, "plugins", "alpha", "hooks"), { recursive: true });
  fs.writeFileSync(path.join(root, "plugins", "alpha", "hooks", "hooks.json"), "{ not json");

  const result = expectScriptFailure(["--root", root]);

  assert.match(result.stderr, /Cannot parse hooks\/hooks\.json in plugins\/alpha/);
});

test("generates the kimi marketplace catalog", () => {
  const root = makeRepo();

  writeJson(path.join(root, ".kimi-plugin", "marketplace.json"), {
    version: "2",
    plugins: [
      {
        id: "stale",
        source: "../plugins/stale",
      },
      {
        id: "beta",
        source: "../plugins/beta",
        displayName: "Beta Custom",
        trust: "curated",
      },
    ],
  });

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });

  const marketplace = readJson(path.join(root, ".kimi-plugin", "marketplace.json"));

  assert.equal(marketplace.version, "2");
  assert.deepEqual(
    marketplace.plugins.map((entry) => entry.id),
    ["alpha", "beta", "gamma"],
  );
  assert.deepEqual(
    marketplace.plugins.map((entry) => entry.source),
    ["../plugins/alpha", "../plugins/beta", "../plugins/gamma"],
  );
  assert.equal(marketplace.plugins[0].displayName, undefined);
  assert.equal(marketplace.plugins[1].displayName, "Beta Custom");
  assert.equal(marketplace.plugins[1].trust, "curated");
  assert.equal(marketplace.plugins[2].displayName, "Gamma");

  execFileSync("node", [script, "--root", root, "--check"], { stdio: "pipe" });
});

test("--check lists drifted kimi files", () => {
  const root = makeRepo();

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });
  commitRepo(root);

  const kimiFile = path.join(root, "plugins", "beta", ".kimi-plugin", "plugin.json");
  const kimi = readJson(kimiFile);
  kimi.version = "9.9.9";
  writeJson(kimiFile, kimi);

  const result = expectScriptFailure(["--root", root, "--check"]);

  assert.match(result.stderr, /out of sync/);
  assert.match(result.stderr, /plugins\/beta\/\.kimi-plugin\/plugin\.json/);
});

test("root kimi manifest aggregates every plugin skills dir", () => {
  const root = makeRepo();

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });

  const rootManifest = readJson(path.join(root, "kimi.plugin.json"));

  assert.deepEqual(rootManifest.skills, [
    "./plugins/alpha/skills/",
    "./plugins/beta/skills/",
    "./plugins/gamma/skills/",
  ]);

  execFileSync("node", [script, "--root", root, "--check"], { stdio: "pipe" });
});

test("root kimi manifest prefixes hook commands with the owning plugin dir", () => {
  const root = makeRepo();

  writeAlphaHooks(root, {
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash",
          hooks: [{ type: "command", command: "node -e 'const fs=require(\"node:fs\");' alpha bin/one.cjs" }],
        },
      ],
    },
  });

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });

  const rootManifest = readJson(path.join(root, "kimi.plugin.json"));

  assert.deepEqual(rootManifest.hooks, [
    { event: "PreToolUse", matcher: "Bash", command: "node plugins/alpha/bin/one.cjs" },
  ]);
});

test("root kimi manifest drops skills and hooks that no longer exist", () => {
  const root = makeRepo();

  writeJson(path.join(root, "kimi.plugin.json"), {
    name: "qol-skills",
    version: "1.0.0",
    skills: ["./plugins/deleted/skills/"],
    hooks: [{ event: "PreToolUse", command: "node plugins/deleted/bin/gone.cjs" }],
  });

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });

  const rootManifest = readJson(path.join(root, "kimi.plugin.json"));

  assert.equal(rootManifest.skills.includes("./plugins/deleted/skills/"), false);
  assert.equal(rootManifest.hooks, undefined, "no fixture plugin ships hooks");
});

function generatedPiExtension(root, matcher) {
  writeAlphaHooks(root, {
    hooks: {
      PreToolUse: [
        {
          matcher,
          hooks: [
            { type: "command", command: "node -e 'const fs=require(\"node:fs\");' alpha bin/one.cjs" },
          ],
        },
      ],
    },
  });

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });

  return fs.readFileSync(
    path.join(root, "plugins", "alpha", ".pi", "extensions", "hooks.ts"),
    "utf8",
  );
}

function evalMatchedToolName(source) {
  const fn = source.match(/function matchedToolName\([^]*?\n}\n/);
  assert.ok(fn, "generated extension defines matchedToolName");
  return new Function(`${fn[0]}\nreturn matchedToolName;`)();
}

test("pi extension matches every tool name in an alternation matcher", () => {
  const source = generatedPiExtension(makeRepo(), "Edit|Write|MultiEdit");
  const matchedToolName = evalMatchedToolName(source);

  assert.equal(matchedToolName("Edit|Write|MultiEdit", "edit"), "Edit");
  assert.equal(matchedToolName("Edit|Write|MultiEdit", "write"), "Write");
  assert.equal(matchedToolName("Edit|Write|MultiEdit", "MultiEdit"), "MultiEdit");
  assert.equal(matchedToolName("Edit|Write|MultiEdit", "bash"), undefined);
  assert.equal(matchedToolName("Bash", "bash"), "Bash");
});

test("pi extension forwards the real tool name and input", () => {
  const source = generatedPiExtension(makeRepo(), "Edit|Write|MultiEdit");

  assert.match(source, /tool_name: matchedToolName\(hook\.matcher, event\.toolName\)/);
  assert.match(source, /tool_input: event\.input \?\? \{\}/);
  assert.doesNotMatch(source, /tool_name: "Bash"/);
});

test("pi extension blocks on a JSON permission denial", () => {
  const source = generatedPiExtension(makeRepo(), "Edit");

  assert.match(source, /permissionDecision === "deny"/);
  assert.match(source, /reason: decision\.permissionDecisionReason/);
});
