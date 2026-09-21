'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const { tempDir, writeQol } = require('./fixtures.cjs');

const CLIENT = path.join(__dirname, '..', 'bin', 'qol-memory-mcp.cjs');
const MANIFEST = path.join(__dirname, '..', '.claude-plugin', 'plugin.json');

const SKIP_WIN_POSIX_SHIM =
  process.platform === 'win32' && 'fake qol shim uses a POSIX shebang';

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function stop(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function until(check, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() >= deadline) throw new Error('condition was not met before the deadline');
    await delay(25);
  }
}

async function closedPort() {
  const server = http.createServer(() => {});
  const port = await listen(server);
  await stop(server);
  return port;
}

function pathEnv(dir) {
  return { PATH: [dir, path.dirname(process.execPath)].join(path.delimiter) };
}

function respond(res, body, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

function mcpServer(handler) {
  const state = { requests: [], headers: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      let message = null;
      try { message = JSON.parse(raw); } catch {}
      state.requests.push(message);
      state.headers.push(req.headers);
      handler(message, res, state);
    });
  });
  return { server, state };
}

function startClient(env) {
  const child = spawn(process.execPath, [CLIENT], {
    env: { ...process.env, QOL_TRAY_HTTP_TOKEN: 't', ...(env || {}) },
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdin.on('error', () => {});
  const responses = [];
  const waiters = [];
  let stdoutBuffer = '';
  let stderr = '';
  let exitPromise = null;

  function deliver(message) {
    const waiter = waiters.shift();
    if (!waiter) {
      responses.push(message);
      return;
    }
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  }

  child.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk;
    let index = stdoutBuffer.indexOf('\n');
    while (index !== -1) {
      const line = stdoutBuffer.slice(0, index);
      stdoutBuffer = stdoutBuffer.slice(index + 1);
      if (line.trim()) {
        try {
          deliver(JSON.parse(line));
        } catch {}
      }
      index = stdoutBuffer.indexOf('\n');
    }
  });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  return {
    child,
    send(message) { child.stdin.write(JSON.stringify(message) + '\n'); },
    sendLine(line) { child.stdin.write(line + '\n'); },
    next(timeoutMs = 4000) {
      if (responses.length) return Promise.resolve(responses.shift());
      return new Promise((resolve, reject) => {
        const waiter = { resolve, timer: null };
        waiter.timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index !== -1) waiters.splice(index, 1);
          reject(new Error('timed out waiting for a client response'));
        }, timeoutMs);
        waiters.push(waiter);
      });
    },
    stderrText() { return stderr; },
    exit() {
      if (!exitPromise) {
        exitPromise = new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode !== null) {
            resolve(child.exitCode);
            return;
          }
          child.on('close', (code) => resolve(code));
          child.stdin.end();
        });
      }
      return exitPromise;
    },
  };
}

test('initialize answers with no daemon at all', async () => {
  const port = await closedPort();
  const client = startClient({ QOL_TRAY_BASE_URL: 'http://127.0.0.1:' + port });
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    client.send({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } },
    });
    const first = await client.next();
    assert.strictEqual(first.id, 1);
    assert.strictEqual(first.result.protocolVersion, '2025-06-18');
    assert.strictEqual(first.result.capabilities.tools.listChanged, false);
    assert.strictEqual(first.result.serverInfo.name, 'qol');
    assert.strictEqual(first.result.serverInfo.version, manifest.version);
    client.send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } });
    const second = await client.next();
    assert.strictEqual(second.id, 2);
    assert.strictEqual(second.result.protocolVersion, '2025-06-18');
  } finally {
    await client.exit();
  }
});

test('ping answers an empty result with no daemon', async () => {
  const port = await closedPort();
  const client = startClient({ QOL_TRAY_BASE_URL: 'http://127.0.0.1:' + port });
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    const reply = await client.next();
    assert.deepStrictEqual(reply, { jsonrpc: '2.0', id: 1, result: {} });
  } finally {
    await client.exit();
  }
});

test('tools/list relays the live list and sends the token and agent home headers', { skip: SKIP_WIN_POSIX_SHIM }, async () => {
  const dir = tempDir('qol-memory-mcp-bin-');
  writeQol(dir, 'echo /tmp/qol-home-test');
  const liveTools = [{ name: 'qol-memory__ask', description: 'live description', inputSchema: { type: 'object' } }];
  const { server, state } = mcpServer((message, res) => {
    respond(res, { jsonrpc: '2.0', id: message.id, result: { tools: liveTools } });
  });
  const port = await listen(server);
  const client = startClient({ ...pathEnv(dir), QOL_TRAY_BASE_URL: 'http://127.0.0.1:' + port });
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const reply = await client.next();
    assert.deepStrictEqual(reply, { jsonrpc: '2.0', id: 1, result: { tools: liveTools } });
    assert.strictEqual(state.requests.length, 1);
    assert.strictEqual(state.requests[0].method, 'tools/list');
    assert.strictEqual(state.headers[0]['x-qol-token'], 't');
    assert.strictEqual(state.headers[0]['x-qol-agent-home'], '/tmp/qol-home-test');
  } finally {
    await client.exit();
    await stop(server);
  }
});

test('tools/list falls back to the built-in catalog when the port is closed', async () => {
  const port = await closedPort();
  const client = startClient({ QOL_TRAY_BASE_URL: 'http://127.0.0.1:' + port });
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const reply = await client.next();
    assert.deepStrictEqual(
      reply.result.tools.map((tool) => tool.name),
      ['qol-memory__ask', 'qol-memory__status', 'qol-memory__capture'],
    );
    await until(() => /serving the built-in tool list/.test(client.stderrText()));
  } finally {
    await client.exit();
  }
});

test('tools/list falls back to the built-in catalog when the daemon answers HTTP 500', async () => {
  const { server } = mcpServer((message, res) => {
    respond(res, { error: { message: 'boom' } }, 500);
  });
  const port = await listen(server);
  const client = startClient({ QOL_TRAY_BASE_URL: 'http://127.0.0.1:' + port });
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const reply = await client.next();
    assert.deepStrictEqual(
      reply.result.tools.map((tool) => tool.name),
      ['qol-memory__ask', 'qol-memory__status', 'qol-memory__capture'],
    );
    await until(() => /serving the built-in tool list/.test(client.stderrText()));
  } finally {
    await client.exit();
    await stop(server);
  }
});

test('tools/call relays a live result unchanged', async () => {
  const liveResult = { content: [{ type: 'text', text: 'live ask result' }], isError: false };
  const { server, state } = mcpServer((message, res) => {
    respond(res, { jsonrpc: '2.0', id: message.id, result: liveResult });
  });
  const port = await listen(server);
  const client = startClient({ QOL_TRAY_BASE_URL: 'http://127.0.0.1:' + port });
  try {
    const params = { name: 'qol-memory__ask', arguments: { query: 'what landed', cwd: '/proj', exclude_session: 's1' } };
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params });
    const reply = await client.next();
    assert.deepStrictEqual(reply, { jsonrpc: '2.0', id: 1, result: liveResult });
    assert.deepStrictEqual(state.requests[0].params, params);
  } finally {
    await client.exit();
    await stop(server);
  }
});

test('tools/call relays a JSON-RPC error body unchanged', async () => {
  const { server } = mcpServer((message, res) => {
    respond(res, { jsonrpc: '2.0', id: message.id, error: { code: -32602, message: 'unknown tool: nope' } });
  });
  const port = await listen(server);
  const client = startClient({ QOL_TRAY_BASE_URL: 'http://127.0.0.1:' + port });
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'nope', arguments: {} } });
    const reply = await client.next();
    assert.deepStrictEqual(reply, {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32602, message: 'unknown tool: nope' },
    });
  } finally {
    await client.exit();
    await stop(server);
  }
});

test('tools/call retries a refused connection and succeeds when the daemon starts during the wait', async () => {
  const liveResult = { content: [{ type: 'text', text: 'back online' }], isError: false };
  const { server, state } = mcpServer((message, res) => {
    respond(res, { jsonrpc: '2.0', id: message.id, result: liveResult });
  });
  const port = await listen(server);
  await stop(server);
  const client = startClient({
    QOL_TRAY_BASE_URL: 'http://127.0.0.1:' + port,
    QOL_MEMORY_MCP_CALL_WAIT_MS: '4000',
    QOL_MEMORY_MCP_CALL_TIMEOUT_MS: '1000',
  });
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'qol-memory__status', arguments: {} } });
    await delay(300);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => resolve());
    });
    const reply = await client.next();
    assert.deepStrictEqual(reply, { jsonrpc: '2.0', id: 1, result: liveResult });
    assert.strictEqual(state.requests.length, 1);
  } finally {
    await client.exit();
    if (server.listening) await stop(server);
  }
});

test('tools/call answers an isError result when the daemon never comes up', async () => {
  const port = await closedPort();
  const client = startClient({
    QOL_TRAY_BASE_URL: 'http://127.0.0.1:' + port,
    QOL_MEMORY_MCP_CALL_WAIT_MS: '400',
    QOL_MEMORY_MCP_CALL_TIMEOUT_MS: '200',
  });
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'qol-memory__status', arguments: {} } });
    const reply = await client.next();
    assert.strictEqual(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /could not reach qol-tray/);
  } finally {
    await client.exit();
  }
});

test('tools/call fails fast on an HTTP 401 body', async () => {
  const { server, state } = mcpServer((message, res) => {
    respond(res, { error: { message: 'bad token' } }, 401);
  });
  const port = await listen(server);
  const client = startClient({
    QOL_TRAY_BASE_URL: 'http://127.0.0.1:' + port,
    QOL_MEMORY_MCP_CALL_WAIT_MS: '5000',
  });
  try {
    const started = Date.now();
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'qol-memory__status', arguments: {} } });
    const reply = await client.next();
    const elapsed = Date.now() - started;
    assert.strictEqual(reply.result.isError, true);
    assert.match(reply.result.content[0].text, /could not reach qol-tray/);
    assert.ok(elapsed < 2000, 'expected a fast failure, took ' + elapsed + ' ms');
    assert.strictEqual(state.requests.length, 1);
  } finally {
    await client.exit();
    await stop(server);
  }
});

test('resources/list is proxied to the daemon and errors when the daemon is down', async () => {
  const { server, state } = mcpServer((message, res) => {
    respond(res, { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'Method not found' } });
  });
  const port = await listen(server);
  const client = startClient({ QOL_TRAY_BASE_URL: 'http://127.0.0.1:' + port });
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
    const reply = await client.next();
    assert.deepStrictEqual(reply, {
      jsonrpc: '2.0',
      id: 1,
      error: { code: -32601, message: 'Method not found' },
    });
    assert.strictEqual(state.requests[0].method, 'resources/list');
  } finally {
    await client.exit();
    await stop(server);
  }
  const downPort = await closedPort();
  const downClient = startClient({ QOL_TRAY_BASE_URL: 'http://127.0.0.1:' + downPort });
  try {
    downClient.send({ jsonrpc: '2.0', id: 1, method: 'resources/list' });
    const reply = await downClient.next();
    assert.strictEqual(reply.error.code, -32000);
    assert.strictEqual(typeof reply.error.message, 'string');
  } finally {
    await downClient.exit();
  }
});

test('the agent home header is omitted when no qol is on PATH', async () => {
  const emptyDir = tempDir('qol-memory-mcp-empty-');
  const liveTools = [{ name: 'qol-memory__ask', description: 'live description', inputSchema: { type: 'object' } }];
  const { server, state } = mcpServer((message, res) => {
    respond(res, { jsonrpc: '2.0', id: message.id, result: { tools: liveTools } });
  });
  const port = await listen(server);
  const client = startClient({ ...pathEnv(emptyDir), QOL_TRAY_BASE_URL: 'http://127.0.0.1:' + port });
  try {
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
    const reply = await client.next();
    assert.deepStrictEqual(reply, { jsonrpc: '2.0', id: 1, result: { tools: liveTools } });
    assert.strictEqual(state.headers[0]['x-qol-agent-home'], undefined);
  } finally {
    await client.exit();
    await stop(server);
  }
});

test('a notification produces no stdout line and a following ping still answers', async () => {
  const client = startClient({});
  try {
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    await assert.rejects(client.next(300), /timed out waiting for a client response/);
    client.send({ jsonrpc: '2.0', id: 2, method: 'ping' });
    const reply = await client.next();
    assert.deepStrictEqual(reply, { jsonrpc: '2.0', id: 2, result: {} });
  } finally {
    await client.exit();
  }
});

test('a malformed line answers -32700 with a null id', async () => {
  const client = startClient({});
  try {
    client.sendLine('not json');
    const reply = await client.next();
    assert.deepStrictEqual(reply, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  } finally {
    await client.exit();
  }
});

test('the process exits with code 0 when stdin closes', async () => {
  const client = startClient({});
  const code = await client.exit();
  assert.strictEqual(code, 0);
});
