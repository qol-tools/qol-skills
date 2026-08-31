const test = require("node:test");
const assert = require("node:assert");
const { readFileSync, mkdtempSync, mkdirSync } = require("node:fs");
const { join } = require("node:path");
const { tmpdir } = require("node:os");

const SRC = readFileSync(join(__dirname, "..", "bin", "qolmem-gen.cjs"), "utf8");

function loadRepoRoots() {
  const body = SRC.match(/function repoRoots[\s\S]*?\n}/);
  assert.ok(body, "qolmem-gen must define repoRoots");
  const { readdirSync, existsSync } = require("node:fs");
  const { join: j, dirname } = require("node:path");
  const { homedir } = require("node:os");
  const make = new Function(
    "readdirSync", "existsSync", "join", "dirname", "homedir",
    `${body[0]}; return repoRoots;`
  );
  return make(readdirSync, existsSync, j, dirname, homedir);
}

test("repoRoots offers the parent of the current repo when it holds checkouts", () => {
  const root = mkdtempSync(join(tmpdir(), "qolmem-roots-"));
  mkdirSync(join(root, "here", ".git"), { recursive: true });
  mkdirSync(join(root, "sibling", ".git"), { recursive: true });
  const roots = loadRepoRoots()(join(root, "here"));
  assert.ok(roots.includes(root), "the sibling-holding parent must be searchable");
});

test("repoRoots falls back to the cwd when no parent holds a checkout", () => {
  const root = mkdtempSync(join(tmpdir(), "qolmem-noroots-"));
  const here = join(root, "here");
  mkdirSync(here, { recursive: true });
  const roots = loadRepoRoots()(here);
  assert.deepEqual(roots, [here]);
});

test("the brief sends the answerer to the tool before the docs", () => {
  assert.match(SRC, /--help/, "the brief must ask for the tool's own help output");
  assert.match(SRC, /the tool wins/, "the brief must resolve tool-versus-docs conflicts");
  assert.match(
    SRC,
    /only unanswerable after you have searched every repo root/,
    "one repo coming up empty must not end the search"
  );
});
