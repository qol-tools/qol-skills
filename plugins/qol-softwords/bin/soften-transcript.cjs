#!/usr/bin/env node
'use strict';

const { readFileSync } = require("node:fs");
const { softenFile } = require("./soften-history.cjs");

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const file = typeof payload?.transcript_path === "string" ? payload.transcript_path : "";
  if (!file) return;
  try {
    softenFile(file, true);
  } catch {}
}

main();
