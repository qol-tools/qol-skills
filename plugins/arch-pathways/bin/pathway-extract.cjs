#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const survey = require('../lib/html-survey.cjs');
const pid = require('../lib/pid.cjs');

function printHelp(log) {
    log(`Usage: pathway-extract <area-id> [options]

Reads an arch-pathways HTML survey doc and emits a markdown ADR chunk for the
given area, ready to drop into docs/adr/<PID>-<slug>.md.

Required:
  <area-id>           Section id from the HTML doc (e.g. "boot", "path", "sync").

Options:
  --in <html>         Path to the HTML survey doc. Default: /tmp/qol-tray-pathways.html
  --pid <PID>         If given, rewrite all "AREA-N" PIDs in this area to "<PID>.M"
                      (M = 1..k in row order). Use this to align an HTML survey area
                      with a freshly-minted GitHub-issue-backed PID.
  --issue <N>         GitHub issue number for the frontmatter "Closes:" line.
                      Defaults to the numeric suffix of --pid.
  --status <text>     Frontmatter Status. Default: Proposed.
  --title <text>      Override the area title (otherwise <h2> text is used).
  -h, --help          Show this help.

Output: prints the generated markdown to stdout.`);
}

function parseArgs(argv) {
    const opts = { positional: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '-h' || a === '--help') opts.help = true;
        else if (a === '--in') opts.input = argv[++i];
        else if (a === '--pid') opts.pid = argv[++i];
        else if (a === '--issue') opts.issue = Number(argv[++i]);
        else if (a === '--status') opts.status = argv[++i];
        else if (a === '--title') opts.title = argv[++i];
        else if (a.startsWith('--')) throw new Error(`unknown flag: ${a}`);
        else opts.positional.push(a);
    }
    return opts;
}

function today() { return new Date().toISOString().slice(0, 10); }

function indentMermaid(blocks) {
    return blocks.map(b => '```mermaid\n' + b.trim() + '\n```').join('\n\n');
}

function smellRowsToMarkdown(rows, pidMap) {
    const out = ['| ID | State | Smell |', '|----|-------|-------|'];
    for (const row of rows) {
        const cells = row.map((c, i) => {
            if (i === 0 && pidMap) return pidMap.get(c) || c;
            return c;
        });
        const padded = [cells[0] || '', cells[1] || '', cells[2] || ''].map(c => c.replace(/\|/g, '\\|').replace(/\n+/g, ' '));
        out.push(`| ${padded.join(' | ')} |`);
    }
    return out.join('\n');
}

function tradeoffsToMarkdown(pros, cons) {
    if (pros.length === 0 && cons.length === 0) return '';
    const max = Math.max(pros.length, cons.length, 1);
    const out = ['| Pros | Cons |', '|------|------|'];
    for (let i = 0; i < max; i++) {
        const p = (pros[i] || '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
        const c = (cons[i] || '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
        out.push(`| ${p} | ${c} |`);
    }
    return out.join('\n');
}

function proposalToMarkdown(card, pidMap) {
    const cost = card.cost ? ` \`[${card.cost}]\`` : '';
    const lines = [];
    lines.push(`### ${card.title}${cost}`);
    if (card.description) {
        lines.push('');
        lines.push(card.description);
    }
    if (card.mermaid.length > 0) {
        lines.push('');
        lines.push(indentMermaid(card.mermaid));
    }
    if (card.pros.length || card.cons.length) {
        const t = tradeoffsToMarkdown(card.pros, card.cons);
        if (t) {
            lines.push('');
            lines.push(t);
        }
    }
    if (card.closes.length) {
        const rewritten = card.closes.map(id => (pidMap && pidMap.get(id)) || id);
        lines.push('');
        lines.push(`**Closes:** ${rewritten.join(', ')}`);
    }
    return lines.join('\n');
}

function buildAdr({ area, title, opts, today: dateStr }) {
    const adrTitle = opts.title || title;
    const headerPid = opts.pid ? `${opts.pid} ` : '';
    const issueLine = (opts.issue || (opts.pid && Number(opts.pid.split('-')[1])))
        ? `- **Closes:** #${opts.issue || Number(opts.pid.split('-')[1])}\n`
        : '';
    const rows = survey.parseSmellTable(area.problem);
    const pidMap = opts.pid ? survey.buildPidMap(rows, opts.pid) : null;
    const problemMermaid = survey.parseMermaidBlocks(area.problem);
    const cards = survey.parseProposalCards(area.proposals);

    const lines = [];
    lines.push(`# ${headerPid}${adrTitle}`.trim());
    lines.push('');
    lines.push(`- **Status:** ${opts.status || 'Proposed'}`);
    if (issueLine) lines.push(issueLine.trim());
    lines.push(`- **Date:** ${dateStr}`);
    lines.push('');
    lines.push('## Problem');
    lines.push('');
    if (problemMermaid.length > 0) {
        lines.push(indentMermaid(problemMermaid));
        lines.push('');
    }
    if (rows.length > 0) {
        lines.push(smellRowsToMarkdown(rows, pidMap));
        lines.push('');
    }
    lines.push('## Proposals');
    lines.push('');
    if (cards.length === 0) {
        lines.push('_No proposals yet._');
    } else {
        for (const card of cards) {
            lines.push(proposalToMarkdown(card, pidMap));
            lines.push('');
            lines.push('---');
            lines.push('');
        }
        lines.pop();
        lines.pop();
        lines.pop();
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
}

function run({ argv, fs: fsLike, log }) {
    const opts = parseArgs(argv);
    if (opts.help) { printHelp(log); return 0; }
    if (opts.positional.length !== 1) {
        throw new Error('expected exactly one positional arg: <area-id>');
    }
    const areaId = opts.positional[0];
    const inputPath = opts.input || '/tmp/qol-tray-pathways.html';
    if (!fsLike.existsSync(inputPath)) throw new Error(`input file not found: ${inputPath}`);
    const html = fsLike.readFileSync(inputPath, 'utf8');
    const areas = survey.parseAreas(html);
    if (!areas.has(areaId)) {
        const known = [...areas.keys()].join(', ');
        throw new Error(`area "${areaId}" not found in ${inputPath}. Known: ${known}`);
    }
    const sectionHtml = areas.get(areaId);
    const area = survey.parseSection(sectionHtml);
    if (opts.pid && !pid.parsePid(opts.pid)) {
        throw new Error(`--pid "${opts.pid}" must match "<PREFIX>-<N>"`);
    }
    const adr = buildAdr({ area, title: area.title, opts, today: today() });
    log(adr);
    return 0;
}

function main() {
    try {
        const code = run({
            argv: process.argv.slice(2),
            fs,
            log: msg => process.stdout.write(msg.endsWith('\n') ? msg : msg + '\n'),
        });
        process.exit(code);
    } catch (err) {
        process.stderr.write(`pathway-extract: ${err.message}\n`);
        process.exit(1);
    }
}

if (require.main === module) main();

module.exports = {
    run, parseArgs, buildAdr, smellRowsToMarkdown, tradeoffsToMarkdown,
    proposalToMarkdown, today, indentMermaid,
};
