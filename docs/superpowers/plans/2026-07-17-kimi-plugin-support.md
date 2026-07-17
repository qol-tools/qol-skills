# Kimi Code Plugin Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the qol-skills manifest sync harness so every plugin also gets a Kimi Code manifest (`.kimi-plugin/plugin.json`) plus a Kimi marketplace catalog (`.kimi-plugin/marketplace.json`), including translation of Claude-format hooks into Kimi's inline hook rules.

**Architecture:** Kimi is a derived third target in `scripts/sync-plugin-manifests.cjs`, following the existing Codex pattern: base metadata (`name`/`description`/`version`/`author`) keeps resolving two-way between the Claude and Codex manifests, and the Kimi manifest is regenerated from that base while preserving Kimi-only extras found in an existing Kimi manifest. Hook rules are translated from each plugin's `hooks/hooks.json` (Claude format) into Kimi's inline `hooks` array.

**Tech Stack:** Node 20, plain CommonJS (`node:*` requires, no dependencies), `node:test` for tests, GitHub Actions for CI.

**Repo root (all paths below are relative to it):** `/media/kmrh47/WD_SN850X/Git/qol-skills`

**Spec:** `docs/superpowers/specs/2026-07-17-kimi-plugin-support-design.md`

## Global Constraints

- Commit messages follow the repo convention `type(scope): summary` (see `git log`), and commits must contain **no AI attribution lines** (qol-workflow hard rule).
- Implementation should happen in a git worktree of qol-skills per superpowers:using-git-worktrees (the qol-workflow plugin enforces a worktrees-only rule in qol-* clones). Creating the worktree mutates git state — confirm with the user first.
- All generated JSON must go through the existing `writeJson`/`jsonText` helpers (2-space indent, non-ASCII escaped as `\uXXXX`, trailing newline, CRLF-normalized comparison). Never call `fs.writeFileSync` for manifest output.
- The Kimi manifest is **derived-only**: it is never read into `sharedBase`/base resolution, and only the documented Kimi extras are preserved from an existing file.
- Kimi `interface` is limited to the documented subfields: `displayName`, `shortDescription`, `longDescription`, `developerName`, `websiteURL`.
- No new npm dependencies. Tests live in `test/sync-plugin-manifests.test.cjs` and run with `node --test test/sync-plugin-manifests.test.cjs`.
- Do not change any hook's behavior or the bin scripts. The env audit already confirmed the bin scripts work under Kimi unchanged: `plugins/qol-workflow/bin/commit-skill-context.cjs:46-49` and `plugins/qol-workflow/bin/qol-cicd-context.cjs:50-53` fall back to `path.resolve(__dirname, '..')` (correct when run as `node bin/x.cjs` from the plugin root), and `plugins/qol-tray/bin/stop-deny-uncited-arch-claims.cjs:169` reads `payload.cwd`, which Kimi's hook payload provides.
- Reference formats (verified against official docs): plugin manifest fields and the `"version": "2"` marketplace catalog — <https://www.kimi.com/code/docs/en/kimi-code-cli/customization/plugins.html>; hook rule fields `{event, matcher, command, timeout}`, cwd = plugin root, `$KIMI_PLUGIN_ROOT` — <https://www.kimi.com/code/docs/en/kimi-code-cli/customization/hooks.html>.

---

### Task 1: Generate per-plugin Kimi manifests in the sync script

**Files:**
- Modify: `scripts/sync-plugin-manifests.cjs` (constants near line 6; `manifestPaths` at 359-366; new functions after `claudeManifest` at 332-345; `syncPlugin` at 368-406)
- Test: `test/sync-plugin-manifests.test.cjs` (append new tests at end of file)

**Interfaces:**
- Consumes: existing `maybeReadJson`, `writeJson`, `sameJson`, `hasDir`, `validateManifestName`, `syncSharedFields` helpers; `base` object from `sharedBase(...)` with `{name, description, version, author}`.
- Produces:
  - `manifestPaths(root, pluginName)` → `{ claude, codex, kimi }` (absolute paths)
  - `kimiManifest(root, pluginName, base, codex, existing)` → manifest object **without** hooks (Task 2 attaches those)
  - `syncPlugin(...)` return value gains a `kimi` property: `{ pluginName, claude, codex, kimi }`
  - Constants `KIMI_METADATA_FIELDS`, `KIMI_BEHAVIOR_FIELDS`, `KIMI_INTERFACE_FIELDS` (Task 2 does not touch these)

- [ ] **Step 1: Write the failing tests**

Append to `test/sync-plugin-manifests.test.cjs`:

```js
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
  assert.equal(alphaKimi.skills, "./skills/");
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
  assert.equal(kimi.skills, "./skills/");
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/sync-plugin-manifests.test.cjs`
Expected: FAIL — the three new tests fail (first two with `ENOENT` reading `.kimi-plugin/plugin.json`, the third because the script exits 0 instead of failing). All pre-existing tests must still pass.

- [ ] **Step 3: Implement the kimi manifest generation**

In `scripts/sync-plugin-manifests.cjs`, add constants after `SHARED_FIELDS` (line 6):

```js
const KIMI_METADATA_FIELDS = ["keywords", "homepage", "license"];
const KIMI_BEHAVIOR_FIELDS = ["sessionStart", "skillInstructions", "commands", "mcpServers"];
const KIMI_INTERFACE_FIELDS = ["displayName", "shortDescription", "longDescription", "developerName", "websiteURL"];
```

Add the `kimi` path in `manifestPaths` (currently lines 359-366):

```js
function manifestPaths(root, pluginName) {
  const pluginRoot = path.join(root, "plugins", pluginName);

  return {
    claude: path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    codex: path.join(pluginRoot, ".codex-plugin", "plugin.json"),
    kimi: path.join(pluginRoot, ".kimi-plugin", "plugin.json"),
  };
}
```

Add new functions after `claudeManifest` (currently lines 332-345):

```js
function kimiInterface(existing, codex) {
  if (existing?.interface) {
    return existing.interface;
  }

  if (!codex?.interface) {
    return undefined;
  }

  const picked = {};

  for (const field of KIMI_INTERFACE_FIELDS) {
    if (codex.interface[field] !== undefined) {
      picked[field] = codex.interface[field];
    }
  }

  return Object.keys(picked).length > 0 ? picked : undefined;
}

function kimiManifest(root, pluginName, base, codex, existing) {
  const source = existing ?? {};
  const manifest = {
    name: base.name,
    version: base.version,
    description: base.description,
    author: base.author,
  };

  for (const field of KIMI_METADATA_FIELDS) {
    if (source[field] !== undefined) {
      manifest[field] = source[field];
    }
  }

  if (hasDir(root, pluginName, "skills")) {
    manifest.skills = "./skills/";
  }

  const interfaceValue = kimiInterface(source, codex);

  if (interfaceValue) {
    manifest.interface = interfaceValue;
  }

  for (const field of KIMI_BEHAVIOR_FIELDS) {
    if (source[field] !== undefined) {
      manifest[field] = source[field];
    }
  }

  return manifest;
}
```

Replace `syncPlugin` (currently lines 368-406) with:

```js
function syncPlugin(root, pluginName, options, changes, failures, changedFiles) {
  const files = manifestPaths(root, pluginName);
  let claude = maybeReadJson(files.claude);
  let codex = maybeReadJson(files.codex);
  const kimi = maybeReadJson(files.kimi);

  validateManifestName("Claude", root, pluginName, claude, failures);
  validateManifestName("Codex", root, pluginName, codex, failures);
  validateManifestName("Kimi", root, pluginName, kimi, failures);

  if (failures.length > 0) {
    return { pluginName, claude, codex, kimi };
  }

  const base = sharedBase(root, pluginName, claude, codex, files, changedFiles, failures);

  if (failures.length > 0) {
    return { pluginName, claude, codex, kimi };
  }

  if (!claude) {
    claude = claudeManifest(base, codex);
    writeJson(root, files.claude, claude, options, changes);
  }

  const nextClaude = syncSharedFields(claude, base);

  if (!sameJson(claude, nextClaude)) {
    claude = nextClaude;
    writeJson(root, files.claude, claude, options, changes);
  }

  const nextCodex = codexManifest(root, pluginName, base, codex ?? {});

  if (!sameJson(codex, nextCodex)) {
    codex = nextCodex;
    writeJson(root, files.codex, codex, options, changes);
  }

  const nextKimi = kimiManifest(root, pluginName, base, codex, kimi);

  if (!sameJson(kimi, nextKimi)) {
    writeJson(root, files.kimi, nextKimi, options, changes);
  }

  return { pluginName, claude, codex, kimi: nextKimi };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/sync-plugin-manifests.test.cjs`
Expected: PASS — all tests, old and new.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-plugin-manifests.cjs test/sync-plugin-manifests.test.cjs
git commit -m "feat(skills): derive kimi plugin manifests in sync"
```

---

### Task 2: Translate hooks.json into Kimi inline hook rules

**Files:**
- Modify: `scripts/sync-plugin-manifests.cjs` (new functions after `kimiManifest`; `syncPlugin` body)
- Test: `test/sync-plugin-manifests.test.cjs` (append)

**Interfaces:**
- Consumes: `syncPlugin` and `kimiManifest` from Task 1; existing `failures` array convention (push a message string, caller bails).
- Produces:
  - `kimiHooks(root, pluginName, failures)` → array of `{ event, matcher?, command }` in file order, or `undefined` when no `hooks/hooks.json` exists
  - `kimiHookCommand(command, pluginName)` → `node <relpath>` for the known wrapper shape, else the command verbatim
  - Rule: `hooks/hooks.json` is the source of truth when present; a hand-written `hooks` array in an existing kimi manifest is preserved only when no `hooks/hooks.json` exists.

- [ ] **Step 1: Write the failing tests**

Append to `test/sync-plugin-manifests.test.cjs`:

```js
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/sync-plugin-manifests.test.cjs`
Expected: FAIL — first test fails because `kimi.hooks` is `undefined`; the malformed-hooks test fails because the script exits 0.

- [ ] **Step 3: Implement hook translation**

In `scripts/sync-plugin-manifests.cjs`, add after `kimiManifest`:

```js
function kimiHookCommand(command, pluginName) {
  const match = command.match(/^node -e '[^']*' (\S+) (\S+)$/);

  if (match && match[1] === pluginName) {
    return `node ${match[2]}`;
  }

  return command;
}

function kimiHooks(root, pluginName, failures) {
  const file = path.join(root, "plugins", pluginName, "hooks", "hooks.json");

  if (!fs.existsSync(file)) {
    return undefined;
  }

  let document;

  try {
    document = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    failures.push(`Cannot parse hooks/hooks.json in plugins/${pluginName}: ${error.message}`);
    return undefined;
  }

  if (!document || typeof document !== "object" || Array.isArray(document) || !document.hooks || typeof document.hooks !== "object" || Array.isArray(document.hooks)) {
    failures.push(`Unexpected hooks/hooks.json shape in plugins/${pluginName}: expected an object with a "hooks" object`);
    return undefined;
  }

  const rules = [];

  for (const [event, entries] of Object.entries(document.hooks)) {
    if (!Array.isArray(entries)) {
      failures.push(`Unexpected hooks/hooks.json shape in plugins/${pluginName}: "${event}" is not an array`);
      return undefined;
    }

    for (const entry of entries) {
      for (const hook of entry?.hooks ?? []) {
        if (hook?.type !== "command" || typeof hook.command !== "string") {
          continue;
        }

        const rule = { event };

        if (entry?.matcher) {
          rule.matcher = entry.matcher;
        }

        rule.command = kimiHookCommand(hook.command, pluginName);
        rules.push(rule);
      }
    }
  }

  return rules.length > 0 ? rules : undefined;
}
```

In `syncPlugin`, replace the tail (from `const nextKimi = ...` to the `return`) with:

```js
  const nextKimi = kimiManifest(root, pluginName, base, codex, kimi);
  const translatedHooks = kimiHooks(root, pluginName, failures);

  if (failures.length > 0) {
    return { pluginName, claude, codex, kimi };
  }

  const hooks = translatedHooks ?? kimi?.hooks;

  if (hooks) {
    nextKimi.hooks = hooks;
  }

  if (!sameJson(kimi, nextKimi)) {
    writeJson(root, files.kimi, nextKimi, options, changes);
  }

  return { pluginName, claude, codex, kimi: nextKimi };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/sync-plugin-manifests.test.cjs`
Expected: PASS — all tests, old and new.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-plugin-manifests.cjs test/sync-plugin-manifests.test.cjs
git commit -m "feat(skills): translate hooks into kimi manifest rules"
```

---

### Task 3: Generate the Kimi marketplace catalog

**Files:**
- Modify: `scripts/sync-plugin-manifests.cjs` (new `syncKimiMarketplace` after `syncCodexMarketplace` at 483-516; call added in `run` at 536-537)
- Test: `test/sync-plugin-manifests.test.cjs` (append)

**Interfaces:**
- Consumes: `plugins` array from `syncPlugin` (`{ pluginName, claude, codex, kimi }`), existing `existingOrder`, `maybeReadJson`, `writeJson`.
- Produces: `syncKimiMarketplace(root, plugins, options, changes)` writing `.kimi-plugin/marketplace.json` with shape `{ "version": "2", "plugins": [{ id, displayName?, source, ...preserved }] }`. Entry order follows the Claude marketplace order (same as the Codex marketplace sync).

- [ ] **Step 1: Write the failing tests**

Append to `test/sync-plugin-manifests.test.cjs`:

```js
test("generates the kimi marketplace catalog", () => {
  const root = makeRepo();

  writeJson(path.join(root, ".kimi-plugin", "marketplace.json"), {
    version: "2",
    plugins: [
      {
        id: "stale",
        source: "./plugins/stale",
      },
      {
        id: "beta",
        source: "./plugins/beta",
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
    ["./plugins/alpha", "./plugins/beta", "./plugins/gamma"],
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/sync-plugin-manifests.test.cjs`
Expected: FAIL — the marketplace test fails with `ENOENT` reading `.kimi-plugin/marketplace.json`; the drift test fails because `--check` exits 0 despite the drifted kimi manifest. (Note: the drift test also fails at Task 1-2 stage — kimi drift was already detected then; if it already passes, keep it and move on. The marketplace test must fail.)

- [ ] **Step 3: Implement the marketplace sync**

In `scripts/sync-plugin-manifests.cjs`, add after `syncCodexMarketplace`:

```js
function syncKimiMarketplace(root, plugins, options, changes) {
  const file = path.join(root, ".kimi-plugin", "marketplace.json");
  const current = maybeReadJson(file) ?? {
    version: "2",
    plugins: [],
  };
  const byId = new Map((current.plugins ?? []).map((entry) => [entry.id, entry]));
  const pluginNames = plugins.map((plugin) => plugin.pluginName);
  const byPlugin = new Map(plugins.map((plugin) => [plugin.pluginName, plugin]));
  const orderSource = maybeReadJson(path.join(root, ".claude-plugin", "marketplace.json")) ?? current;
  const order = existingOrder(orderSource, pluginNames);

  const next = {
    ...current,
    plugins: order.map((pluginName) => {
      const plugin = byPlugin.get(pluginName);
      const existing = byId.get(pluginName) ?? {};
      const entry = {
        ...existing,
        id: pluginName,
        source: `./plugins/${pluginName}`,
      };
      const displayName = existing.displayName ?? plugin.codex?.interface?.displayName;

      if (displayName) {
        entry.displayName = displayName;
      }

      return entry;
    }),
  };

  writeJson(root, file, next, options, changes);
}
```

In `run()`, add the call after `syncCodexMarketplace(...)` (currently lines 536-537):

```js
  syncClaudeMarketplace(options.root, plugins, options, changes);
  syncCodexMarketplace(options.root, plugins, options, changes);
  syncKimiMarketplace(options.root, plugins, options, changes);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/sync-plugin-manifests.test.cjs`
Expected: PASS — all tests, old and new.

- [ ] **Step 5: Commit**

```bash
git add scripts/sync-plugin-manifests.cjs test/sync-plugin-manifests.test.cjs
git commit -m "feat(skills): generate kimi marketplace catalog"
```

---

### Task 4: Regenerate the real repo's Kimi artifacts

**Files:**
- Create (generated): `plugins/*/.kimi-plugin/plugin.json` (17 files), `.kimi-plugin/marketplace.json`

**Interfaces:**
- Consumes: the finished sync script from Tasks 1-3.
- Produces: the committed Kimi artifacts CI will validate; `--check` must be clean afterwards (tests.yml runs `node scripts/sync-plugin-manifests.cjs --check` on every push).

- [ ] **Step 1: Run the sync on the real repo**

Run (from the repo root): `node scripts/sync-plugin-manifests.cjs`
Expected output: `Updated plugin manifests and marketplaces:` followed by 18 lines — `plugins/<name>/.kimi-plugin/plugin.json` for each of the 17 plugins plus `.kimi-plugin/marketplace.json`. No Claude/Codex files should appear in the list (their shared metadata is already in sync); if any do, inspect the diff before proceeding — it means base resolution picked a different side than committed.

- [ ] **Step 2: Verify the generated artifacts**

Run: `node scripts/sync-plugin-manifests.cjs --check`
Expected: `Plugin manifests and marketplaces are in sync.`

Then run the structural check against Kimi's documented rules:

```bash
node - <<'NODE'
const fs = require("fs");
const path = require("path");
const root = process.cwd();
const catalog = JSON.parse(fs.readFileSync(".kimi-plugin/marketplace.json", "utf8"));
if (catalog.version !== "2") throw new Error("catalog version must be \"2\"");
for (const entry of catalog.plugins) {
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(entry.id)) throw new Error(`bad id ${entry.id}`);
  const pluginRoot = path.join(root, entry.source);
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".kimi-plugin", "plugin.json"), "utf8"));
  if (manifest.name !== entry.id) throw new Error(`${entry.id}: manifest name ${manifest.name}`);
  if (manifest.skills && !fs.existsSync(path.join(pluginRoot, manifest.skills))) throw new Error(`${entry.id}: missing ${manifest.skills}`);
  for (const hook of manifest.hooks ?? []) {
    const rel = hook.command.match(/^node (\S+)$/)?.[1];
    if (rel && !fs.existsSync(path.join(pluginRoot, rel))) throw new Error(`${entry.id}: hook target ${rel} not found`);
  }
}
console.log(`verified ${catalog.plugins.length} kimi plugins`);
NODE
```

Expected: `verified 17 kimi plugins` (17 = today's plugin count; adjust if the repo gained plugins since).

Spot-check one hooks-bearing plugin:

Run: `cat plugins/qol-workflow/.kimi-plugin/plugin.json`
Expected: shared fields match `.claude-plugin/plugin.json`; `skills` is `"./skills/"`; `hooks` contains 6 rules (5 `PreToolUse`/`Bash` + 1 `UserPromptSubmit`) whose commands are plain `node bin/<file>.cjs` — no `node -e` wrappers anywhere.

- [ ] **Step 3: Run the full test suite the way CI does**

Run:

```bash
shopt -s nullglob
tests=(test/*.test.cjs plugins/*/test/*.test.cjs)
node --test "${tests[@]}"
```

Expected: all tests pass (this mirrors `.github/workflows/tests.yml`).

- [ ] **Step 4: Commit**

```bash
git add .kimi-plugin/marketplace.json plugins
git commit -m "feat(skills): add kimi plugin manifests and marketplace"
```

---

### Task 5: Wire Kimi into the sync CI workflow

**Files:**
- Modify: `.github/workflows/sync-plugin-manifests.yml` (paths at 5-12, validation snippet at 42-59, `git add` at 70)

**Interfaces:**
- Consumes: the generated `.kimi-plugin/marketplace.json` and per-plugin `.kimi-plugin/plugin.json` files from Task 4.
- Produces: CI validates the third marketplace/manifest pair and auto-commits the kimi marketplace file. (`.github/workflows/tests.yml` needs no change — it discovers tests by glob and already runs `--check`.)

- [ ] **Step 1: Add the kimi marketplace to the trigger paths**

Replace the `paths:` list (lines 8-12) with:

```yaml
    paths:
      - '.agents/plugins/marketplace.json'
      - '.claude-plugin/marketplace.json'
      - '.kimi-plugin/marketplace.json'
      - '.github/workflows/sync-plugin-manifests.yml'
      - 'plugins/**'
      - 'scripts/sync-plugin-manifests.cjs'
```

- [ ] **Step 2: Extend the validation snippet to all three marketplaces**

Replace the inline `node - <<'NODE' ... NODE` block in the `Validate generated manifests` step (lines 42-59) with:

```yaml
          node - <<'NODE'
          const fs = require("fs");
          const path = require("path");

          const markets = [
            { file: ".claude-plugin/marketplace.json", manifestDir: ".claude-plugin", key: "name" },
            { file: ".agents/plugins/marketplace.json", manifestDir: ".codex-plugin", key: "name" },
            { file: ".kimi-plugin/marketplace.json", manifestDir: ".kimi-plugin", key: "id" },
          ];

          for (const { file, manifestDir, key } of markets) {
            const marketplace = JSON.parse(fs.readFileSync(file, "utf8"));

            for (const entry of marketplace.plugins) {
              const source = typeof entry.source === "string" ? entry.source : entry.source.path;
              const manifest = JSON.parse(fs.readFileSync(path.join(source, manifestDir, "plugin.json"), "utf8"));

              if (manifest.name !== entry[key]) {
                throw new Error(`${file}: ${entry[key]} does not match ${manifest.name}`);
              }
            }
          }
          NODE
```

- [ ] **Step 3: Add the kimi marketplace to the auto-commit list**

Replace the `git add` line (line 70) with:

```yaml
          git add .agents/plugins/marketplace.json .claude-plugin/marketplace.json .kimi-plugin/marketplace.json plugins
```

- [ ] **Step 4: Verify the workflow logic locally**

Run the same validation the workflow performs, from the repo root:

```bash
node --check scripts/sync-plugin-manifests.cjs
node scripts/sync-plugin-manifests.cjs --check
node --test test/sync-plugin-manifests.test.cjs
node - <<'NODE'
const fs = require("fs");
const path = require("path");

const markets = [
  { file: ".claude-plugin/marketplace.json", manifestDir: ".claude-plugin", key: "name" },
  { file: ".agents/plugins/marketplace.json", manifestDir: ".codex-plugin", key: "name" },
  { file: ".kimi-plugin/marketplace.json", manifestDir: ".kimi-plugin", key: "id" },
];

for (const { file, manifestDir, key } of markets) {
  const marketplace = JSON.parse(fs.readFileSync(file, "utf8"));

  for (const entry of marketplace.plugins) {
    const source = typeof entry.source === "string" ? entry.source : entry.source.path;
    const manifest = JSON.parse(fs.readFileSync(path.join(source, manifestDir, "plugin.json"), "utf8"));

    if (manifest.name !== entry[key]) {
      throw new Error(`${file}: ${entry[key]} does not match ${manifest.name}`);
    }
  }
}
console.log("marketplace validation passed");
NODE
```

Expected: `Plugin manifests and marketplaces are in sync.`, all tests pass, `marketplace validation passed`.

- [ ] **Step 5: Commit**

```bash
git add .github/workflows/sync-plugin-manifests.yml
git commit -m "ci(skills): validate kimi manifests in sync workflow"
```

---

### Task 6: README and end-to-end verification

**Files:**
- Modify: `README.md` (tagline at line 5; new section after the Codex quick start, lines 17-23)

**Interfaces:**
- Consumes: everything from Tasks 1-5.
- Produces: user-facing Kimi install instructions that match verified behavior.

- [ ] **Step 1: Update the tagline**

Replace line 5:

```markdown
Claude Code and Codex skills marketplace for the [qol-tools](https://github.com/qol-tools) org.
```

with:

```markdown
Claude Code, Codex, and Kimi Code skills marketplace for the [qol-tools](https://github.com/qol-tools) org.
```

- [ ] **Step 2: Add the Kimi quick start**

Insert after the Codex section (after line 23, before `## About`):

````markdown
### Kimi Code

```bash
/plugins marketplace /path/to/qol-skills/.kimi-plugin/marketplace.json
```

Then install plugins from the Third-party tab, or install a single plugin from a local checkout:

```bash
/plugins install /path/to/qol-skills/plugins/qol-workflow
```

Plugin changes apply after `/reload` or a new session.
````

- [ ] **Step 3: Attempt non-interactive CLI verification**

Run: `kimi --help`
Look for a non-interactive/print mode (e.g. `-p`/`--print`) and any `plugins` subcommand. If one exists, try loading the marketplace catalog through it against the absolute path `/media/kmrh47/WD_SN850X/Git/qol-skills/.kimi-plugin/marketplace.json` and confirm the catalog parses and lists plugins. If the CLI offers no non-interactive path (slash commands are TUI-only), skip this — do not fake the result.

- [ ] **Step 4: Final full verification**

Run from the repo root:

```bash
node --check scripts/sync-plugin-manifests.cjs
node scripts/sync-plugin-manifests.cjs --check
shopt -s nullglob
tests=(test/*.test.cjs plugins/*/test/*.test.cjs)
node --test "${tests[@]}"
```

Expected: `--check` reports in sync; every test passes.

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs(skills): document kimi marketplace install"
```

- [ ] **Step 6: Hand the manual end-to-end check to the user**

State plainly: the structural checks pass, but the final acceptance test is interactive — the user should run, in a Kimi Code session:

```
/plugins marketplace /media/kmrh47/WD_SN850X/Git/qol-skills/.kimi-plugin/marketplace.json
```

and confirm the 17 plugins appear, then install one (e.g. `qol-workflow`), run `/reload`, and confirm its skills and hooks are active. Whether a **remote** marketplace URL (raw GitHub URL of the catalog) resolves relative `./plugins/...` sources is not verified by this plan — if the user wants GitHub-based install, that needs a follow-up once the catalog is pushed.

---

## Self-Review Notes

- Spec coverage: per-plugin manifests (Task 1), hook translation (Task 2), marketplace catalog (Task 3), real-repo regeneration (Task 4), CI wiring (Task 5), README + verification (Task 6). Out-of-scope items from the spec (slash commands, agents porting, three-way sync) are intentionally absent.
- The bin-script env audit required by the spec was done during planning: no changes needed (fallbacks cover Kimi); recorded in Global Constraints.
- The `SessionStart` matcher `startup|resume|clear` in `qol-project`/`qol-tray` hooks.json copies verbatim into Kimi rules; Kimi only ever produces `startup`/`resume` values, so the extra `clear` alternative is inert.
- Kimi has no `agents/` concept in the manifest, so `SubagentStop` matchers naming Claude subagents (e.g. `qol-tray-frontend`) simply never match under Kimi — observation-only, fail-open, consistent with the spec's out-of-scope list.

## Execution status (handoff note, 2026-07-17)

- **Task 1 is COMPLETE**: tests added to `test/sync-plugin-manifests.test.cjs`, implementation in `scripts/sync-plugin-manifests.cjs` (KIMI_* constants, `manifestPaths` kimi entry, `kimiInterface`, `kimiManifest`, rewritten `syncPlugin`). `node --test test/sync-plugin-manifests.test.cjs` → 15/15 pass.
- **Nothing is committed** — the user commits manually. Do not `git checkout`/`git clean`; the work lives in the working tree.
- Resume at **Task 2** (hook translation), following the plan task-by-task.
