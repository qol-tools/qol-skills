#!/usr/bin/env node
/*
 * architecture-pathways PreToolUse hook.
 *
 * Blocks Writes/Edits to *pathways*.html files that violate the
 * architecture-pathways skill's structural contract.
 *
 * See SKILL.md for the contract. Bypass with .claude/bypass-architecture-pathways.
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
    return violations;
}

function block(filePath, violations) {
    process.stderr.write(`architecture-pathways violation in ${filePath}:

${violations.map(v => `  - ${v}`).join('\n')}

The architecture-pathways skill requires:
  - <nav class="sidebar"> for navigation.
  - Every problem page (not "overview" or "cross") must have BOTH
        <h3>Problem</h3>  AND  <h3>Proposals</h3>
  - Every <div class="proposal"> must contain ALL of:
        <pre class="mermaid">         (visualize the proposal)
        <div class="tradeoffs"> with <h5>pros</h5> AND <h5>cons</h5>
        <span class="badge cheap|medium|heavy">

See the skill SKILL.md and template.html for the canonical shape.

Bypass for this single edit:
  touch .claude/bypass-architecture-pathways
`);
}

function consumeBypass(cwd) {
    const marker = path.join(cwd, '.claude', 'bypass-architecture-pathways');
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
