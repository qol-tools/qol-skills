#!/usr/bin/env node
'use strict';

/*
 * say-issue: audio brief for a GitHub Issue.
 *
 * Usage:
 *   node say-issue.cjs <repo> <issue-number>           # speak via macOS `say`
 *   node say-issue.cjs <repo> <issue-number> --out <path>.aiff  # write to file
 *   node say-issue.cjs qol-tools/plugin-alt-tab 1
 *
 * Pulls the issue title + body's first paragraph + each comment's TL;DR
 * (looking for "**TL;DR.**" or "**TL;DR:**" or "TL;DR." patterns), plus
 * the latest "Recommend:" line if a Ship-readiness comment is present.
 * Pipes the result through macOS `say` so the user can listen instead
 * of reading. Returns the spoken text on stdout.
 *
 * Falls back to printing the brief if `say` isn't available (non-mac).
 */

const { execFileSync, spawnSync } = require('node:child_process');
const fs = require('node:fs');

const args = process.argv.slice(2);
if (args.length < 2) {
    console.error('usage: say-issue <repo> <issue-number> [--out <path>.aiff]');
    process.exit(2);
}

const repo = args[0].includes('/') ? args[0] : `qol-tools/${args[0]}`;
const issueNumber = args[1];
const outIdx = args.indexOf('--out');
const outPath = outIdx >= 0 ? args[outIdx + 1] : null;

function ghJson(...path) {
    const raw = execFileSync('gh', ['api', `repos/${repo}/issues/${issueNumber}${path.length ? '/' + path.join('/') : ''}`], { encoding: 'utf8' });
    return JSON.parse(raw);
}

function firstParagraph(body) {
    const cleaned = (body || '').replace(/```[\s\S]*?```/g, '').trim();
    const para = cleaned.split(/\n\s*\n/).find(p => p.trim().length > 0) || '';
    return para.replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
}

function extractTldr(body) {
    if (!body) return null;
    const m = body.match(/\*\*TL;?DR[.:]\*\*\s*([^\n]+(?:\n[^\n]+)*?)(?:\n\s*\n|$)/i);
    if (!m) return null;
    return m[1].replace(/[#*_`>]/g, '').replace(/\s+/g, ' ').trim();
}

function extractRecommend(body) {
    if (!body) return null;
    const m = body.match(/\*\*Recommend:\*\*\s*([^\n]+)/i);
    return m ? m[1].replace(/[#*_`>]/g, '').trim() : null;
}

const issue = ghJson();
const comments = ghJson('comments');

const lines = [];
lines.push(`Issue ${issueNumber} on ${repo}: ${issue.title}.`);
lines.push(firstParagraph(issue.body));

let lastShipReady = null;
for (const c of comments) {
    if (/### Ship-readiness assessment/i.test(c.body || '')) lastShipReady = c;
}

if (lastShipReady) {
    const tldr = extractTldr(lastShipReady.body);
    const rec = extractRecommend(lastShipReady.body);
    if (tldr) lines.push(`Latest assessment. ${tldr}`);
    if (rec) lines.push(`Recommendation: ${rec}.`);
} else {
    const tldrComments = comments
        .map(c => extractTldr(c.body))
        .filter(Boolean);
    if (tldrComments.length) {
        lines.push(`Latest comment summary. ${tldrComments[tldrComments.length - 1]}`);
    } else {
        lines.push(`No ship-readiness comment yet. ${comments.length} comment${comments.length === 1 ? '' : 's'} on the issue.`);
    }
}

const text = lines.join(' ');
console.log(text);

const sayPath = spawnSync('which', ['say']).stdout?.toString().trim();
if (!sayPath) {
    console.error('\n[say-issue] `say` not found (non-macOS); printed brief above.');
    process.exit(0);
}

if (outPath) {
    execFileSync('say', ['-o', outPath, text], { stdio: 'inherit' });
    console.error(`\n[say-issue] wrote ${outPath}`);
    process.exit(0);
}

execFileSync('say', [text], { stdio: 'inherit' });
