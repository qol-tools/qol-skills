'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeQol(dir, body) {
  const file = path.join(dir, 'qol');
  fs.writeFileSync(file, '#!/bin/sh\n' + body + '\n');
  fs.chmodSync(file, 0o755);
}

module.exports = { tempDir, writeQol };
