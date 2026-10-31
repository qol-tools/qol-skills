import { createHash } from "node:crypto";

const QUOTED = /"[^"\n]*"|(?<!\w)'[^'\n]*'(?!\w)|`[^`\n]*`/g;
const PATH_TOKEN = /\S*[/\\]\S*/g;
const DIGITS = /\d+/g;
const WHITESPACE = /\s+/g;
const FINGERPRINT_LENGTH = 16;

export function normalizeMessage(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(QUOTED, "q")
    .replace(PATH_TOKEN, "p")
    .replace(DIGITS, "#")
    .replace(WHITESPACE, " ")
    .trim();
}

export function fingerprint(judge, rule, message) {
  return createHash("sha256")
    .update(`${judge}\n${rule}\n${normalizeMessage(message)}`)
    .digest("hex")
    .slice(0, FINGERPRINT_LENGTH);
}
