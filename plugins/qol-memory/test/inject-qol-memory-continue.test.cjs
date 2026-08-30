'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const { mkdtempSync, writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');

const HOOK = path.join(__dirname, '..', 'bin', 'inject-qol-memory-continue.cjs');
const CWD = '/sandbox/proj';
const SID = '019f8e9c-aaaa-0000-0000-000000000001';

function makeStore(events) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'qolmem-store-'));
  if (events) {
    writeFileSync(path.join(dir, 'retrievals.jsonl'), events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  return dir;
}

const EMPTY_STORE = makeStore();

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function stop(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function captureServer(handler) {
  const state = { requests: 0, last: null };
  const server = http.createServer((req, res) => {
    state.requests += 1;
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      state.last = {
        url: req.url,
        method: req.method,
        token: req.headers['x-qol-token'],
        body: JSON.parse(raw),
      };
      handler(res);
    });
  });
  return { server, state };
}

function run(port, payload, env) {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [HOOK], {
      env: {
        ...process.env,
        QOL_MEMORY_STORE: EMPTY_STORE,
        QOL_TRAY_BASE_URL: 'http://127.0.0.1:' + port,
        QOL_TRAY_HTTP_TOKEN: 't',
        ...(env || {}),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ status: code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

test('injected stage yields the SessionStart hook JSON with the block as additionalContext', async () => {
  const { server, state } = captureServer((res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ stage: 'injected', block: '[qol-memory continue] 2 unit(s) landed' }));
  });
  const port = await listen(server);
  try {
    const r = await run(port, {
      cwd: CWD,
      session_id: SID,
      session_file: '/sandbox/proj/.pi/sessions/session.jsonl',
      reason: 'startup',
    });
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(JSON.parse(r.stdout), {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: '[qol-memory continue] 2 unit(s) landed',
      },
    });
    assert.strictEqual(state.requests, 1);
    assert.strictEqual(state.last.url, '/api/plugins/qol-memory/queries/continue');
    assert.strictEqual(state.last.method, 'POST');
    assert.strictEqual(state.last.token, 't');
    assert.deepStrictEqual(state.last.body, { cwd: CWD, session: SID });
  } finally {
    await stop(server);
  }
});

test('quiet stage prints nothing', async () => {
  const { server } = captureServer((res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ stage: 'quiet' }));
  });
  const port = await listen(server);
  try {
    const r = await run(port, { cwd: CWD, session_id: SID });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  } finally {
    await stop(server);
  }
});

test('a closed port prints nothing and exits 0', async () => {
  const server = http.createServer(() => {});
  const port = await listen(server);
  await stop(server);
  const r = await run(port, { cwd: CWD, session_id: SID });
  assert.strictEqual(r.status, 0);
  assert.strictEqual(r.stdout, '');
});

test('QOL_MEMORY_CONTINUE_DISABLE=1 prints nothing without contacting the server', async () => {
  const { server, state } = captureServer((res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ stage: 'injected', block: 'should not be used' }));
  });
  const port = await listen(server);
  try {
    const r = await run(port, { cwd: CWD, session_id: SID }, { QOL_MEMORY_CONTINUE_DISABLE: '1' });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(state.requests, 0);
  } finally {
    await stop(server);
  }
});

test('injected block gains the queue count line', async () => {
  const store = makeStore([
    { source: 'launcher', query: 'how does the queue work', ts: new Date().toISOString(), verdict: 'no-memory' },
  ]);
  const { server } = captureServer((res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ stage: 'injected', block: '[qol-memory continue] 2 unit(s) landed' }));
  });
  const port = await listen(server);
  try {
    const r = await run(port, { cwd: CWD, session_id: SID }, { QOL_MEMORY_STORE: store });
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(JSON.parse(r.stdout), {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: '[qol-memory continue] 2 unit(s) landed\nqol-memory: 1 unanswered launcher questions - type: qolmem gen',
      },
      systemMessage: 'qol-memory: 1 unanswered launcher questions - type qolmem gen to answer them',
    });
  } finally {
    await stop(server);
  }
});

test('daemon abstain with a non-empty queue emits the count line alone', async () => {
  const store = makeStore([
    { source: 'launcher', query: 'how does the queue work', ts: new Date(Date.now() - 120000).toISOString(), verdict: 'no-memory' },
    { source: 'launcher', query: 'where is the tray menu', ts: new Date(Date.now() - 60000).toISOString(), verdict: 'candidates' },
  ]);
  const { server } = captureServer((res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ stage: 'quiet' }));
  });
  const port = await listen(server);
  try {
    const r = await run(port, { cwd: CWD, session_id: SID }, { QOL_MEMORY_STORE: store });
    assert.strictEqual(r.status, 0);
    assert.deepStrictEqual(JSON.parse(r.stdout), {
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: 'qol-memory: 2 unanswered launcher questions - type: qolmem gen',
      },
      systemMessage: 'qol-memory: 2 unanswered launcher questions - type qolmem gen to answer them',
    });
  } finally {
    await stop(server);
  }
});

test('daemon abstain with an empty queue stays silent', async () => {
  const store = makeStore();
  const { server } = captureServer((res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ stage: 'quiet' }));
  });
  const port = await listen(server);
  try {
    const r = await run(port, { cwd: CWD, session_id: SID }, { QOL_MEMORY_STORE: store });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
  } finally {
    await stop(server);
  }
});

test('QOL_MEMORY_CONTINUE_DISABLE=1 stays silent even with a queue', async () => {
  const store = makeStore([
    { source: 'launcher', query: 'how does the queue work', ts: new Date().toISOString(), verdict: 'no-memory' },
  ]);
  const { server, state } = captureServer((res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ stage: 'injected', block: 'should not be used' }));
  });
  const port = await listen(server);
  try {
    const r = await run(port, { cwd: CWD, session_id: SID }, {
      QOL_MEMORY_STORE: store,
      QOL_MEMORY_CONTINUE_DISABLE: '1',
    });
    assert.strictEqual(r.status, 0);
    assert.strictEqual(r.stdout, '');
    assert.strictEqual(state.requests, 0);
  } finally {
    await stop(server);
  }
});
