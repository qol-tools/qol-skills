const fs = require("node:fs");
const path = require("node:path");

const INVENTORY_NOUNS = [
  "actions?",
  "backends?",
  "commands?",
  "crates?",
  "features?",
  "fields?",
  "files?",
  "implementations?",
  "ipc paths?",
  "items?",
  "migrations?",
  "modules?",
  "pages?",
  "plugins?",
  "queries?",
  "routes?",
  "scopes?",
  "sections?",
  "skills?",
  "surfaces?",
  "tests?",
  "traits?",
  "v\\d+ action ids?",
];
const COUNT_WORDS = [
  "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
  "eighteen", "nineteen", "twenty",
];
const RULES = [
  {
    id: "temporal-state",
    message: "Replace time-bound state wording with a source-owned fact or an explicit condition.",
    pattern: /\b(?:as of|at present|current pattern|currently(?!\s+(?:doing|focused|running|selected|showing|visible)\b)|for now|presently|today)\b/i,
  },
  {
    id: "status-snapshot",
    message: "Replace status or roadmap prose with a condition, trigger, or source-of-truth reference.",
    pattern: /^\s*(?:[-*]\s+)?(?:\*\*)?status(?:\*\*)?\s*:|\b(?:not yet (?:implemented|present|started|supported)|once [^.]+ lands|until [^.]+ lands)/i,
  },
  {
    id: "dated-verification",
    message: "Keep verification executable or source-owned instead of recording a dated result.",
    pattern: /\b(?:checked|tested|validated|verified)\b[^\n]{0,120}\b(?:19|20)\d\d-\d\d-\d\d\b/i,
  },
  {
    id: "fixed-inventory",
    message: "Discover maintained inventories from their owning path or registry instead of freezing a count.",
    pattern: new RegExp(
      `(?:\\b(?:all|own|the|there (?:are|is)|these|those)\\s+(?:\\d+|${COUNT_WORDS.join("|")})\\s+(?:${INVENTORY_NOUNS.join("|")})\\b|\\b(?:\\d+|${COUNT_WORDS.join("|")})\\s+(?:${INVENTORY_NOUNS.join("|")})\\s+(?:are|exist|live|remain|ship|together)\\b)`,
      "i",
    ),
  },
  {
    id: "mutable-version",
    message: "Read mutable component versions from their manifest, lockfile, or runtime contract.",
    pattern: /\b(?:GPUI|PointZ|Python|qol-config|qol-tray|tungstenite)\s+v?\d+\.\d+(?:\.\d+)?\+?\b/i,
  },
  {
    id: "snapshot-section",
    message: "Replace current-state, roadmap, or issue-inventory sections with source-owned conditions and invariants.",
    pattern: /^\s*#{1,6}\s+(?:backend status|current gaps|current state|folder layout\s*\(current\)|known issues|recent changes|roadmap|what works)\b/i,
  },
  {
    id: "manifest-snapshot",
    message: "Treat the plugin manifest as the source of truth instead of copying its mutable fields into prose.",
    pattern: /^\s*[-*]\s+(?:binary name|daemon|menu|platforms?|runtime actions? map|runtime command)\s*:/i,
  },
  {
    id: "escaped-quoted-description",
    message: "Write the frontmatter description as an unquoted YAML scalar; a double-quoted scalar with escaped quotes double-escapes through the manifest sync.",
    pattern: /^description:\s*".*\\"/,
  },
];

// Plugin manifests own plugin identity; a source directory name does not.
// Naming a foreign `plugins/<dir>/` path freezes a rename into prose, so point
// at the declared `[plugin].id` (or the `plugins/*` glob) instead. Directories
// that exist in this repo are its own layout and stay addressable by path.
// A code span or link target that *is* a plugin path, e.g. `plugins/lights/src`.
const PLUGIN_DIR_SPAN = /^plugins\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:\/|$)/;
// Bare prose needs the trailing slash to read as a path rather than an
// "and" shorthand such as "Rust plugins/libs".
const PLUGIN_DIR_PROSE = /(?:^|[^\w/])plugins\/([A-Za-z0-9][A-Za-z0-9._-]*)\//g;
const FOREIGN_PLUGIN_DIR_RULE = {
  id: "plugin-directory-path",
  message: "Identify a plugin by its declared manifest id or the plugins/* glob; source directory names carry no identity.",
};

function parseArgs(argv) {
  const options = {
    root: path.resolve(__dirname, ".."),
    report: null,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--check") {
      continue;
    }

    if (arg === "--root" || arg === "--report") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error(`${arg} requires a path`);
      }
      options[arg.slice(2)] = path.resolve(value);
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function skillFiles(root) {
  const pluginsDir = path.join(root, "plugins");
  const files = [];

  if (!fs.existsSync(pluginsDir)) {
    return files;
  }

  for (const plugin of fs.readdirSync(pluginsDir, { withFileTypes: true })) {
    if (!plugin.isDirectory()) {
      continue;
    }

    const skillsDir = path.join(pluginsDir, plugin.name, "skills");
    if (!fs.existsSync(skillsDir)) {
      continue;
    }

    for (const skill of fs.readdirSync(skillsDir, { withFileTypes: true })) {
      if (!skill.isDirectory()) {
        continue;
      }

      const file = path.join(skillsDir, skill.name, "SKILL.md");
      if (fs.existsSync(file)) {
        files.push(file);
      }
    }
  }

  return files.sort();
}

function proseLines(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let fence = null;

  return lines.map((line, index) => {
    const fenceMatch = line.match(/^\s*(```+|~~~+)/);

    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      fence = fence === marker ? null : fence ?? marker;
      return null;
    }

    if (fence !== null) {
      return null;
    }

    return {
      line: index + 1,
      original: line.trim(),
      searchable: line
        .replace(/`[^`]*`/g, " ")
        .replace(/https?:\/\/\S+/g, " ")
        .replace(/\[[^\]]*\]\([^)]*\)/g, " "),
      // Paths are usually written as code spans or link targets, which the
      // prose `searchable` form deliberately strips.
      paths: [
        ...[...line.matchAll(/`([^`]*)`/g)].map((match) => match[1]),
        ...[...line.matchAll(/\[[^\]]*\]\(([^)]*)\)/g)].map((match) => match[1]),
      ],
    };
  }).filter(Boolean);
}

function localPluginDirs(root) {
  const pluginsDir = path.join(root, "plugins");

  if (!fs.existsSync(pluginsDir)) {
    return new Set();
  }

  return new Set(
    fs.readdirSync(pluginsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name),
  );
}

function scanText(text, localDirs = new Set()) {
  const violations = [];

  for (const entry of proseLines(text)) {
    for (const rule of RULES) {
      if (rule.pattern.test(entry.searchable)) {
        violations.push({
          rule: rule.id,
          line: entry.line,
          excerpt: entry.original,
          message: rule.message,
        });
      }
    }

    const referenced = [
      ...entry.paths.map((span) => span.match(PLUGIN_DIR_SPAN)?.[1]),
      ...[...entry.searchable.matchAll(PLUGIN_DIR_PROSE)].map((match) => match[1]),
    ].filter((name) => name && !localDirs.has(name));

    if (referenced.length > 0) {
      violations.push({
        rule: FOREIGN_PLUGIN_DIR_RULE.id,
        line: entry.line,
        excerpt: entry.original,
        message: FOREIGN_PLUGIN_DIR_RULE.message,
      });
    }
  }

  return violations;
}

function relative(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function audit(root) {
  const files = skillFiles(root);
  const localDirs = localPluginDirs(root);
  const violations = files.flatMap((file) => scanText(fs.readFileSync(file, "utf8"), localDirs)
    .map((violation) => ({ file: relative(root, file), ...violation })));

  if (files.length === 0) {
    violations.push({
      file: "plugins/",
      rule: "no-skills-found",
      line: 0,
      excerpt: "No maintained SKILL.md files found.",
      message: "Run the audit from the qol-skills root or pass the correct --root path.",
    });
  }

  return {
    schema_version: 1,
    status: violations.length === 0 ? "ok" : "violations",
    skill_count: files.length,
    violation_count: violations.length,
    violations,
  };
}

function writeReport(file, report) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
}

function main(argv) {
  const options = parseArgs(argv);
  const report = audit(options.root);

  if (options.report) {
    writeReport(options.report, report);
  }

  if (report.violation_count === 0) {
    console.log(`Skill invariance audit passed: ${report.skill_count} skills checked.`);
    return 0;
  }

  for (const violation of report.violations) {
    console.error(`${violation.file}:${violation.line} [${violation.rule}] ${violation.excerpt}`);
  }
  console.error(`Skill invariance audit failed: ${report.violation_count} violations in ${report.skill_count} skills.`);
  return 1;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = {
  audit,
  parseArgs,
  proseLines,
  scanText,
  skillFiles,
  writeReport,
};
