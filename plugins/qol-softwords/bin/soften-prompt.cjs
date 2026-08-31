#!/usr/bin/env node
'use strict';

const { readFileSync } = require("node:fs");
const { soften } = require("./soften-lib.cjs");

function main() {
  let payload;
  try {
    payload = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const prompt = typeof payload?.prompt === "string" ? payload.prompt : "";
  if (!prompt) return;
  const softened = soften(prompt);
  if (softened === prompt) return;
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      updatedPrompt: softened,
    },
  }));
}

main();
