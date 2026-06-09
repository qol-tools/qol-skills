const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const AUTHOR = { name: "KMRH47" };
const SHARED_FIELDS = ["name", "description", "version", "author"];

function parseArgs(argv) {
  const envBaseRef = process.env.PLUGIN_SYNC_BASE_REF;
  const options = {
    check: false,
    root: path.resolve(__dirname, ".."),
    baseRef: envBaseRef,
    baseRefExplicit: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--check") {
      options.check = true;
      continue;
    }

    if (arg === "--root") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--root requires a path");
      }
      options.root = path.resolve(value);
      index += 1;
      continue;
    }

    if (arg === "--base-ref") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--base-ref requires a git ref");
      }
      options.baseRef = value;
      options.baseRefExplicit = true;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function maybeReadJson(file) {
  if (!fs.existsSync(file)) {
    return null;
  }
  return readJson(file);
}

function jsonText(value) {
  return `${JSON.stringify(value, null, 2).replace(/[^\x00-\x7F]/g, (char) => {
    const point = char.codePointAt(0).toString(16).padStart(4, "0");
    return `\\u${point}`;
  })}\n`;
}

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, "\n");
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function writeJson(root, file, value, options, changes) {
  const next = jsonText(value);
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;

  if (current !== null && normalizeNewlines(current) === next) {
    return;
  }

  changes.push(relative(root, file));

  if (options.check) {
    return;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
}

function directories(dir) {
  if (!fs.existsSync(dir)) {
    return [];
  }

  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

function hasDir(root, pluginName, childName) {
  return fs.existsSync(path.join(root, "plugins", pluginName, childName));
}

function hasFile(root, pluginName, fileName) {
  return fs.existsSync(path.join(root, "plugins", pluginName, fileName));
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function hasBaseRef(ref) {
  return ref !== undefined && ref !== null && ref !== "";
}

function allZeroRef(ref) {
  return /^0+$/.test(ref);
}

function unsafeBaseRef(ref) {
  return ref.startsWith("-") || /[\x00-\x1F\x7F]/.test(ref);
}

function logValue(value, maxLength = 160) {
  const text = String(value ?? "");
  const clipped = text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
  return JSON.stringify(clipped);
}

function gitErrorMessage(error) {
  const message = error.stderr?.toString().trim() || error.message;
  return logValue(message, 240);
}

function resolveBaseRef(root, baseRef) {
  if (unsafeBaseRef(baseRef)) {
    throw new Error(`Invalid manifest sync base ref ${logValue(baseRef)}: refs must not start with '-' or contain control characters`);
  }

  if (allZeroRef(baseRef)) {
    return { ok: false, message: "all-zero ref" };
  }

  try {
    const commit = execFileSync(
      "git",
      ["rev-parse", "--verify", "--end-of-options", `${baseRef}^{commit}`],
      { cwd: root, encoding: "utf8" },
    ).trim();
    return { ok: true, commit };
  } catch (error) {
    return { ok: false, message: gitErrorMessage(error) };
  }
}

function unknownBaseRef(baseRef, message, options) {
  if (options.baseRefExplicit) {
    throw new Error(`Could not resolve manifest sync base ref ${logValue(baseRef)}: ${message}`);
  }

  console.warn(
    `Could not resolve manifest sync base ref ${logValue(baseRef)}; changed-file provenance is unavailable: ${message}`,
  );
  return changedFilesResult(new Set(), { provenanceKnown: false });
}

function changedFilesResult(files, options = {}) {
  return {
    files,
    provenanceKnown: options.provenanceKnown ?? true,
  };
}

function readChangedFiles(root, diffArgs) {
  return new Set(execFileSync("git", diffArgs, { cwd: root, encoding: "utf8" })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((file) => file.split(path.sep).join("/")));
}

function gitChangedFiles(root, baseRef, options = {}) {
  if (!hasBaseRef(baseRef)) {
    try {
      return changedFilesResult(readChangedFiles(root, ["diff", "--name-only", "HEAD", "--"]));
    } catch {
      return changedFilesResult(new Set());
    }
  }

  const resolved = resolveBaseRef(root, baseRef);

  if (!resolved.ok) {
    return unknownBaseRef(baseRef, resolved.message, options);
  }

  try {
    return changedFilesResult(readChangedFiles(root, [
      "diff",
      "--name-only",
      "--end-of-options",
      `${resolved.commit}..HEAD`,
      "--",
    ]));
  } catch (error) {
    return unknownBaseRef(baseRef, gitErrorMessage(error), options);
  }
}

function firstSkillDescription(root, pluginName) {
  const skillsDir = path.join(root, "plugins", pluginName, "skills");
  const skillNames = directories(skillsDir);

  for (const skillName of skillNames) {
    const skillFile = path.join(skillsDir, skillName, "SKILL.md");
    if (!fs.existsSync(skillFile)) {
      continue;
    }

    const text = fs.readFileSync(skillFile, "utf8");
    const match = text.match(/^---\n([\s\S]*?)\n---/);
    if (!match) {
      continue;
    }

    const description = match[1].split(/\r?\n/)
      .map((line) => line.match(/^description:\s*(.+)$/))
      .find(Boolean);

    if (description) {
      return description[1].trim().replace(/^["']|["']$/g, "");
    }
  }

  return null;
}

function baseManifest(root, pluginName, claudeManifest, codexManifest) {
  const source = claudeManifest ?? codexManifest ?? {};

  return {
    name: source.name ?? pluginName,
    description: source.description ?? firstSkillDescription(root, pluginName) ?? `Skills for ${pluginName}.`,
    version: source.version ?? "0.1.0",
    author: source.author ?? AUTHOR,
  };
}

function sharedFields(manifest) {
  const shared = {};

  for (const field of SHARED_FIELDS) {
    shared[field] = manifest?.[field];
  }

  return shared;
}

function baseFromManifest(root, pluginName, manifest) {
  return {
    name: manifest?.name ?? pluginName,
    description: manifest?.description ?? firstSkillDescription(root, pluginName) ?? `Skills for ${pluginName}.`,
    version: manifest?.version ?? "0.1.0",
    author: manifest?.author ?? AUTHOR,
  };
}

function sharedBase(root, pluginName, claudeManifest, codexManifest, files, changedFiles, failures) {
  if (!claudeManifest || !codexManifest) {
    return baseManifest(root, pluginName, claudeManifest, codexManifest);
  }

  if (sameJson(sharedFields(claudeManifest), sharedFields(codexManifest))) {
    return baseFromManifest(root, pluginName, claudeManifest);
  }

  if (!changedFiles.provenanceKnown) {
    failures.push(`Cannot resolve shared manifest metadata edits in plugins/${pluginName}: Claude and Codex metadata differ, but changed-file provenance is unavailable`);
    return baseFromManifest(root, pluginName, claudeManifest);
  }

  const claudeChanged = changedFiles.files.has(relative(root, files.claude));
  const codexChanged = changedFiles.files.has(relative(root, files.codex));

  if (claudeChanged && codexChanged) {
    failures.push(`Conflicting shared manifest metadata edits in plugins/${pluginName}`);
    return baseFromManifest(root, pluginName, claudeManifest);
  }

  if (codexChanged) {
    return baseFromManifest(root, pluginName, codexManifest);
  }

  return baseFromManifest(root, pluginName, claudeManifest);
}

function syncSharedFields(manifest, base) {
  const next = { ...manifest };

  for (const field of SHARED_FIELDS) {
    next[field] = base[field];
  }

  return next;
}

function codexManifest(root, pluginName, base, existing = {}) {
  const manifest = syncSharedFields(existing, base);

  if (hasDir(root, pluginName, "skills")) {
    manifest.skills = "./skills/";
  }

  if (hasFile(root, pluginName, ".mcp.json")) {
    manifest.mcpServers = "./.mcp.json";
  }

  if (hasFile(root, pluginName, ".app.json")) {
    manifest.apps = "./.app.json";
  }

  return manifest;
}

function claudeManifest(base, codexSource) {
  const manifest = {
    name: base.name,
    description: base.description,
    version: base.version,
    author: base.author,
  };

  if (codexSource?.interface?.displayName) {
    manifest.displayName = codexSource.interface.displayName;
  }

  return manifest;
}

function validateManifestName(kind, root, pluginName, manifest, failures) {
  if (!manifest) {
    return;
  }

  if (manifest.name === pluginName) {
    return;
  }

  failures.push(`${kind} manifest name mismatch in plugins/${pluginName}: ${manifest.name}`);
}

function manifestPaths(root, pluginName) {
  const pluginRoot = path.join(root, "plugins", pluginName);

  return {
    claude: path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    codex: path.join(pluginRoot, ".codex-plugin", "plugin.json"),
  };
}

function syncPlugin(root, pluginName, options, changes, failures, changedFiles) {
  const files = manifestPaths(root, pluginName);
  let claude = maybeReadJson(files.claude);
  let codex = maybeReadJson(files.codex);

  validateManifestName("Claude", root, pluginName, claude, failures);
  validateManifestName("Codex", root, pluginName, codex, failures);

  if (failures.length > 0) {
    return { pluginName, claude, codex };
  }

  const base = sharedBase(root, pluginName, claude, codex, files, changedFiles, failures);

  if (failures.length > 0) {
    return { pluginName, claude, codex };
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

  return { pluginName, claude, codex };
}

function existingOrder(marketplace, pluginNames) {
  const valid = new Set(pluginNames);
  const seen = new Set();
  const ordered = [];

  for (const entry of marketplace?.plugins ?? []) {
    const sourcePath = typeof entry.source === "string" ? entry.source : entry.source?.path;
    const sourceName = sourcePath ? path.basename(sourcePath) : entry.name;
    const name = valid.has(sourceName) ? sourceName : entry.name;

    if (!valid.has(name) || seen.has(name)) {
      continue;
    }

    seen.add(name);
    ordered.push(name);
  }

  for (const pluginName of pluginNames) {
    if (seen.has(pluginName)) {
      continue;
    }

    ordered.push(pluginName);
  }

  return ordered;
}

function defaultCodexPolicy(codexMarketplace) {
  const existing = codexMarketplace?.plugins?.find((entry) => entry.policy)?.policy;

  return {
    installation: existing?.installation ?? "INSTALLED_BY_DEFAULT",
    authentication: existing?.authentication ?? "ON_INSTALL",
  };
}

function defaultCodexCategory(codexMarketplace) {
  return codexMarketplace?.plugins?.find((entry) => entry.category)?.category ?? "Productivity";
}

function syncClaudeMarketplace(root, plugins, options, changes) {
  const file = path.join(root, ".claude-plugin", "marketplace.json");
  const current = maybeReadJson(file) ?? {
    name: "qol-skills",
    description: "Claude Code skills for the qol-tools ecosystem.",
    owner: AUTHOR,
    plugins: [],
  };
  const byName = new Map((current.plugins ?? []).map((entry) => [entry.name, entry]));
  const pluginNames = plugins.map((plugin) => plugin.pluginName);
  const byPlugin = new Map(plugins.map((plugin) => [plugin.pluginName, plugin]));
  const order = existingOrder(current, pluginNames);

  const next = {
    ...current,
    plugins: order.map((pluginName) => {
      const plugin = byPlugin.get(pluginName);
      const existing = byName.get(pluginName) ?? {};

      return {
        ...existing,
        name: pluginName,
        description: plugin.claude.description,
        source: `./plugins/${pluginName}`,
        version: plugin.claude.version,
        author: plugin.claude.author,
      };
    }),
  };

  writeJson(root, file, next, options, changes);
}

function syncCodexMarketplace(root, plugins, options, changes) {
  const file = path.join(root, ".agents", "plugins", "marketplace.json");
  const current = maybeReadJson(file) ?? {
    name: "qol-skills",
    interface: { displayName: "qol-skills" },
    plugins: [],
  };
  const byName = new Map((current.plugins ?? []).map((entry) => [entry.name, entry]));
  const pluginNames = plugins.map((plugin) => plugin.pluginName);
  const orderSource = maybeReadJson(path.join(root, ".claude-plugin", "marketplace.json")) ?? current;
  const order = existingOrder(orderSource, pluginNames);
  const policy = defaultCodexPolicy(current);
  const category = defaultCodexCategory(current);

  const next = {
    ...current,
    plugins: order.map((pluginName) => {
      const existing = byName.get(pluginName) ?? {};

      return {
        ...existing,
        name: pluginName,
        source: {
          source: "local",
          path: `./plugins/${pluginName}`,
        },
        policy: existing.policy ?? policy,
        category: existing.category ?? category,
      };
    }),
  };

  writeJson(root, file, next, options, changes);
}

function run() {
  const options = parseArgs(process.argv.slice(2));
  const pluginNames = directories(path.join(options.root, "plugins"));
  const changes = [];
  const failures = [];
  const changedFiles = gitChangedFiles(options.root, options.baseRef, {
    baseRefExplicit: options.baseRefExplicit,
  });
  const plugins = pluginNames.map((pluginName) => syncPlugin(options.root, pluginName, options, changes, failures, changedFiles));

  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure);
    }
    process.exitCode = 1;
    return;
  }

  syncClaudeMarketplace(options.root, plugins, options, changes);
  syncCodexMarketplace(options.root, plugins, options, changes);

  if (changes.length === 0) {
    console.log("Plugin manifests and marketplaces are in sync.");
    return;
  }

  if (options.check) {
    console.error("Plugin manifests and marketplaces are out of sync:");
    for (const file of changes) {
      console.error(`- ${file}`);
    }
    process.exitCode = 1;
    return;
  }

  console.log("Updated plugin manifests and marketplaces:");
  for (const file of changes) {
    console.log(`- ${file}`);
  }
}

try {
  run();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
