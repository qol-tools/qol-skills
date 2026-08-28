'use strict';

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_BASE_URL = 'http://127.0.0.1:42700';

function baseUrl() {
  const env = process.env.QOL_TRAY_BASE_URL;
  return env && env.length ? env : DEFAULT_BASE_URL;
}

function tokenCandidates() {
  const xdg = process.env.XDG_CONFIG_HOME;
  const home = os.homedir();
  return [
    xdg && xdg.length ? path.join(xdg, 'qol-tray', '.http-token') : null,
    path.join(home, '.config', 'qol-tray', '.http-token'),
    path.join(home, 'Library', 'Application Support', 'qol-tray', '.http-token'),
  ].filter(Boolean);
}

function readToken() {
  const env = process.env.QOL_TRAY_HTTP_TOKEN;
  if (env && env.length) return env;
  for (const file of tokenCandidates()) {
    try {
      if (!fs.existsSync(file)) continue;
      const token = fs.readFileSync(file, 'utf8').trim();
      if (token) return token;
    } catch {}
  }
  return null;
}

function postJson(urlPath, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const token = readToken();
    if (!token) {
      reject(new Error('no qol-tray http token'));
      return;
    }
    const payload = Buffer.from(JSON.stringify(body));
    const req = http.request(baseUrl() + urlPath, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-qol-token': token,
      },
      timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error('qol-tray http timeout'));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

module.exports = { baseUrl, readToken, postJson };
