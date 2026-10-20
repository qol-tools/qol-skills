'use strict';

const fs = require('node:fs');
const path = require('node:path');

const QOL_SEGMENT = /(^|[\\/])qol(?:-[^\\/]+)?([\\/]|$)/;
const QOL_REMOTE = /^\s*url\s*=\s*\S*[/:]qol-tools\/\S+/m;

const remoteByDirectory = new Map();

function readFile(file) {
    try {
        return fs.readFileSync(file, 'utf8');
    } catch {
        return null;
    }
}

function gitConfig(dotGit) {
    let stat;
    try {
        stat = fs.statSync(dotGit);
    } catch {
        return undefined;
    }
    if (stat.isDirectory()) return readFile(path.join(dotGit, 'config'));
    const pointer = /^gitdir:\s*(.+)$/m.exec(readFile(dotGit) || '');
    if (!pointer) return null;
    const gitDir = path.resolve(path.dirname(dotGit), pointer[1].trim());
    const common = (readFile(path.join(gitDir, 'commondir')) || '').trim();
    return readFile(path.join(common ? path.resolve(gitDir, common) : gitDir, 'config'));
}

function qolRemote(directory) {
    if (remoteByDirectory.has(directory)) return remoteByDirectory.get(directory);
    const config = gitConfig(path.join(directory, '.git'));
    const parent = path.dirname(directory);
    const result = config === undefined
        ? parent !== directory && qolRemote(parent)
        : Boolean(config && QOL_REMOTE.test(config));
    remoteByDirectory.set(directory, result);
    return result;
}

function inQolRepo(target) {
    if (!target) return false;
    if (QOL_SEGMENT.test(target)) return true;
    return qolRemote(path.resolve(target));
}

module.exports = { inQolRepo };
