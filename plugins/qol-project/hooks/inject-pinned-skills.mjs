import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PART_LIMIT = 8000;

function frontmatterRange(lines) {
  if (lines.length === 0 || lines[0].trim() !== "---") return null;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") return { start: 1, end: index };
  }
  return null;
}

export function isPinned(markdown) {
  const lines = String(markdown ?? "").split("\n");
  const range = frontmatterRange(lines);
  if (range === null) return false;
  const block = lines.slice(range.start, range.end);
  const start = block.findIndex((line) => /^metadata:\s*$/.test(line));
  if (start === -1) return false;
  for (let index = start + 1; index < block.length; index += 1) {
    const line = block[index];
    if (line.trim() === "") continue;
    if (line.length === line.trimStart().length) return false;
    if (/^pinned:\s*["']?session["']?\s*$/.test(line.trim())) return true;
  }
  return false;
}

export function skillBody(markdown) {
  const lines = String(markdown ?? "").split("\n");
  const range = frontmatterRange(lines);
  if (range === null) return lines.join("\n").trim();
  return lines.slice(range.end + 1).join("\n").trim();
}

export function pluginName(pluginRoot) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf8"));
    if (typeof manifest?.name === "string" && manifest.name !== "") return manifest.name;
  } catch {}
  return path.basename(pluginRoot);
}

export function pinnedSkills(pluginRoot) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(pluginRoot, "skills"), { withFileTypes: true });
  } catch {
    return [];
  }
  const skills = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let markdown;
    try {
      markdown = fs.readFileSync(path.join(pluginRoot, "skills", entry.name, "SKILL.md"), "utf8");
    } catch {
      continue;
    }
    if (!isPinned(markdown)) continue;
    skills.push({ skill: entry.name, body: skillBody(markdown) });
  }
  return skills.sort((left, right) => (left.skill < right.skill ? -1 : left.skill > right.skill ? 1 : 0));
}

function splitBlocks(body) {
  const blocks = [];
  let current = [];
  let fenced = false;
  for (const line of body.split("\n")) {
    if (line.startsWith("```")) fenced = !fenced;
    if (!fenced && line.trim() === "") {
      if (current.length > 0) {
        blocks.push(current.join("\n"));
        current = [];
      }
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join("\n"));
  return blocks;
}

function splitOversizedBlock(block, room) {
  if (block.length <= room) return [block];
  const pieces = [];
  let current = [];
  let length = 0;
  const flush = () => {
    if (current.length === 0) return;
    pieces.push(current.join("\n"));
    current = [];
    length = 0;
  };
  const append = (line) => {
    length = current.length === 0 ? line.length : length + 1 + line.length;
    current.push(line);
  };
  for (const line of block.split("\n")) {
    if (line.length > room) {
      flush();
      let rest = line;
      while (rest.length > room) {
        pieces.push(rest.slice(0, room));
        rest = rest.slice(room);
      }
      if (rest !== "") append(rest);
      continue;
    }
    if (current.length > 0 && length + 1 + line.length > room) flush();
    append(line);
  }
  flush();
  return pieces;
}

function packBlocks(blocks, room) {
  const available = Math.max(1, room);
  const chunks = [];
  let current = "";
  let length = 0;
  for (const block of blocks) {
    for (const piece of splitOversizedBlock(block, available)) {
      if (length > 0 && length + 2 + piece.length > available) {
        chunks.push(current);
        current = "";
        length = 0;
      }
      if (length > 0) {
        current += `\n\n${piece}`;
        length += 2 + piece.length;
      } else {
        current = piece;
        length = piece.length;
      }
    }
  }
  if (length > 0) chunks.push(current);
  return chunks;
}

function skillParts(plugin, skill, body) {
  const blocks = splitBlocks(body);
  const content = blocks.join("\n\n");
  const shortLabel = `[pinned skill ${plugin}:${skill}]`;
  if (shortLabel.length + 1 + content.length <= PART_LIMIT) {
    return [`${shortLabel}\n${content}`];
  }
  let reservation = 99;
  let chunks = [];
  for (;;) {
    const reservedLabel = `[pinned skill ${plugin}:${skill} part ${reservation}/${reservation}]`;
    chunks = packBlocks(blocks, PART_LIMIT - reservedLabel.length - 1);
    const finalLabel = `[pinned skill ${plugin}:${skill} part ${chunks.length}/${chunks.length}]`;
    if (finalLabel.length <= reservedLabel.length) break;
    reservation = chunks.length;
  }
  const total = chunks.length;
  return chunks.map((chunk, index) => `[pinned skill ${plugin}:${skill} part ${index + 1}/${total}]\n${chunk}`);
}

export function parts(pluginRoot) {
  const plugin = pluginName(pluginRoot);
  const result = [];
  for (const entry of pinnedSkills(pluginRoot)) {
    result.push(...skillParts(plugin, entry.skill, entry.body));
  }
  return result;
}

function injectorRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function stdinPayload() {
  if (process.stdin.isTTY) return {};
  const raw = fs.readFileSync(0, "utf8");
  if (raw.trim() === "") return {};
  const value = JSON.parse(raw);
  return value !== null && typeof value === "object" ? value : {};
}

export function run(index, registered) {
  try {
    const payload = stdinPayload();
    if (Object.hasOwn(payload, "hook_event_name") && payload.hook_event_name !== "SessionStart") return;
    const list = parts(injectorRoot());
    if (!Number.isInteger(index) || index < 0 || index >= list.length) return;
    let text = list[index];
    if (index === registered - 1 && list.length > registered) {
      text += `\n[pinned skill] ${list.length - registered} part(s) not registered; run \`vs pin\` in the marketplace repo.`;
    }
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: text },
    }));
  } catch {}
}
