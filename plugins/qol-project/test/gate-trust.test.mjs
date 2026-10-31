import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { approvalSha, normalizeConfig } from "../src/gate/config.mjs";
import { approveTrust, argvSha, hasPrefix, readTrust, trustFile, trustState } from "../src/gate/trust.mjs";

const REPO = "0123456789abcdef";
const ENV = { XDG_STATE_HOME: "/state" };
const FILE = path.join("/state", "qac", "trust.json");

function config(extra = {}) {
  return normalizeConfig({
    version: 1,
    setup: [["npm", "ci"]],
    accept_prefixes: [["node", "--test"]],
    judges: [
      { id: "qac", builtin: "qac-lint" },
      { id: "fmt", argv: ["cargo", "fmt", "--check"] },
      { id: "clippy", argv: ["cargo", "clippy"], where: "ci" },
    ],
    ...extra,
  });
}

function store(initial = null) {
  const files = new Map(initial === null ? [] : [[FILE, JSON.stringify(initial)]]);
  return {
    files,
    env: ENV,
    now: () => "2026-10-31T00:00:00.000Z",
    read: file => {
      if (!files.has(file)) throw new Error("ENOENT");
      return files.get(file);
    },
    write: (file, text) => files.set(file, text),
  };
}

test("trustFile follows XDG_STATE_HOME, else ~/.local/state", () => {
  assert.equal(trustFile(ENV), FILE);
  assert.equal(trustFile({ HOME: "/home/me" }), path.join("/home/me", ".local", "state", "qac", "trust.json"));
});

test("hasPrefix compares leading elements exactly", () => {
  assert.equal(hasPrefix(["node", "--test", "a.mjs"], ["node", "--test"]), true);
  assert.equal(hasPrefix(["node", "--test"], ["node", "--test"]), true);
  assert.equal(hasPrefix(["node"], ["node", "--test"]), false);
  assert.equal(hasPrefix(["node", "--check"], ["node", "--test"]), false);
  assert.equal(hasPrefix(["node"], []), false);
});

test("nothing is trusted before the first approval, and ci judges and builtins are not listed", () => {
  const state = trustState({ config: config(), repoId: REPO }, store());
  assert.equal(state.trusted, false);
  assert.equal(state.judges_sha, approvalSha(config()));
  assert.deepEqual(state.untrusted, [
    { source: "judges", argv: ["cargo", "fmt", "--check"] },
    { source: "judges", argv: ["npm", "ci"] },
  ]);
});

test("approving makes the same judges and setup trusted", () => {
  const deps = store();
  const approved = approveTrust({ config: config(), repoId: REPO }, deps);
  assert.equal(approved.approved, true);
  assert.equal(approved.path, FILE);
  assert.equal(approved.judges_sha, approvalSha(config()));
  const saved = JSON.parse(deps.files.get(FILE));
  assert.deepEqual(saved[REPO], {
    judges_sha: approvalSha(config()),
    setup_sha: saved[REPO].setup_sha,
    accept: [],
    approved_at: "2026-10-31T00:00:00.000Z",
  });
  assert.deepEqual(trustState({ config: config(), repoId: REPO }, deps), { trusted: true, judges_sha: approvalSha(config()), untrusted: [] });
});

test("changing a judge argv or the setup revokes trust until the next approval", () => {
  const deps = store();
  approveTrust({ config: config(), repoId: REPO }, deps);
  const edited = config({ judges: [{ id: "fmt", argv: ["cargo", "fmt"] }] });
  const judgeChange = trustState({ config: edited, repoId: REPO }, deps);
  assert.equal(judgeChange.trusted, false);
  assert.deepEqual(judgeChange.untrusted, [{ source: "judges", argv: ["cargo", "fmt"] }]);

  const setupChange = trustState({ config: config({ setup: [["npm", "ci"], ["make", "dev"]] }), repoId: REPO }, deps);
  assert.deepEqual(setupChange.untrusted, [
    { source: "judges", argv: ["npm", "ci"] },
    { source: "judges", argv: ["make", "dev"] },
  ]);
});

test("changing accept_prefixes revokes trust and stops prefixed accept commands from running unapproved", () => {
  const deps = store();
  approveTrust({ config: config(), repoId: REPO }, deps);
  const widened = config({ accept_prefixes: [["node", "--test"], ["sh", "-c"]] });
  assert.notEqual(approvalSha(widened), approvalSha(config()));
  const state = trustState({ config: widened, accept: [{ id: "x", argv: ["sh", "-c", "curl evil"] }], repoId: REPO }, deps);
  assert.equal(state.trusted, false);
  assert.deepEqual(state.untrusted, [
    { source: "judges", argv: ["cargo", "fmt", "--check"] },
    { source: "accept", argv: ["sh", "-c", "curl evil"] },
  ]);

  const builtinOnly = config({ judges: [{ id: "qac", builtin: "qac-lint" }], setup: [] });
  approveTrust({ config: builtinOnly, repoId: REPO }, deps);
  const prefixed = { id: "x", argv: ["sh", "-c", "curl evil"] };
  const stale = config({ judges: [{ id: "qac", builtin: "qac-lint" }], setup: [], accept_prefixes: [["sh", "-c"]] });
  assert.deepEqual(trustState({ config: stale, accept: [prefixed], repoId: REPO }, deps).untrusted, [{ source: "accept", argv: ["sh", "-c", "curl evil"] }]);
  approveTrust({ config: stale, repoId: REPO }, deps);
  assert.equal(trustState({ config: stale, accept: [prefixed], repoId: REPO }, deps).trusted, true);
});

test("another repository's approval does not carry over", () => {
  const deps = store();
  approveTrust({ config: config(), repoId: REPO }, deps);
  assert.equal(trustState({ config: config(), repoId: "ffffffffffffffff" }, deps).trusted, false);
  approveTrust({ config: config(), repoId: "ffffffffffffffff" }, deps);
  const saved = JSON.parse(deps.files.get(FILE));
  assert.deepEqual(Object.keys(saved).sort(), [REPO, "ffffffffffffffff"].sort());
});

test("accept commands need approval unless they start with an accept prefix", () => {
  const deps = store();
  approveTrust({ config: config(), repoId: REPO }, deps);
  const prefixed = { id: "unit", argv: ["node", "--test", "a.test.mjs"] };
  const other = { id: "build", argv: ["make", "check"] };
  const state = trustState({ config: config(), accept: [prefixed, other], repoId: REPO }, deps);
  assert.equal(state.trusted, false);
  assert.deepEqual(state.untrusted, [{ source: "accept", argv: ["make", "check"] }]);

  const approved = approveTrust({ config: config(), accept: [prefixed, other], repoId: REPO }, deps);
  assert.deepEqual(approved.accept, [argvSha(["make", "check"])]);
  assert.equal(argvSha(["make", "check"]), createHash("sha256").update('["make","check"]').digest("hex"));
  assert.equal(trustState({ config: config(), accept: [prefixed, other], repoId: REPO }, deps).trusted, true);
  assert.equal(trustState({ config: config(), accept: [{ id: "x", argv: ["make", "other"] }], repoId: REPO }, deps).trusted, false);
});

test("approvals of accept commands accumulate across loops", () => {
  const deps = store();
  approveTrust({ config: config(), accept: [{ id: "a", argv: ["make", "a"] }], repoId: REPO }, deps);
  approveTrust({ config: config(), accept: [{ id: "b", argv: ["make", "b"] }], repoId: REPO }, deps);
  const state = trustState({ config: config(), accept: [{ id: "a", argv: ["make", "a"] }, { id: "b", argv: ["make", "b"] }], repoId: REPO }, deps);
  assert.equal(state.trusted, true);
});

test("a repository with no config trusts only prefixed or approved accept commands", () => {
  const deps = store();
  const state = trustState({ config: null, accept: [{ id: "a", argv: ["make", "a"] }], repoId: REPO }, deps);
  assert.equal(state.judges_sha, null);
  assert.deepEqual(state.untrusted, [{ source: "accept", argv: ["make", "a"] }]);
  assert.equal(trustState({ config: null, repoId: REPO }, deps).trusted, true);
});

test("a damaged or missing trust file reads as empty", () => {
  assert.deepEqual(readTrust(store()), {});
  const damaged = store();
  damaged.files.set(FILE, "{nope");
  assert.deepEqual(readTrust(damaged), {});
  damaged.files.set(FILE, "[1]");
  assert.deepEqual(readTrust(damaged), {});
  assert.equal(trustState({ config: config(), repoId: REPO }, damaged).trusted, false);
});
