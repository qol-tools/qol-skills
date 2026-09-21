'use strict';

const { execFile } = require('node:child_process');

function agentHome(harness, timeoutMs) {
  return new Promise((resolve) => {
    execFile('qol', ['agents', 'current', harness], { timeout: timeoutMs }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const text = String(stdout).trim();
      resolve(text ? text : null);
    });
  });
}

module.exports = { agentHome };
