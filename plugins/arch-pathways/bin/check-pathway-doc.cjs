#!/usr/bin/env node
/*
 * arch-pathways PreToolUse hook.
 *
 * Blocks Writes/Edits to *pathways*.html files that violate the
 * arch-pathways skill's structural contract.
 *
 * See SKILL.md for the contract. Bypass with .claude/bypass-arch-pathways.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INSPECTED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const PATHWAYS_NAME_RE = /pathways.*\.html$/i;
const TEMPLATE_BASENAME = 'template.html';
const STRUCTURAL_PAGE_IDS = new Set(['overview', 'cross']);

const SIDEBAR_RE = /<nav\s+class="sidebar"/i;
const SECTION_RE = /<section\s+class="page"\s+id="([a-zA-Z0-9_-]+)"[\s\S]*?<\/section>/gi;
const PROBLEM_HEADER_RE = /<h3>\s*Problem\s*<\/h3>/i;
const PROPOSALS_HEADER_RE = /<h3>\s*Proposals\s*<\/h3>/i;
const PROPOSAL_FALLBACK_RE = /<div\s+class="proposal"[\s\S]*?(?=<\/section>)/gi;
const MERMAID_RE = /<pre\s+class="mermaid"/i;
const TRADEOFFS_PROS_FIRST_RE = /<div\s+class="tradeoffs"[\s\S]*?<h5>\s*pros\s*<\/h5>[\s\S]*?<h5>\s*cons\s*<\/h5>/i;
const TRADEOFFS_CONS_FIRST_RE = /<div\s+class="tradeoffs"[\s\S]*?<h5>\s*cons\s*<\/h5>[\s\S]*?<h5>\s*pros\s*<\/h5>/i;
const BADGE_RE = /<span\s+class="badge\s+(cheap|medium|heavy)"/i;
const SMELL_TABLE_RE = /<table[\s\S]*?<\/table>/gi;
const SMELL_HEADER_RE = /<th[^>]*>\s*Smell\s*<\/th>/i;
const ROW_RE = /<tr\b[^>]*>[\s\S]*?<\/tr>/gi;
const ROW_CLASS_RE = /<tr\s+class="(bad|warn|good)"/i;
const ROW_HAS_TH_RE = /<th\b/i;
const ROW_SWATCH_RE = /<span\s+class="swatch\s+(bad|warn|good)"/i;
const LEGEND_RE = /<div\s+class="legend"/i;
const PID_TOKEN_RE = /[A-Z][A-Z0-9_]*-\d+/g;
const PID_CELL_RE = /<td\s+class="pid"[^>]*>\s*([A-Z][A-Z0-9_]*-\d+)\s*<\/td>/;
const CLOSES_BLOCK_RE = /<p\s+class="closes"[^>]*>([\s\S]*?)<\/p>/i;

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function extractNewContent(tool, input) {
    if (!input) return '';
    if (tool === 'Write') return input.content || '';
    if (tool === 'Edit') return input.new_string || '';
    if (tool === 'MultiEdit') {
        return (input.edits || [])
            .map(e => e.new_string || '')
            .join('\n\n');
    }
    if (tool === 'NotebookEdit') return input.new_source || '';
    return '';
}

function findProposalBlocks(content) {
    const blocks = [];
    const exhaustive = content.match(PROPOSAL_FALLBACK_RE);
    if (!exhaustive) return blocks;
    for (const block of exhaustive) {
        const segments = block.split(/(?=<div\s+class="proposal")/i);
        for (const seg of segments) {
            if (/<div\s+class="proposal"/i.test(seg)) {
                blocks.push(seg);
            }
        }
    }
    return blocks;
}

function findPageSections(content) {
    const matches = [];
    let m;
    SECTION_RE.lastIndex = 0;
    while ((m = SECTION_RE.exec(content)) !== null) {
        matches.push({ id: m[1], body: m[0] });
    }
    return matches;
}

function findSmellTables(content) {
    const tables = [];
    const all = content.match(SMELL_TABLE_RE);
    if (!all) return tables;
    for (const table of all) {
        if (SMELL_HEADER_RE.test(table)) tables.push(table);
    }
    return tables;
}

function bodyRowsOf(table) {
    const rows = table.match(ROW_RE) || [];
    return rows.filter(r => !ROW_HAS_TH_RE.test(r));
}

function findProposalBlocksIn(sectionBody) {
    const blocks = [];
    const exhaustive = sectionBody.match(PROPOSAL_FALLBACK_RE);
    if (!exhaustive) return blocks;
    for (const block of exhaustive) {
        const segments = block.split(/(?=<div\s+class="proposal")/i);
        for (const seg of segments) {
            if (/<div\s+class="proposal"/i.test(seg)) blocks.push(seg);
        }
    }
    return blocks;
}

function collectSectionPids(sectionBody) {
    const pids = new Set();
    for (const table of findSmellTables(sectionBody)) {
        for (const row of bodyRowsOf(table)) {
            const m = row.match(PID_CELL_RE);
            if (m) pids.add(m[1]);
        }
    }
    return pids;
}

function extractClosesIds(closesText) {
    const matches = closesText.match(PID_TOKEN_RE);
    return matches ? Array.from(new Set(matches)) : [];
}

function validateContent(content) {
    const violations = [];
    if (!SIDEBAR_RE.test(content)) {
        violations.push('missing <nav class="sidebar">');
    }
    for (const section of findPageSections(content)) {
        if (STRUCTURAL_PAGE_IDS.has(section.id)) continue;
        if (!PROBLEM_HEADER_RE.test(section.body)) {
            violations.push(`section #${section.id}: missing <h3>Problem</h3>`);
        }
        if (!PROPOSALS_HEADER_RE.test(section.body)) {
            violations.push(`section #${section.id}: missing <h3>Proposals</h3>`);
        }
    }
    for (const section of findPageSections(content)) {
        if (STRUCTURAL_PAGE_IDS.has(section.id)) continue;
        const sectionPids = collectSectionPids(section.body);
        const proposals = findProposalBlocksIn(section.body);
        proposals.forEach((proposal, idx) => {
            const label = `section #${section.id} proposal #${idx + 1}`;
            const closesMatch = proposal.match(CLOSES_BLOCK_RE);
            if (!closesMatch) {
                violations.push(`${label}: missing <p class="closes">Closes: PID-1, PID-2</p>`);
                return;
            }
            const ids = extractClosesIds(closesMatch[1]);
            if (ids.length === 0) {
                violations.push(`${label}: <p class="closes"> contains no problem IDs (expected like BOOT-1)`);
                return;
            }
            for (const id of ids) {
                if (!sectionPids.has(id)) {
                    violations.push(`${label}: closes "${id}" but section #${section.id} has no smell row with that ID`);
                }
            }
        });
    }
    const proposals = findProposalBlocks(content);
    proposals.forEach((proposal, idx) => {
        const label = `proposal #${idx + 1}`;
        if (!MERMAID_RE.test(proposal)) {
            violations.push(`${label}: missing <pre class="mermaid"> diagram`);
        }
        if (!TRADEOFFS_PROS_FIRST_RE.test(proposal) && !TRADEOFFS_CONS_FIRST_RE.test(proposal)) {
            violations.push(`${label}: missing <div class="tradeoffs"> with both <h5>pros</h5> and <h5>cons</h5>`);
        }
        if (!BADGE_RE.test(proposal)) {
            violations.push(`${label}: missing <span class="badge cheap|medium|heavy">`);
        }
    });
    const smellTables = findSmellTables(content);
    if (smellTables.length > 0 && !LEGEND_RE.test(content)) {
        violations.push('smell tables present but missing <div class="legend"> on overview page');
    }
    smellTables.forEach((table, idx) => {
        const tableLabel = `smell table #${idx + 1}`;
        bodyRowsOf(table).forEach((row, rowIdx) => {
            const rowLabel = `${tableLabel} row ${rowIdx + 1}`;
            const rowClassMatch = row.match(ROW_CLASS_RE);
            if (!rowClassMatch) {
                violations.push(`${rowLabel}: missing class="bad|warn|good" on <tr>`);
                return;
            }
            const swatchMatch = row.match(ROW_SWATCH_RE);
            if (!swatchMatch) {
                violations.push(`${rowLabel}: missing <span class="swatch bad|warn|good">`);
                return;
            }
            if (rowClassMatch[1] !== swatchMatch[1]) {
                violations.push(`${rowLabel}: tr class "${rowClassMatch[1]}" does not match swatch class "${swatchMatch[1]}"`);
            }
            if (!PID_CELL_RE.test(row)) {
                violations.push(`${rowLabel}: missing <td class="pid">AREA-N</td> first cell`);
            }
        });
    });
    return violations;
}

function block(filePath, violations) {
    process.stderr.write(`arch-pathways violation in ${filePath}:

${violations.map(v => `  - ${v}`).join('\n')}

The arch-pathways skill requires:
  - <nav class="sidebar"> for navigation.
  - Every problem page (not "overview" or "cross") must have BOTH
        <h3>Problem</h3>  AND  <h3>Proposals</h3>
  - Every <div class="proposal"> must contain ALL of:
        <pre class="mermaid">         (visualize the proposal)
        <div class="tradeoffs"> with <h5>pros</h5> AND <h5>cons</h5>
        <span class="badge cheap|medium|heavy">
  - Any <table> with a <th>Smell</th> column is a smell table; every body row must have
        <tr class="bad|warn|good">
        <td class="pid">AREA-N</td>          (e.g. BOOT-1, PATH-3)
        <span class="swatch bad|warn|good">  (matching the row class)
    AND the doc must have one <div class="legend"> on the overview page.
  - Every <div class="proposal"> must have a <p class="closes">Closes: BOOT-1, BOOT-3</p>
    line, and every referenced ID must exist as a smell-table pid in the SAME section.

See the skill SKILL.md and template.html for the canonical shape.

Bypass for this single edit:
  touch .claude/bypass-arch-pathways
`);
}

function consumeBypass(cwd) {
    const marker = path.join(cwd, '.claude', 'bypass-arch-pathways');
    if (!fs.existsSync(marker) || !fs.statSync(marker).isFile()) return false;
    try {
        const raw = fs.readFileSync(marker, 'utf8').trim();
        const count = /^\d+$/.test(raw) ? Number(raw) : 1;
        if (count > 1) {
            fs.writeFileSync(marker, String(count - 1));
        } else {
            fs.unlinkSync(marker);
        }
    } catch {
        // ignore
    }
    return true;
}

function main() {
    const raw = readStdin().trim();
    if (!raw) return 0;

    let payload;
    try {
        payload = JSON.parse(raw);
    } catch {
        return 0;
    }

    const tool = payload.tool_name || payload.tool || '';
    if (!INSPECTED_TOOLS.has(tool)) return 0;

    const input = payload.tool_input || {};
    const filePath = input.file_path || input.notebook_path || '';
    if (!filePath) return 0;

    const basename = path.basename(filePath);
    if (basename === TEMPLATE_BASENAME) return 0;
    if (!PATHWAYS_NAME_RE.test(basename)) return 0;

    const cwd = payload.cwd || process.cwd();
    if (consumeBypass(cwd)) return 0;

    const newContent = extractNewContent(tool, input);
    if (!newContent) return 0;

    const violations = validateContent(newContent);
    if (violations.length > 0) {
        block(filePath, violations);
        return 2;
    }

    return 0;
}

process.exit(main());
