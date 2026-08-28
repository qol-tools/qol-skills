'use strict';

const fs = require('node:fs');
const { postJson } = require('./qol-tray-http.cjs');

function parseInput(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (
      parsed
      && typeof parsed.cwd === 'string'
      && parsed.cwd
      && typeof parsed.session_id === 'string'
      && parsed.session_id
    ) {
      return { cwd: parsed.cwd, session_id: parsed.session_id };
    }
  } catch {}
  return null;
}

async function run() {
  let raw = '';
  try {
    raw = fs.readFileSync(0, 'utf8');
  } catch {
    return;
  }
  const input = parseInput(raw);
  if (!input) return;
  if (process.env.QOL_MEMORY_CONTINUE_DISABLE === '1') return;
  let result;
  try {
    result = await postJson(
      '/api/plugins/qol-memory/queries/continue',
      { cwd: input.cwd, session: input.session_id },
      1500,
    );
  } catch {
    return;
  }
  if (
    result
    && typeof result.status === 'number'
    && result.status >= 200
    && result.status < 300
    && result.body
    && result.body.stage === 'injected'
    && typeof result.body.block === 'string'
    && result.body.block
  ) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: result.body.block,
      },
    }) + '\n');
  }
}

run().catch(() => {});
