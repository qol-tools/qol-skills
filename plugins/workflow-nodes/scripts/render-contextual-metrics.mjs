#!/usr/bin/env node

import fs from "node:fs";

const COLUMNS = [
  ["improvement_vector", "Improvement Vector"],
  ["scenario", "Scenario"],
  ["context", "Context"],
  ["metric", "Metric"],
  ["before", "Before"],
  ["after", "After"],
  ["delta", "Delta"],
  ["correctness", "Correctness"],
  ["evidence", "Evidence"],
];

const EXAMPLE = {
  metrics: [
    {
      improvement_vector: "launcher search latency",
      scenario: "App query via popup",
      context: "macOS; GPUI popup; socket open; 50 release runs",
      metric: "median filter time",
      before: "1.391 ms",
      after: "1.128 ms",
      delta: "-18.9%",
      correctness: "live smoke passed; result count unchanged",
      evidence: "docs/search-performance.md row 4",
    },
  ],
};

function usage() {
  return [
    "Usage: render-contextual-metrics.mjs [--compact|--full] <metrics.json|->",
    "       render-contextual-metrics.mjs --example",
    "",
    "Default: --full. Use --compact for final responses.",
    "",
    "Input JSON shape:",
    JSON.stringify(EXAMPLE, null, 2),
  ].join("\n");
}

function readInput(arg) {
  if (!arg) {
    throw usageError("missing input path");
  }
  if (arg === "-") {
    return fs.readFileSync(0, "utf8");
  }
  return fs.readFileSync(arg, "utf8");
}

function usageError(message) {
  const error = new Error(`${message}\n\n${usage()}`);
  error.exitCode = 2;
  return error;
}

function validationError(message) {
  const error = new Error(message);
  error.exitCode = 3;
  return error;
}

function metricsFromJson(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch (error) {
    throw validationError(`invalid JSON: ${error.message}`);
  }

  const metrics = Array.isArray(parsed) ? parsed : parsed?.metrics;
  if (!Array.isArray(metrics)) {
    throw validationError("input must be an array or an object with a metrics array");
  }
  if (metrics.length === 0) {
    throw validationError("metrics array must contain at least one row");
  }
  return metrics.map(normalizeRow);
}

function normalizeRow(row, index) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    throw validationError(`metrics[${index}] must be an object`);
  }

  const normalized = {};
  for (const [key, label] of COLUMNS) {
    if (!(key in row)) {
      throw validationError(`metrics[${index}] missing required field: ${key}`);
    }
    normalized[label] = stringifyCell(row[key]);
  }
  return normalized;
}

function stringifyCell(value) {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  return JSON.stringify(value);
}

function escapeMarkdownCell(value) {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("|", "\\|")
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\n", "<br>");
}

function renderTable(metrics) {
  const headers = COLUMNS.map(([, label]) => label);
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
  ];

  for (const row of metrics) {
    lines.push(`| ${headers.map((header) => escapeMarkdownCell(row[header])).join(" | ")} |`);
  }

  return `${lines.join("\n")}\n`;
}

function renderCompactTables(metrics) {
  const groups = groupMetrics(metrics);
  const lines = [];

  for (const [groupIndex, group] of groups.entries()) {
    if (groupIndex > 0) {
      lines.push("");
    }
    lines.push(`**${group.improvementVector}**`);
    if (group.context) {
      lines.push(`Context: ${group.context}`);
    }
    if (group.evidence) {
      lines.push(`Evidence: ${group.evidence}`);
    }
    lines.push("");
    lines.push("| Scenario | Metric | Before | After | Delta | Correctness |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const row of group.rows) {
      lines.push(
        `| ${[
          row.Scenario,
          row.Metric,
          row.Before,
          row.After,
          row.Delta,
          row.Correctness,
        ]
          .map(escapeMarkdownCell)
          .join(" | ")} |`,
      );
    }
  }

  return `${lines.join("\n")}\n`;
}

function groupMetrics(metrics) {
  const groups = [];
  const byKey = new Map();

  for (const row of metrics) {
    const key = JSON.stringify([row["Improvement Vector"], row.Context, row.Evidence]);
    let group = byKey.get(key);
    if (!group) {
      group = {
        improvementVector: row["Improvement Vector"],
        context: row.Context,
        evidence: row.Evidence,
        rows: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.rows.push(row);
  }

  return groups;
}

function parseArgs(argv) {
  let mode = "full";
  let input = null;
  let example = false;

  for (const arg of argv) {
    if (arg === "--compact") {
      mode = "compact";
      continue;
    }
    if (arg === "--full") {
      mode = "full";
      continue;
    }
    if (arg === "--example") {
      example = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { help: true };
    }
    if (input) {
      throw usageError("too many input paths");
    }
    input = arg;
  }

  if (example && input) {
    throw usageError("--example does not accept an input path");
  }

  return { mode, input, example, help: false };
}

function main(argv) {
  const args = parseArgs(argv);
  if (args.example) {
    process.stdout.write(`${JSON.stringify(EXAMPLE, null, 2)}\n`);
    return;
  }
  if (args.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  const metrics = metricsFromJson(readInput(args.input));
  const output = args.mode === "compact" ? renderCompactTables(metrics) : renderTable(metrics);
  process.stdout.write(output);
}

try {
  main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exit(error.exitCode ?? 1);
}
