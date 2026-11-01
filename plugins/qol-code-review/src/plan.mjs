import { baseRange, headRange } from "./diff.mjs";
import { HIGH_SIGNALS } from "./classify.mjs";
import { LENS_NAMES, requiredLenses, routedLenses } from "./lenses.mjs";

export const CHUNK_LINES = 400;
export const MAX_CHANGED = 8000;
export const QUICK_LINES = 30;
export const LEVEL_NAMES = ["quick", "standard", "deep", "max"];
export const LEVELS = {
  quick: { passes: 1, lenses: "all", ledger: false, hunt: false, context: false, packed: true, jobs: Infinity, verifiers: 10 },
  standard: { passes: 1, lenses: "core", ledger: false, hunt: false, context: false, packed: false, jobs: 20, verifiers: 30 },
  deep: { passes: 3, lenses: "routed", ledger: true, hunt: false, context: true, packed: false, jobs: 45, verifiers: 60 },
  max: { passes: 5, lenses: "all", ledger: true, hunt: true, context: true, packed: false, jobs: 90, verifiers: 120 },
};

const HIGH = new Set(HIGH_SIGNALS);
const byPath = (left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
const changedOf = (file) => file.added + file.removed;

export function reviewableChanged(files) {
  return files.filter((file) => !file.excluded).reduce((sum, file) => sum + changedOf(file), 0);
}

export function suggestLevel(files) {
  const reviewable = files.filter((file) => !file.excluded);
  const changed = reviewableChanged(files);
  if (reviewable.length === 0) {
    return { level: "quick", trivial: true, reasons: ["only generated, vendored, lockfile or binary files changed"] };
  }
  const high = reviewable.filter((file) => file.tier === "high");
  const plain = (file) => ["docs", "asset"].includes(file.kind) || (file.status === "R" && changedOf(file) === 0 && !file.signals.includes("mode-change"));
  if (high.length === 0 && reviewable.every(plain)) {
    return { level: "quick", trivial: true, reasons: ["only docs, assets or pure renames changed"] };
  }
  if (high.length === 0) {
    if (changed <= QUICK_LINES) return { level: "quick", trivial: false, reasons: [`${changed} changed lines and no high-risk file`] };
    return { level: "standard", trivial: false, reasons: [`no high-risk file across ${changed} changed lines`] };
  }
  const named = high.slice(0, 6).map((file) => `${file.path} (${file.signals.filter((signal) => HIGH.has(signal)).join(", ")})`);
  const reasons = [`high-risk files: ${named.join("; ")}${high.length > 6 ? `; and ${high.length - 6} more` : ""}`];
  const loosened = high.filter((file) => file.signals.includes("security-path") && file.signals.includes("removed-validation"));
  if (loosened.length > 0) reasons.push(`validation removed from security-sensitive code: ${loosened.map((file) => file.path).join(", ")}`);
  const categories = new Set(high.flatMap((file) => file.signals.filter((signal) => HIGH.has(signal))));
  if (categories.size >= 3) reasons.push(`${categories.size} distinct high-risk categories: ${[...categories].sort().join(", ")}`);
  return { level: "deep", trivial: false, reasons };
}

function splitHunk(hunk, size) {
  const pieces = [];
  let piece = null;
  let oldLine = hunk.old_start;
  let newLine = hunk.new_start;
  const mark = (range, line) => {
    if (!range[0]) range[0] = line;
    range[1] = line;
  };
  for (const line of hunk.lines) {
    piece ??= { changed: 0, head: [0, 0], base: [0, 0] };
    if (line.startsWith("+")) {
      mark(piece.head, newLine++);
      piece.changed++;
    } else if (line.startsWith("-")) {
      mark(piece.base, oldLine++);
      piece.changed++;
    } else if (!line.startsWith("\\")) {
      oldLine++;
      newLine++;
    }
    if (piece.changed >= size) {
      pieces.push(piece);
      piece = null;
    }
  }
  if (piece?.changed) pieces.push(piece);
  return pieces.map((item) => ({ changed: item.changed, head: item.head[0] ? item.head : null, base: item.base[0] ? item.base : null }));
}

export function buildChunks(files, size = CHUNK_LINES) {
  const units = [];
  const byName = new Map(files.map((file) => [file.path, file]));
  for (const file of files.filter((item) => !item.excluded).sort(byPath)) {
    if (file.hunks.length === 0) {
      units.push({ path: file.path, hunk: null, changed: 0, partial: false });
      continue;
    }
    file.hunks.forEach((hunk, index) => {
      const changed = hunk.added + hunk.removed;
      if (changed <= size) units.push({ path: file.path, hunk: index, changed, partial: false, head: headRange(hunk), base: baseRange(hunk) });
      else for (const piece of splitHunk(hunk, size)) units.push({ path: file.path, hunk: index, partial: true, ...piece });
    });
  }
  const packed = [];
  let current = null;
  for (const unit of units) {
    if (!current || (current.changed > 0 && current.changed + unit.changed > size)) {
      current = { units: [], changed: 0 };
      packed.push(current);
    }
    current.units.push(unit);
    current.changed += unit.changed;
  }
  return packed.map((chunk, index) => {
    const entries = new Map();
    for (const unit of chunk.units) {
      const entry = entries.get(unit.path) ?? { path: unit.path, changed: 0, units: [] };
      entry.changed += unit.changed;
      entry.units.push(unit);
      entries.set(unit.path, entry);
    }
    const chunkFiles = [...entries.values()].map((entry) => {
      const file = byName.get(entry.path);
      const hunks = [...new Set(entry.units.filter((unit) => unit.hunk !== null).map((unit) => unit.hunk))];
      const whole = entry.units.every((unit) => !unit.partial) && hunks.length === file.hunks.length;
      return {
        path: entry.path,
        changed: entry.changed,
        hunks,
        focus: whole ? "all" : entry.units.map((unit) => ({ head: unit.head ?? null, base: unit.base ?? null })),
      };
    });
    return { id: `c${String(index + 1).padStart(2, "0")}`, changed: chunk.changed, files: chunkFiles };
  });
}

function hash(text) {
  let value = 2166136261;
  for (const char of text) {
    value ^= char.codePointAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function random(seed) {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let mixed = Math.imul(state ^ (state >>> 15), 1 | state);
    mixed = (mixed + Math.imul(mixed ^ (mixed >>> 7), 61 | mixed)) ^ mixed;
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(items, seedText) {
  const next = random(hash(seedText));
  const copy = [...items];
  for (let at = copy.length - 1; at > 0; at--) {
    const pick = Math.floor(next() * (at + 1));
    [copy[at], copy[pick]] = [copy[pick], copy[at]];
  }
  return copy;
}

function fileOrder(chunk, pass, seedText) {
  const paths = chunk.files.map((file) => file.path);
  if (pass > 1) return shuffle(paths, seedText);
  const central = [...chunk.files].sort((left, right) => right.changed - left.changed || byPath(left, right))[0].path;
  return [central, ...paths.filter((path) => path !== central)];
}

function lensesFor(chunk, config, filesByPath) {
  if (config.lenses === "all") return [...LENS_NAMES];
  const signals = chunk.files.flatMap((file) => filesByPath.get(file.path)?.signals ?? []);
  return config.lenses === "core" ? requiredLenses(signals) : routedLenses(signals);
}

function groups(lenses, size) {
  if (size === Infinity) return [lenses];
  const result = [];
  for (let at = 0; at < lenses.length; at += size) result.push(lenses.slice(at, at + size));
  return result;
}

function groupLabel(lenses) {
  return lenses.length === LENS_NAMES.length ? "all" : lenses.join("+");
}

export function buildPlan({ chunks, files, level, solo = false, maxJobs = null, seed = "" }) {
  const config = LEVELS[level];
  const single = solo;
  const filesByPath = new Map(files.map((file) => [file.path, file]));
  const chunkLenses = chunks.map((chunk) => lensesFor(chunk, config, filesByPath));
  const cap = maxJobs ?? (single ? Infinity : config.jobs);
  let passes = single ? 1 : config.passes;
  let size = single || config.packed ? Infinity : 1;
  const reductions = [];
  const count = () => chunkLenses.reduce((sum, lenses) => sum + groups(lenses, size).length, 0) * passes;
  while (count() > cap) {
    if (size === 1) {
      size = 2;
      reductions.push("lenses paired into shared finder jobs");
    } else if (passes > 1) {
      passes--;
      reductions.push(`passes reduced to ${passes}`);
    } else if (size !== Infinity) {
      size = Infinity;
      reductions.push("all lenses of a chunk share one finder job");
    } else break;
  }
  const jobs = [];
  for (let pass = 1; pass <= passes; pass++) {
    chunks.forEach((chunk, index) => {
      for (const lenses of groups(chunkLenses[index], size)) {
        const id = `${chunk.id}-${groupLabel(lenses)}-p${pass}`;
        jobs.push({
          id,
          kind: "finder",
          chunk: chunk.id,
          lenses,
          pass,
          file_order: fileOrder(chunk, pass, `${seed}:${id}`),
          hunk_order: pass % 2 === 0 ? "reverse" : "forward",
        });
      }
    });
  }
  const highFiles = files.filter((file) => !file.excluded && file.tier === "high").map((file) => file.path);
  const ledger = config.ledger ? (highFiles.length > 0 ? { id: "ledger", kind: "ledger", items: highFiles } : null) : null;
  return {
    level,
    solo: single,
    passes,
    lenses: [...new Set(chunkLenses.flat())].sort((left, right) => LENS_NAMES.indexOf(left) - LENS_NAMES.indexOf(right)),
    job_cap: cap,
    over_cap: count() > cap,
    reductions,
    jobs,
    ledger,
    ledger_skipped: config.ledger && !ledger ? "no high-risk file to build a ledger for" : null,
    hunt: config.hunt ? { id: "hunt", kind: "hunt" } : null,
    context: config.context,
    verify: single ? "self" : "agent",
    verifier_cap: config.verifiers,
  };
}
