import path from "node:path";
import { requireQac } from "./gate.mjs";
import {
  EXIT,
  LoopError,
  assertKey,
  commonDir,
  listAttempts,
  loopDir,
  mainClone,
  readJson,
  readLoop,
  withDefaults,
  writeJson,
} from "./paths.mjs";

const BLAMES = Object.freeze(["spec", "impl", "judge"]);

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

const C_ESCAPES = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

function isOctal(char) {
  return typeof char === "string" && char >= "0" && char <= "7";
}

function decodeQuoted(value) {
  const chars = Array.from(value.length > 1 && value.endsWith('"') ? value.slice(1, -1) : value.slice(1));
  const bytes = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== "\\") {
      bytes.push(...Buffer.from(chars[i]));
    } else if (isOctal(chars[i + 1])) {
      let digits = "";
      while (digits.length < 3 && isOctal(chars[i + 1])) digits += chars[++i];
      bytes.push(parseInt(digits, 8) & 255);
    } else if (Object.hasOwn(C_ESCAPES, chars[i + 1])) {
      bytes.push(C_ESCAPES[chars[++i]]);
    } else {
      bytes.push(92);
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

function diffPath(raw) {
  const value = raw.split("\t")[0].trim();
  if (value === "/dev/null") return null;
  return (value.startsWith('"') ? decodeQuoted(value) : value).replace(/^[ab]\//, "");
}

export function diffHunks(patch) {
  const hunks = [];
  let oldFile = null;
  let newFile = null;
  let remainingOld = 0;
  let remainingNew = 0;
  for (const line of String(patch ?? "").split(/\r?\n/)) {
    if (remainingOld > 0 || remainingNew > 0) {
      if (line.startsWith("+")) remainingNew -= 1;
      else if (line.startsWith("-")) remainingOld -= 1;
      else if (line.startsWith("\\")) continue;
      else {
        remainingOld -= 1;
        remainingNew -= 1;
      }
      continue;
    }
    if (line.startsWith("--- ")) {
      oldFile = diffPath(line.slice(4));
      continue;
    }
    if (line.startsWith("+++ ")) {
      newFile = diffPath(line.slice(4));
      continue;
    }
    const match = HUNK_HEADER.exec(line);
    if (!match) continue;
    const hunk = {
      oldFile,
      newFile,
      oldStart: Number(match[1]),
      oldLines: match[2] === undefined ? 1 : Number(match[2]),
      newStart: Number(match[3]),
      newLines: match[4] === undefined ? 1 : Number(match[4]),
    };
    hunks.push(hunk);
    remainingOld = hunk.oldLines;
    remainingNew = hunk.newLines;
  }
  return hunks;
}

export function parseHunkRef(ref) {
  const match = /^(.+):(\d+)$/.exec(String(ref ?? "").trim());
  return match ? { file: match[1], line: Number(match[2]) } : null;
}

export function hunkContains(hunks, file, line) {
  return hunks.some((hunk) => {
    const inNew = hunk.newFile === file && line >= hunk.newStart && line <= hunk.newStart + Math.max(hunk.newLines, 1) - 1;
    const inOld = hunk.oldFile === file && line >= hunk.oldStart && line <= hunk.oldStart + Math.max(hunk.oldLines, 1) - 1;
    return inNew || inOld;
  });
}

function findFinding(gate, id) {
  const finding = (gate?.findings ?? []).find((entry) => entry.id === id);
  if (finding) return { kind: "finding", entry: finding };
  const tamper = (gate?.tamper ?? []).find((entry) => entry.id === id);
  return tamper ? { kind: "tamper", entry: tamper } : null;
}

export function validateVerdict(input, context = {}) {
  const errors = [];
  if (!input || typeof input !== "object") return { ok: false, errors: ["verdict must be an object"] };
  if (!BLAMES.includes(input.blame)) errors.push(`blame must be one of ${BLAMES.join(", ")}`);
  if (typeof input.why !== "string" || input.why.trim() === "") errors.push("why is required");
  if (typeof input.finding !== "string" || input.finding.trim() === "") {
    errors.push("finding is required");
  } else if (!findFinding(context.gate, input.finding)) {
    errors.push(`finding ${input.finding} is not in the gate.json findings or tamper of that attempt`);
  }
  const ref = parseHunkRef(input.hunk);
  if (!ref) {
    errors.push("hunk must be PATH:LINE");
  } else if (typeof context.diff !== "string" || context.diff.trim() === "") {
    errors.push("that attempt has no diff.patch content to cite");
  } else if (!hunkContains(diffHunks(context.diff), ref.file, ref.line)) {
    errors.push(`hunk ${input.hunk} does not fall inside any hunk of diff.patch`);
  }
  return { ok: errors.length === 0, errors };
}

function slotIndex(key, loop, index) {
  const wanted = index === undefined || index === null ? null : Number(index);
  if (loop.implementers === 2) {
    if (wanted !== 1 && wanted !== 2) throw new LoopError(`loop ${key} has 2 implementers: pass --index 1 or --index 2 so the verdict lands on the right attempt`);
    return wanted;
  }
  if (wanted !== null && wanted !== 1) throw new LoopError(`loop ${key} has one implementer: --index must be 1 or omitted`);
  return null;
}

function locateAttempt(dir, findingId, index, d) {
  const attempts = listAttempts(dir, d).filter((attempt) => index === null || attempt.index === index).reverse();
  for (const attempt of attempts) {
    const gate = readJson(path.join(attempt.dir, "gate.json"), d);
    if (gate && findFinding(gate, findingId)) return { attempt, gate };
  }
  return null;
}

function readDiff(file, d) {
  try {
    return d.read(file);
  } catch {
    return "";
  }
}

function recordSlip(key, found, repoRoot, d) {
  const qac = requireQac(d);
  const entry = found.entry;
  const args = [
    ...qac.argv,
    "slip",
    "--fingerprint",
    entry.fingerprint,
    "--from",
    `verdict:${key}`,
    "--route",
    "judge-revert",
    "--loop",
    key,
    "--cwd",
    repoRoot,
  ];
  if (entry.judge) args.push("--judge", String(entry.judge));
  if (entry.rule) args.push("--rule", String(entry.rule));
  if (entry.message) args.push("--message", String(entry.message));
  const result = d.exec(args, { cwd: repoRoot });
  return { exit: result.status, error: result.status === 0 ? null : String(result.stderr ?? "").trim() || `qac slip exited ${result.status}` };
}

const NEXT = {
  spec: (key) => `the loop is done: fix the spec and open ${key}-v2`,
  impl: (key) => `qols loop run ${key}`,
  judge: (key) => `qols loop run ${key} --gate-only`,
};

export function recordVerdict(key, input, options = {}, deps) {
  const d = withDefaults(deps);
  assertKey(key);
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const common = commonDir(cwd, d);
  const dir = loopDir(common, key);
  const loop = readLoop(dir, d);
  if (!loop) throw new LoopError(`no open loop ${key} under ${dir}`);
  if (!BLAMES.includes(input?.blame)) throw new LoopError(`blame must be one of ${BLAMES.join(", ")}`);
  const index = slotIndex(key, loop, options.index);
  const location = typeof input.finding === "string" ? locateAttempt(dir, input.finding, index, d) : null;
  const gate = location?.gate ?? null;
  const diff = location ? readDiff(path.join(location.attempt.dir, "diff.patch"), d) : "";
  const check = validateVerdict(input, { gate, diff });
  if (!check.ok) throw new LoopError(`verdict rejected: ${check.errors.join("; ")}`);
  const found = findFinding(gate, input.finding);
  if (input.blame === "judge" && !found.entry.fingerprint) {
    throw new LoopError(`verdict rejected: ${input.finding} has no fingerprint, so it cannot be blamed on a judge`);
  }
  if (input.blame === "judge" && !found.entry.file) {
    throw new LoopError(`verdict rejected: ${input.finding} names no file, so the re-gate cannot exclude exactly that finding`);
  }
  const record = {
    schema: 1,
    key,
    blame: input.blame,
    finding: input.finding,
    fingerprint: found.entry.fingerprint ?? null,
    file: found.entry.file ?? null,
    hunk: input.hunk,
    why: input.why,
    attempt: location.attempt.n,
    index: location.attempt.index,
    recorded_at: d.now().toISOString(),
  };
  const file = writeJson(path.join(location.attempt.dir, "verdict.json"), record, d);
  const result = { exit: EXIT.ok, verdict_recorded: true, key, verdict: record, verdict_file: file, next: NEXT[input.blame](key) };
  if (input.blame === "judge") {
    result.slip = recordSlip(key, found, loop.repo_root ?? mainClone(common), d);
    if (result.slip.error) result.exit = EXIT.infra;
  }
  return result;
}
