'use strict';

const fs = require('node:fs');
const { postJson } = require('./qol-tray-http.cjs');
const { collectReceipts, unansweredQueue } = require('./qolmem-lib.cjs');

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

function emitAdditionalContext(additionalContext, systemMessage) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  };
  if (systemMessage) payload.systemMessage = systemMessage;
  process.stdout.write(JSON.stringify(payload) + '\n');
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
  const receiptText = collectReceipts().map((r) => r.summary).join('\n');
  const queue = unansweredQueue();
  const count = queue.length;
  const countLine = count > 0
    ? `qol-memory: ${count} unanswered launcher questions - type: qolmem gen`
    : '';
  const systemMessage = [
    count > 0 ? `qol-memory: ${count} unanswered launcher questions - answer them with \`qolmem gen\`` : '',
    receiptText,
  ].filter(Boolean).join('\n');
  let result;
  try {
    result = await postJson(
      '/api/plugins/qol-memory/queries/continue',
      { cwd: input.cwd, session: input.session_id },
      1500,
    );
  } catch {
    const context = [countLine, receiptText].filter(Boolean).join('\n');
    if (context) emitAdditionalContext(context, systemMessage);
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
    const context = [
      countLine ? result.body.block + '\n' + countLine : result.body.block,
      receiptText,
    ].filter(Boolean).join('\n');
    emitAdditionalContext(context, systemMessage);
    return;
  }
  const context = [countLine, receiptText].filter(Boolean).join('\n');
  if (context) emitAdditionalContext(context, systemMessage);
}

run().catch(() => {});
