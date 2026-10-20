'use strict';

const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const { agentHome } = require('./agent-home.cjs');
const { baseUrl, postJson } = require('./qol-tray-http.cjs');

const SERVER_NAME = 'qol';
const PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];
const LATEST_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_LIST_TIMEOUT_MS = 2000;
const DEFAULT_CALL_TIMEOUT_MS = 12000;
const DEFAULT_CALL_WAIT_MS = 12000;
const RETRY_INTERVAL_MS = 250;
const AGENT_HOME_TIMEOUT_MS = 800;

const FALLBACK_TOOLS = [
  {
    name: "qol-memory__ask",
    description: "Retrieve settled facts from the user's agent session history. Ask in plain words; the answer names the matching prior sessions and skills. If verification.status is pending, related memories are available immediately; repeat the same query after a short delay to retrieve the checked answer.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "question in plain words" },
        cwd: { type: "string", description: "optional working directory for scoping" },
        exclude_session: { type: "string", description: "optional session id to exclude" }
      },
      required: ["query", "cwd", "exclude_session"]
    }
  },
  {
    name: "qol-memory__status",
    description: "Report the qol-memory store size, index freshness and pending distillation candidates.",
    inputSchema: { type: "object", properties: {}, required: [] }
  },
  {
    name: "qol-memory__capture",
    description: "Remember one settled fact for future sessions. Write one self-contained sentence carrying the identifiers a later reader needs (paths, commits, names, dates). It is stored verbatim, scoped to cwd, and comes back through qol-memory__ask and the session-start continue block. Calling it twice with the same text and cwd stores one fact, and brings it back if it was forgotten or replaced. The reply gives the fact's key and up to 3 stored facts close to it with their keys; when one of them is now wrong, pass its key to qol-memory__supersede instead of leaving both.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "the fact as one self-contained sentence" },
        cwd: { type: "string", description: "absolute working directory of the project the fact belongs to" }
      },
      required: ["text", "cwd"]
    }
  },
  {
    name: "qol-memory__supersede",
    description: "Replace stale facts with one new fact; the latest statement wins. Pass the stale facts' keys as qol-memory__ask or the capture reply shows them, each in full or its first 8 or more characters, and the new fact as one self-contained sentence with its cwd, stored the way qol-memory__capture stores it. A statement repeated in several sessions is one fact: naming one copy covers every copy you can see, and the reply lists their keys. A question the new fact also answers drops the old facts and lists them as replaced; a question only an old fact answers still gets it, marked superseded, with the new fact beside it. Nothing is deleted. An unknown key, an ambiguous prefix or a fact you cannot see changes nothing, and the error names the key. For a wrong fact with nothing to replace it, use qol-memory__forget.",
    inputSchema: {
      type: "object",
      properties: {
        keys: { type: "string", description: "keys of the stale facts, separated by spaces or commas" },
        text: { type: "string", description: "the new fact as one self-contained sentence" },
        cwd: { type: "string", description: "absolute working directory of the project the new fact belongs to" }
      },
      required: ["keys", "text", "cwd"]
    }
  },
  {
    name: "qol-memory__forget",
    description: "Keep facts out of qol-memory__ask answers, launcher rows and the session-start continue block. Pass the keys as qol-memory__ask or the capture reply shows them, each in full or its first 8 or more characters, and a reason of at most 500 characters. A statement repeated in several sessions is one fact: naming one copy covers every copy you can see, and the reply lists their keys. Nothing is deleted: capturing the same text in the same cwd brings a forgotten capture back, while a forgotten transcript statement or note stays forgotten. The facts a forgotten replacement replaced stay superseded, so qol-memory__ask can still return them marked superseded; forget them too when they are wrong. An unknown key, an ambiguous prefix or a fact you cannot see changes nothing, and the error names the key. When a newer fact replaces the old one, use qol-memory__supersede so questions get the new fact.",
    inputSchema: {
      type: "object",
      properties: {
        keys: { type: "string", description: "keys of the facts to forget, separated by spaces or commas" },
        reason: { type: "string", description: "why the facts are wrong or no longer useful" }
      },
      required: ["keys", "reason"]
    }
  }
];

function envMs(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function serverVersion() {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '.claude-plugin', 'plugin.json'), 'utf8'));
    return typeof manifest.version === 'string' && manifest.version ? manifest.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const version = serverVersion();
let homePromise = null;

function callerHeaders() {
  if (!homePromise) homePromise = agentHome('claude', AGENT_HOME_TIMEOUT_MS);
  return homePromise.then((home) => (home ? { 'x-qol-agent-home': home } : {}));
}

function write(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function resultResponse(id, value) {
  return { jsonrpc: '2.0', id, result: value };
}

function errorResponse(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function httpFailure(response) {
  const detail = response.body && response.body.error && response.body.error.message
    ? `: ${response.body.error.message}`
    : '';
  const failure = new Error(`qol-tray answered HTTP ${response.status}${detail}`);
  failure.status = response.status;
  return failure;
}

function describe(failure) {
  return failure && failure.message ? failure.message : String(failure);
}

async function call(message, timeoutMs) {
  const headers = await callerHeaders();
  const response = await postJson('/api/mcp', message, timeoutMs, headers);
  if (response.status === 200 && response.body) return response.body;
  if (response.status === 202) return null;
  throw httpFailure(response);
}

async function toolsList(message) {
  try {
    const body = await call(message, envMs('QOL_MEMORY_MCP_LIST_TIMEOUT_MS', DEFAULT_LIST_TIMEOUT_MS));
    if (body && body.result && Array.isArray(body.result.tools)) {
      write(body);
      return;
    }
    throw new Error('qol-tray returned no tool list');
  } catch (failure) {
    process.stderr.write(`qol-memory-mcp: serving the built-in tool list (${describe(failure)})\n`);
    write(resultResponse(message.id, { tools: FALLBACK_TOOLS }));
  }
}

async function toolsCall(message) {
  const timeoutMs = envMs('QOL_MEMORY_MCP_CALL_TIMEOUT_MS', DEFAULT_CALL_TIMEOUT_MS);
  const deadline = Date.now() + envMs('QOL_MEMORY_MCP_CALL_WAIT_MS', DEFAULT_CALL_WAIT_MS);
  let failure = null;
  for (;;) {
    try {
      const body = await call(message, timeoutMs);
      if (body) write(body);
      return;
    } catch (thrown) {
      failure = thrown;
      if (thrown.status !== undefined && thrown.status < 500) break;
      if (Date.now() >= deadline) break;
      await delay(RETRY_INTERVAL_MS);
    }
  }
  const name = message.params && typeof message.params.name === 'string' ? message.params.name : 'tool';
  write(resultResponse(message.id, {
    content: [{
      type: 'text',
      text: `qol-memory could not reach qol-tray at ${baseUrl()} for ${name} (${describe(failure)}). Start qol-tray, then retry.`,
    }],
    isError: true,
  }));
}

async function handle(message) {
  if (message === null || typeof message !== 'object' || Array.isArray(message)) {
    write(errorResponse(null, -32600, 'expected a single JSON-RPC request object'));
    return;
  }
  const method = typeof message.method === 'string' ? message.method : null;
  const hasId = Object.prototype.hasOwnProperty.call(message, 'id');
  const id = hasId ? message.id : null;
  if (!method) {
    if (Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error')) return;
    if (hasId) write(errorResponse(id, -32600, 'missing method'));
    return;
  }
  if (!hasId) return;
  if (method === 'initialize') {
    const requested = message.params && typeof message.params.protocolVersion === 'string' ? message.params.protocolVersion : '';
    const protocolVersion = PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
    write(resultResponse(id, {
      protocolVersion,
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version },
    }));
    return;
  }
  if (method === 'ping') {
    write(resultResponse(id, {}));
    return;
  }
  if (method === 'tools/list') {
    await toolsList(message);
    return;
  }
  if (method === 'tools/call') {
    await toolsCall(message);
    return;
  }
  try {
    const body = await call(message, envMs('QOL_MEMORY_MCP_LIST_TIMEOUT_MS', DEFAULT_LIST_TIMEOUT_MS));
    if (body) write(body);
  } catch (failure) {
    write(errorResponse(id, -32000, describe(failure)));
  }
}

function main() {
  process.stdout.on('error', () => process.exit(0));
  const lines = readline.createInterface({ input: process.stdin });
  let queue = Promise.resolve();
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write(errorResponse(null, -32700, 'Parse error'));
      return;
    }
    queue = queue.then(() => handle(message)).catch((failure) => {
      process.stderr.write(`qol-memory-mcp: ${failure && failure.stack ? failure.stack : failure}\n`);
    });
  });
  lines.on('close', () => {
    queue.then(() => process.exit(0));
  });
}

main();
