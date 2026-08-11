const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const AUTHOR = { name: "KMRH47" };
const SHARED_FIELDS = ["name", "description", "version", "author"];
const KIMI_METADATA_FIELDS = ["keywords", "homepage", "license"];
const KIMI_BEHAVIOR_FIELDS = ["sessionStart", "skillInstructions", "commands", "mcpServers"];
const KIMI_INTERFACE_FIELDS = ["displayName", "shortDescription", "longDescription", "developerName", "websiteURL"];

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

    const lines = match[1].split(/\r?\n/);
    const index = lines.findIndex((line) => /^description:\s*(.+)$/.test(line));
    if (index === -1) {
      continue;
    }

    const head = lines[index].replace(/^description:\s*/, "").trim();
    const blockIndicator = head.match(/^([>|])[+-]?$/);
    if (blockIndicator) {
      return parseBlockScalar(lines.slice(index + 1), blockIndicator[1]);
    }
    return unescapeYamlDescription(head);
  }

  return null;
}

function parseBlockScalar(lines, style) {
  const content = [];
  for (const line of lines) {
    if (line.trim() === "") {
      content.push("");
      continue;
    }
    if (!/^\s+/.test(line)) {
      break;
    }
    content.push(line.trim());
  }
  if (style === "|") {
    return content.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  const parts = [];
  let pendingBlank = false;
  for (const line of content) {
    if (line === "") {
      pendingBlank = true;
      continue;
    }
    if (pendingBlank) {
      parts.push("\n");
      pendingBlank = false;
    }
    parts.push(line);
  }
  return parts.join(" ").replace(/ \n /g, "\n\n").trim();
}

function unescapeYamlDescription(value) {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
    }
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed;
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
    manifest.skills = ["./skills/"];
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

function piHookCommand(command, pluginName) {
  const match = command.match(/^node -e '[^']*' (\S+) (\S+)$/);

  if (match && match[1] === pluginName) {
    return match[2];
  }

  return command;
}

function piExtensionContent(root, pluginName, failures) {
  const hooksFile = path.join(root, "plugins", pluginName, "hooks", "hooks.json");

  if (!fs.existsSync(hooksFile)) {
    return null;
  }

  let document;

  try {
    document = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
  } catch (error) {
    failures.push(`Cannot parse hooks/hooks.json in plugins/${pluginName}: ${error.message}`);
    return null;
  }

  const preToolUse = [];
  const userPromptSubmit = [];
  const sessionStart = [];
  const preCompact = [];
  const stopGuards = [];

  for (const [event, entries] of Object.entries(document?.hooks ?? {})) {
    if (!Array.isArray(entries)) {
      continue;
    }

    for (const entry of entries) {
      for (const hook of entry?.hooks ?? []) {
        if (hook?.type !== "command" || typeof hook.command !== "string") {
          continue;
        }

        const script = piHookCommand(hook.command, pluginName);

        if (event === "PreToolUse" && entry?.matcher) {
          preToolUse.push({ matcher: entry.matcher, script });
        } else if (event === "UserPromptSubmit") {
          userPromptSubmit.push({ script });
        } else if (event === "SessionStart") {
          sessionStart.push({ script });
        } else if (event === "PreCompact") {
          preCompact.push({ script });
        } else if (event === "Stop") {
          stopGuards.push({ script });
        }
      }
    }
  }

  if (
    preToolUse.length === 0
    && userPromptSubmit.length === 0
    && sessionStart.length === 0
    && preCompact.length === 0
    && stopGuards.length === 0
  ) {
    return null;
  }

  const lines = [];
  const typeImport = stopGuards.length > 0
    ? 'import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";'
    : 'import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";';

  lines.push(typeImport);
  lines.push('import { spawnSync } from "node:child_process";');
  lines.push('import path from "node:path";');
  lines.push("");
  lines.push('const PLUGIN_DIR = path.resolve(__dirname, "../..");');
  lines.push("");
  lines.push("const PRE_TOOL_USE_HOOKS = [");
  for (const hook of preToolUse) {
    lines.push(`    { matcher: ${JSON.stringify(hook.matcher)}, script: ${JSON.stringify(hook.script)} },`);
  }
  lines.push("];");
  lines.push("");
  lines.push("const USER_PROMPT_SUBMIT_HOOKS = [");
  for (const hook of userPromptSubmit) {
    lines.push(`    { script: ${JSON.stringify(hook.script)} },`);
  }
  lines.push("];");

  if (sessionStart.length > 0) {
    lines.push("");
    lines.push("const SESSION_START_CONTEXT_HOOKS = [");
    for (const hook of sessionStart) {
      lines.push(`    { script: ${JSON.stringify(hook.script)} },`);
    }
    lines.push("];");
  }

  if (preCompact.length > 0) {
    lines.push("");
    lines.push("const PRE_COMPACT_HOOKS = [");
    for (const hook of preCompact) {
      lines.push(`    { script: ${JSON.stringify(hook.script)} },`);
    }
    lines.push("];");
  }

  if (stopGuards.length > 0) {
    lines.push("");
    lines.push("const STOP_GUARD_HOOKS = [");
    for (const hook of stopGuards) {
      lines.push(`    { script: ${JSON.stringify(hook.script)} },`);
    }
    lines.push("];");
  }

  if (sessionStart.length > 0) {
    lines.push("");
    lines.push('let stashedContext = "";');
    lines.push('let stashedSessionFile = "";');
    lines.push('let injectedSessionFile = "";');
  }

  lines.push("");
  lines.push("function runHook(script, input) {");
  lines.push("  const scriptPath = path.join(PLUGIN_DIR, script);");
  lines.push("");
  lines.push("  let result;");
  lines.push("");
  lines.push("  try {");
  lines.push("    result = spawnSync(process.execPath, [scriptPath], {");
  lines.push('      input,');
  lines.push('      encoding: "utf-8",');
  lines.push("      timeout: 5000,");
  lines.push("    });");
  lines.push("  } catch (_error) {");
  lines.push("    return { blocked: false };");
  lines.push("  }");
  lines.push("");
  lines.push('  const stdout = (result?.stdout ?? "").trim();');
  lines.push('  const stderr = (result?.stderr ?? "").trim();');
  lines.push("");
  lines.push("  if (result?.status !== 0 && result?.status !== null) {");
  lines.push('    return { blocked: true, reason: stderr || stdout || `Blocked by ${script}` };');
  lines.push("  }");
  lines.push("");
  lines.push("  let context;");
  lines.push("");
  lines.push("  if (stdout) {");
  lines.push("    try {");
  lines.push("      const parsed = JSON.parse(stdout);");
  lines.push("");
  lines.push('      if (parsed?.decision === "block") {');
  lines.push("        return {");
  lines.push("          blocked: true,");
  lines.push('          reason: parsed?.reason || `Blocked by ${script}`,');
  lines.push("        };");
  lines.push("      }");
  lines.push("");
  lines.push("      const decision = parsed?.hookSpecificOutput;");
  lines.push("");
  lines.push('      if (decision?.permissionDecision === "deny") {');
  lines.push("        return {");
  lines.push("          blocked: true,");
  lines.push('          reason: decision.permissionDecisionReason || `Blocked by ${script}`,');
  lines.push("        };");
  lines.push("      }");
  lines.push("");
  lines.push("      context = decision?.additionalContext;");
  lines.push("    } catch (_ignored) {}");
  lines.push("  }");
  lines.push("");
  lines.push("  return { blocked: false, context };");
  lines.push("}");
  lines.push("");
  lines.push("function matchedToolName(matcher, toolName) {");
  lines.push("  return matcher");
  lines.push('    .split("|")');
  lines.push("    .map((name) => name.trim())");
  lines.push("    .find((name) => name.toLowerCase() === toolName.toLowerCase());");
  lines.push("}");

  if (stopGuards.length > 0) {
    lines.push("");
    lines.push("function stopGuardInput(ctx: ExtensionContext) {");
    lines.push("  return JSON.stringify({");
    lines.push('    transcript_path: ctx.sessionManager.getSessionFile() ?? "",');
    lines.push('    cwd: process.cwd(),');
    lines.push('    hook_event_name: "Stop",');
    lines.push("  });");
    lines.push("}");
  }

  lines.push("");
  lines.push("export default function (pi: ExtensionAPI) {");

  if (preToolUse.length > 0) {
    lines.push("  if (PRE_TOOL_USE_HOOKS.length > 0) {");
    lines.push('    pi.on("tool_call", async (event, _ctx) => {');
    lines.push("      if (!event.toolName) {");
    lines.push("        return;");
    lines.push("      }");
    lines.push("");
    lines.push("      const hook = PRE_TOOL_USE_HOOKS.find(");
    lines.push("        (h) => h.matcher && matchedToolName(h.matcher, event.toolName)");
    lines.push("      );");
    lines.push("");
    lines.push("      if (!hook) {");
    lines.push("        return;");
    lines.push("      }");
    lines.push("");
    lines.push("      const input = JSON.stringify({");
    lines.push("        tool_name: matchedToolName(hook.matcher, event.toolName),");
    lines.push("        tool_input: event.input ?? {},");
    lines.push("      });");
    lines.push("      const result = runHook(hook.script, input);");
    lines.push("");
    lines.push("      if (result.blocked) {");
    lines.push("        return { block: true, reason: result.reason };");
    lines.push("      }");
    lines.push("    });");
    lines.push("  }");
  }

  if (userPromptSubmit.length > 0) {
    lines.push("");
    lines.push("  if (USER_PROMPT_SUBMIT_HOOKS.length > 0) {");
    lines.push('    pi.on("before_agent_start", async (event, _ctx) => {');
    lines.push('      let extraContext = "";');
    lines.push("");
    lines.push("      for (const hook of USER_PROMPT_SUBMIT_HOOKS) {");
    lines.push('        const cwd = event.systemPromptOptions?.cwd ?? "";');
    lines.push("        const input = JSON.stringify({ cwd, prompt: event.prompt });");
    lines.push("        const result = runHook(hook.script, input);");
    lines.push("");
    lines.push("        if (result.context) {");
    lines.push('          extraContext += "\\n\\n" + result.context;');
    lines.push("        }");
    lines.push("      }");
    lines.push("");
    lines.push("      if (extraContext) {");
    lines.push('        return { systemPrompt: (event.systemPrompt ?? "") + extraContext };');
    lines.push("      }");
    lines.push("    });");
    lines.push("  }");
  }

  if (sessionStart.length > 0) {
    lines.push("");
    lines.push("  if (SESSION_START_CONTEXT_HOOKS.length > 0) {");
    lines.push('    pi.on("session_start", async (_event, ctx) => {');
    lines.push('      const sessionFile = ctx.sessionManager.getSessionFile() ?? "";');
    lines.push("      const sessionId = path.basename(sessionFile);");
    lines.push('      let context = "";');
    lines.push("");
    lines.push("      for (const hook of SESSION_START_CONTEXT_HOOKS) {");
    lines.push("        const result = runHook(hook.script, JSON.stringify({ session_id: sessionId }));");
    lines.push("");
    lines.push("        if (result.context) {");
    lines.push('          context += "\\n\\n" + result.context;');
    lines.push("        }");
    lines.push("      }");
    lines.push("");
    lines.push("      stashedContext = context;");
    lines.push("      stashedSessionFile = sessionFile;");
    lines.push("    });");
    lines.push("");
    lines.push('    pi.on("before_agent_start", async (event, ctx) => {');
    lines.push('      const sessionFile = ctx.sessionManager.getSessionFile() ?? "";');
    lines.push("");
    lines.push("      if (");
    lines.push("        stashedContext");
    lines.push("        && sessionFile === stashedSessionFile");
    lines.push("        && sessionFile !== injectedSessionFile");
    lines.push("      ) {");
    lines.push("        injectedSessionFile = sessionFile;");
    lines.push('        return { systemPrompt: (event.systemPrompt ?? "") + "\\n\\n" + stashedContext };');
    lines.push("      }");
    lines.push("    });");
    lines.push("  }");
  }

  if (preCompact.length > 0) {
    lines.push("");
    lines.push("  if (PRE_COMPACT_HOOKS.length > 0) {");
    lines.push('    pi.on("session_before_compact", async (_event, ctx) => {');
    lines.push('      const sessionId = path.basename(ctx.sessionManager.getSessionFile() ?? "");');
    lines.push("");
    lines.push("      for (const hook of PRE_COMPACT_HOOKS) {");
    lines.push("        runHook(hook.script, JSON.stringify({ session_id: sessionId }));");
    lines.push("      }");
    lines.push("    });");
    lines.push("  }");
  }

  if (stopGuards.length > 0) {
    lines.push("");
    lines.push("  if (STOP_GUARD_HOOKS.length > 0) {");
    lines.push('    pi.on("session_before_switch", async (_event, ctx) => {');
    lines.push("      const input = stopGuardInput(ctx);");
    lines.push("");
    lines.push("      for (const hook of STOP_GUARD_HOOKS) {");
    lines.push("        const result = runHook(hook.script, input);");
    lines.push("");
    lines.push("        if (result.blocked) {");
    lines.push("          return { cancel: true };");
    lines.push("        }");
    lines.push("      }");
    lines.push("    });");
    lines.push("");
    lines.push('    pi.on("session_shutdown", async (event, ctx) => {');
    lines.push('      if (event.reason !== "quit") {');
    lines.push("        return;");
    lines.push("      }");
    lines.push("");
    lines.push("      const input = stopGuardInput(ctx);");
    lines.push("");
    lines.push("      for (const hook of STOP_GUARD_HOOKS) {");
    lines.push("        const result = runHook(hook.script, input);");
    lines.push("");
    lines.push("        if (result.blocked) {");
    lines.push('          ctx.ui.notify(result.reason, "warning");');
    lines.push("        }");
    lines.push("      }");
    lines.push("    });");
    lines.push("  }");
  }

  lines.push("}");
  lines.push("");

  return lines.join("\n");
}

function piManifest(base) {
  return {
    name: base.name,
    description: base.description,
    version: base.version,
    author: base.author,
  };
}

function syncPiPlugin(root, pluginName, base, options, changes, failures) {
  const files = manifestPaths(root, pluginName);
  const existing = maybeReadJson(files.pi);
  const next = piManifest(base);

  if (!sameJson(existing, next)) {
    writeJson(root, files.pi, next, options, changes);
  }

  const extensionContent = piExtensionContent(root, pluginName, failures);
  const extensionsDir = path.join(root, "plugins", pluginName, ".pi", "extensions");
  const hooksTs = path.join(extensionsDir, "hooks.ts");

  if (extensionContent) {
    const current = fs.existsSync(hooksTs) ? fs.readFileSync(hooksTs, "utf8") : null;

    if (current === null || normalizeNewlines(current) !== normalizeNewlines(extensionContent)) {
      fs.mkdirSync(extensionsDir, { recursive: true });
      fs.writeFileSync(hooksTs, extensionContent);
      changes.push(relative(root, hooksTs));
    }
  } else if (fs.existsSync(hooksTs)) {
    fs.unlinkSync(hooksTs);
    changes.push(relative(root, hooksTs));

    try {
      const remaining = fs.readdirSync(extensionsDir);

      if (remaining.length === 0) {
        fs.rmdirSync(extensionsDir);
      }
    } catch (_ignored) {}
  }
}

const TOOL_EXTENSION_SOURCES = {
  "qol-sessions": {
    command: ["qol", "sessions", "export", "pi"],
    file: "extensions/hooks.ts",
  },
};

function syncToolExtension(root, pluginName, options, changes, failures) {
  const source = TOOL_EXTENSION_SOURCES[pluginName];

  if (!source) {
    return;
  }

  let generated;

  try {
    generated = execFileSync(source.command[0], source.command.slice(1), {
      cwd: root,
      encoding: "utf8",
      timeout: 30_000,
    });
  } catch (error) {
    if (error.code === "ENOENT") {
      console.warn(
        `qol not found on PATH; skipping ${pluginName} ${source.file} drift check (advisory)`,
      );
      return;
    }
    failures.push(
      `Cannot generate ${pluginName} ${source.file}: ${gitErrorMessage(error)}`,
    );
    return;
  }

  const file = path.join(root, "plugins", pluginName, source.file);
  const current = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;

  if (current !== null && normalizeNewlines(current) === normalizeNewlines(generated)) {
    return;
  }

  changes.push(relative(root, file));

  if (options.check) {
    return;
  }

  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, generated);
}

function syncPiRootPackageJson(root, plugins, options, changes) {
  const file = path.join(root, "package.json");
  const current = maybeReadJson(file) ?? {
    name: "qol-skills",
    version: "1.0.0",
  };
  const pluginNames = plugins.map((plugin) => plugin.pluginName);

  const extensionsGlobs = [];

  for (const pluginName of pluginNames) {
    const piPluginsDir = path.join(root, "plugins", pluginName, ".pi", "extensions");

    if (fs.existsSync(piPluginsDir)) {
      extensionsGlobs.push(`./plugins/${pluginName}/.pi/extensions`);
    }

    const toolsDir = path.join(root, "plugins", pluginName, "extensions");

    if (fs.existsSync(toolsDir)) {
      extensionsGlobs.push(`./plugins/${pluginName}/extensions`);
    }
  }

  const pi = {
    ...(current.pi ?? {}),
    skills: current.pi?.skills ?? ["./plugins/*/skills"],
    extensions: extensionsGlobs.length > 0 ? extensionsGlobs : undefined,
  };

  if (!pi.extensions) {
    delete pi.extensions;
  }

  const next = {
    ...current,
    name: current.name ?? "qol-skills",
    version: current.version ?? "1.0.0",
    keywords: current.keywords ?? ["pi-package"],
    pi,
  };

  writeJson(root, file, next, options, changes);
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
    kimi: path.join(pluginRoot, ".kimi-plugin", "plugin.json"),
    pi: path.join(pluginRoot, ".pi-plugin", "plugin.json"),
  };
}

function syncPlugin(root, pluginName, options, changes, failures, changedFiles) {
  const files = manifestPaths(root, pluginName);
  let claude = maybeReadJson(files.claude);
  let codex = maybeReadJson(files.codex);
  const kimi = maybeReadJson(files.kimi);
  const pi = maybeReadJson(files.pi);

  validateManifestName("Claude", root, pluginName, claude, failures);
  validateManifestName("Codex", root, pluginName, codex, failures);
  validateManifestName("Kimi", root, pluginName, kimi, failures);
  validateManifestName("Pi", root, pluginName, pi, failures);

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

  syncPiPlugin(root, pluginName, base, options, changes, failures);
  syncToolExtension(root, pluginName, options, changes, failures);

  return { pluginName, claude, codex, kimi: nextKimi };
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
        source: `../plugins/${pluginName}`,
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

function kimiRootHookCommand(command, pluginName) {
  const match = command.match(/^node (\S+)$/);

  if (!match) {
    return command;
  }

  return `node plugins/${pluginName}/${match[1]}`;
}

function syncKimiRootPlugin(root, plugins, options, changes, failures) {
  const claudeMarketplace = maybeReadJson(path.join(root, ".claude-plugin", "marketplace.json"));
  const source = claudeMarketplace ?? { name: "qol-skills", description: "Skills for the qol-tools ecosystem.", owner: AUTHOR };
  const current = maybeReadJson(path.join(root, "kimi.plugin.json")) ?? {};
  const skills = [];
  const hooks = [];

  for (const { pluginName } of plugins) {
    if (hasDir(root, pluginName, "skills")) {
      skills.push(`./plugins/${pluginName}/skills/`);
    }

    for (const rule of kimiHooks(root, pluginName, failures) ?? []) {
      hooks.push({ ...rule, command: kimiRootHookCommand(rule.command, pluginName) });
    }
  }

  const next = {
    ...current,
    name: source.name ?? current.name ?? "qol-skills",
    version: current.version ?? "1.0.0",
    description: source.description ?? current.description ?? "Skills for the qol-tools ecosystem.",
    author: source.owner ?? current.author ?? AUTHOR,
  };

  delete next.skills;
  delete next.hooks;

  if (skills.length > 0) {
    next.skills = skills;
  }

  if (hooks.length > 0) {
    next.hooks = hooks;
  }

  writeJson(root, path.join(root, "kimi.plugin.json"), next, options, changes);
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
  syncKimiMarketplace(options.root, plugins, options, changes);
  syncKimiRootPlugin(options.root, plugins, options, changes, failures);
  syncPiRootPackageJson(options.root, plugins, options, changes);

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
