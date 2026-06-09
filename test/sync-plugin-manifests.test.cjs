const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
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

  assert.throws(
    () => execFileSync("node", [script, "--root", root, "--base-ref", "deadbeef"], { stdio: "pipe" }),
    /Command failed/,
  );
});

test("accepts CRLF-normalized marketplace files from Windows checkouts", () => {
  const root = makeRepo();

  execFileSync("node", [script, "--root", root], { stdio: "pipe" });
  rewriteWithCrlf(path.join(root, ".claude-plugin", "marketplace.json"));
  rewriteWithCrlf(path.join(root, ".agents", "plugins", "marketplace.json"));

  execFileSync("node", [script, "--root", root, "--check"], { stdio: "pipe" });
});
