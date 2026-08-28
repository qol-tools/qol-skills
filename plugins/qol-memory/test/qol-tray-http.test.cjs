'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { baseUrl, readToken, postJson } = require('../bin/qol-tray-http.cjs');

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
}

function stop(server) {
  return new Promise((resolve) => server.close(() => resolve()));
}

function withHomeClean(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qol-tray-http-'));
  const prevXdg = process.env.XDG_CONFIG_HOME;
  const prevHome = process.env.HOME;
  process.env.XDG_CONFIG_HOME = root;
  process.env.HOME = root;
  return Promise.resolve(fn(root)).finally(() => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevHome === undefined) delete process.env.HOME;
    else process.env.HOME = prevHome;
  });
}

test('baseUrl prefers QOL_TRAY_BASE_URL when non-empty and falls back to the tray default', () => {
  delete process.env.QOL_TRAY_BASE_URL;
  assert.strictEqual(baseUrl(), 'http://127.0.0.1:42700');
  process.env.QOL_TRAY_BASE_URL = 'http://127.0.0.1:9999';
  assert.strictEqual(baseUrl(), 'http://127.0.0.1:9999');
  process.env.QOL_TRAY_BASE_URL = '';
  assert.strictEqual(baseUrl(), 'http://127.0.0.1:42700');
  delete process.env.QOL_TRAY_BASE_URL;
  assert.strictEqual(baseUrl(), 'http://127.0.0.1:42700');
});

test('readToken prefers the QOL_TRAY_HTTP_TOKEN env var over token files', () => {
  process.env.QOL_TRAY_HTTP_TOKEN = 'env-token';
  assert.strictEqual(readToken(), 'env-token');
  delete process.env.QOL_TRAY_HTTP_TOKEN;
});

test('readToken falls back to the first existing token file and trims it', () => {
  delete process.env.QOL_TRAY_HTTP_TOKEN;
  return withHomeClean((root) => {
    const dir = path.join(root, 'qol-tray');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '.http-token'), '  file-token  \n');
    assert.strictEqual(readToken(), 'file-token');
  });
});

test('readToken returns null without an env var or an existing token file', () => {
  delete process.env.QOL_TRAY_HTTP_TOKEN;
  return withHomeClean(() => {
    assert.strictEqual(readToken(), null);
  });
});

test('postJson sends the token header and JSON body and resolves the parsed body', async () => {
  const seen = {};
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      seen.url = req.url;
      seen.method = req.method;
      seen.token = req.headers['x-qol-token'];
      seen.type = req.headers['content-type'];
      seen.body = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, got: seen.body }));
    });
  });
  const port = await listen(server);
  process.env.QOL_TRAY_BASE_URL = 'http://127.0.0.1:' + port;
  process.env.QOL_TRAY_HTTP_TOKEN = 't';
  try {
    const result = await postJson('/api/plugins/qol-memory/actions/capture', { unit: { key: 'k1' } }, 1500);
    assert.strictEqual(result.status, 200);
    assert.deepStrictEqual(result.body, { ok: true, got: { unit: { key: 'k1' } } });
    assert.strictEqual(seen.method, 'POST');
    assert.strictEqual(seen.url, '/api/plugins/qol-memory/actions/capture');
    assert.strictEqual(seen.token, 't');
    assert.strictEqual(seen.type, 'application/json');
    assert.deepStrictEqual(seen.body, { unit: { key: 'k1' } });
  } finally {
    delete process.env.QOL_TRAY_BASE_URL;
    delete process.env.QOL_TRAY_HTTP_TOKEN;
    await stop(server);
  }
});

test('postJson resolves a null body for an unparseable response', async () => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('not json at all');
  });
  const port = await listen(server);
  process.env.QOL_TRAY_BASE_URL = 'http://127.0.0.1:' + port;
  process.env.QOL_TRAY_HTTP_TOKEN = 't';
  try {
    const result = await postJson('/x', {}, 1500);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.body, null);
  } finally {
    delete process.env.QOL_TRAY_BASE_URL;
    delete process.env.QOL_TRAY_HTTP_TOKEN;
    await stop(server);
  }
});

test('postJson rejects when the port is closed', async () => {
  const server = http.createServer(() => {});
  const port = await listen(server);
  await stop(server);
  process.env.QOL_TRAY_BASE_URL = 'http://127.0.0.1:' + port;
  process.env.QOL_TRAY_HTTP_TOKEN = 't';
  try {
    await assert.rejects(postJson('/x', {}, 1500));
  } finally {
    delete process.env.QOL_TRAY_BASE_URL;
    delete process.env.QOL_TRAY_HTTP_TOKEN;
  }
});

test('postJson rejects when no token is available', () => {
  delete process.env.QOL_TRAY_HTTP_TOKEN;
  return withHomeClean(() => assert.rejects(postJson('/x', {}, 1500)));
});
