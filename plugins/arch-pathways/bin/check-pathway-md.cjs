#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const INSPECTED_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const ADR_PATH_RE = /docs[\\/]adr[\\/][^\\/]+\.md$/i;
const ADR_FILENAME_RE = /^([A-Z][A-Z0-9]*-\d+)-([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/;

const PID_RE = /\b[A-Z][A-Z0-9]*-\d+\b/g;
const SUB_ID_RE = /\b([A-Z][A-Z0-9]*-\d+)\.(\d+)\b/g;
const CLOSES_LINE_RE = /\*\*Closes:\*\*\s*([^\n]+)/gi;
const PROBLEM_HEADER_RE = /^##\s+Problem\b/m;
const PROPOSALS_HEADER_RE = /^##\s+Proposals\b/m;
const PROPOSAL_SUB_RE = /^###\s+(.+)$/gm;
const COST_BADGE_RE = /`?\[(cheap|medium|heavy)\]`?/i;
const MERMAID_BLOCK_RE = /```mermaid[\s\S]*?```/g;
const SMELL_HEADER_RE = /^\s*\|[^\n]*\bID\b[^\n]*\|[^\n]*\bSmell\b[^\n]*\|\s*$/im;

const BYPASS_MARKER = '.claude/bypass-arch-pathways';

function readStdin() {
    try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

function consumeBypass(cwd) {
    const marker = path.join(cwd, BYPASS_MARKER);
    if (!fs.existsSync(marker) || !fs.statSync(marker).isFile()) return false;
    try {
        const raw = fs.readFileSync(marker, 'utf8').trim();
        const count = /^\d+$/.test(raw) ? Number(raw) : 1;
        if (count > 1) fs.writeFileSync(marker, String(count - 1));
        else fs.unlinkSync(marker);
    } catch { /* ignore */ }
    return true;
}

function extractNewContent(tool, input) {
    if (!input) return '';
    if (tool === 'Write') return input.content || '';
    if (tool === 'Edit') return input.new_string || '';
    if (tool === 'MultiEdit') return (input.edits || []).map(e => e.new_string || '').join('\n\n');
    if (tool === 'NotebookEdit') return input.new_source || '';
    return '';
}

function findSmellTable(content) {
    const lines = content.split('\n');
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (SMELL_HEADER_RE.test(lines[i])) { headerIdx = i; break; }
    }
    if (headerIdx === -1) return { rows: [], present: false };
    const rows = [];
    let i = headerIdx + 1;
    if (i < lines.length && /^\s*\|[\s\-:|]+\|\s*$/.test(lines[i])) i++;
    for (; i < lines.length; i++) {
        const line = lines[i];
        if (line.trim() === '' || !line.trim().startsWith('|')) break;
        const cells = line.split('|').slice(1, -1).map(c => c.trim());
        if (cells.length > 0) rows.push(cells);
    }
    return { rows, present: true };
}

function validateMermaidCompat(content) {
    const violations = [];
    const blocks = content.match(MERMAID_BLOCK_RE) || [];
    blocks.forEach((block, idx) => {
        const label = `mermaid block #${idx + 1}`;
        if (/\bfa:fa-[\w-]+/.test(block)) {
            violations.push(`${label}: \`fa:fa-*\` icon syntax is not rendered by GitHub. Use unicode symbols or remove.`);
        }
        if (/^\s*click\s+\w+/m.test(block)) {
            violations.push(`${label}: \`click\` directives (hyperlinks) are not rendered by GitHub. Remove or move the link to surrounding markdown.`);
        }
        const labelMatches = block.match(/\[[^\]]*<(?!br\b)[^>]+>[^\]]*\]/g);
        if (labelMatches) {
            violations.push(`${label}: HTML tags other than \`<br/>\` inside node labels may not render on GitHub (found: ${labelMatches[0]}).`);
        }
        if (/&lt;|&gt;/.test(block)) {
            violations.push(`${label}: HTML entities \`&lt;\`/\`&gt;\` get decoded to \`<\`/\`>\` and break GitHub Mermaid (it parses them as HTML). Spell out as words or use \`\\<\` / \`\\>\`.`);
        }
        const sequenceMessageBareLt = block.match(/^[ \t]*\w[\w ]*\s*-+>+\s*\w[\w ]*\s*:[^\n]*[^\\:]<(?!-|\|)/m);
        if (sequenceMessageBareLt) {
            violations.push(`${label}: bare \`<\` inside a sequenceDiagram message body breaks GitHub Mermaid. Spell out (\`under\`, \`less than\`) or escape as \`\\<\`.`);
        }
    });
    return violations;
}

function validateClosesSyntactic(content) {
    const violations = [];
    const matches = [...content.matchAll(CLOSES_LINE_RE)];
    matches.forEach((m, idx) => {
        const text = m[1].trim();
        SUB_ID_RE.lastIndex = 0;
        const subIds = text.match(SUB_ID_RE) || [];
        const allPids = text.match(PID_RE) || [];
        const bareIds = allPids.filter(id => !subIds.some(s => s.startsWith(id + '.')));
        if (allPids.length === 0 && subIds.length === 0) return;
        if (subIds.length === 0) {
            violations.push(`**Closes:** line #${idx + 1} contains no sub-IDs (expected like "TRAY-42.1, TRAY-42.2"). Got: ${JSON.stringify(text)}`);
        }
        if (bareIds.length > 0) {
            violations.push(`**Closes:** line #${idx + 1} references bare PID(s) ${bareIds.join(', ')}; use sub-IDs like "${bareIds[0]}.1" instead.`);
        }
    });
    return violations;
}

function validateFullAdr(content, basename) {
    const violations = [];
    const fnMatch = basename.match(ADR_FILENAME_RE);
    if (!fnMatch) {
        violations.push(`filename "${basename}" must match "<PID>-<slug>.md" (e.g. "TRAY-42-fold-installs.md")`);
        return violations;
    }
    const adrPid = fnMatch[1];

    if (!PROBLEM_HEADER_RE.test(content)) violations.push('missing "## Problem" section');
    if (!PROPOSALS_HEADER_RE.test(content)) violations.push('missing "## Proposals" section');

    const mermaidBlocks = content.match(MERMAID_BLOCK_RE) || [];
    if (mermaidBlocks.length === 0) {
        violations.push('no ```mermaid``` blocks found; an ADR must include at least one diagram');
    }

    const { rows, present } = findSmellTable(content);
    const subIds = new Set();
    if (present) {
        rows.forEach((cells, rowIdx) => {
            const idCell = cells[0];
            const subMatch = idCell && idCell.match(/^([A-Z][A-Z0-9]*-\d+)\.(\d+)$/);
            if (!subMatch) {
                violations.push(`smell table row ${rowIdx + 1}: first cell "${idCell}" must be a sub-ID like "${adrPid}.1"`);
                return;
            }
            const fullId = `${subMatch[1]}.${subMatch[2]}`;
            if (subMatch[1] !== adrPid) {
                violations.push(`smell table row ${rowIdx + 1}: sub-ID "${fullId}" does not start with this ADR's PID "${adrPid}."`);
            }
            subIds.add(fullId);
        });
    }

    const proposalsIdx = content.search(PROPOSALS_HEADER_RE);
    if (proposalsIdx !== -1) {
        const proposalsBlock = content.slice(proposalsIdx);
        const closesMatches = [...proposalsBlock.matchAll(CLOSES_LINE_RE)];
        closesMatches.forEach((m, idx) => {
            SUB_ID_RE.lastIndex = 0;
            const ids = m[1].match(SUB_ID_RE) || [];
            if (ids.length === 0) {
                violations.push(`proposal **Closes:** line #${idx + 1} references no sub-IDs (expected like "${adrPid}.1")`);
                return;
            }
            for (const id of ids) {
                if (!subIds.has(id)) {
                    violations.push(`proposal **Closes:** line #${idx + 1} references "${id}" but no smell-table row with that sub-ID exists in this ADR`);
                }
            }
        });
    }

    const proposalsBlock = content.split(PROPOSALS_HEADER_RE).slice(1).join('## Proposals');
    if (proposalsBlock) {
        const proposalHeadings = [...proposalsBlock.matchAll(PROPOSAL_SUB_RE)];
        if (proposalHeadings.length === 0) {
            violations.push('no proposal subheadings ("### ...") found under ## Proposals');
        }
        proposalHeadings.forEach(([_, heading]) => {
            if (!COST_BADGE_RE.test(heading)) {
                violations.push(`proposal "### ${heading.trim()}" missing cost badge \`[cheap|medium|heavy]\``);
            }
        });
    }

    return violations;
}

function validate(tool, input, payload) {
    const filePath = input.file_path || input.notebook_path || '';
    if (!filePath || !ADR_PATH_RE.test(filePath)) return [];
    const basename = path.basename(filePath);
    const newContent = extractNewContent(tool, input);
    if (!newContent) return [];
    const isFullDoc = tool === 'Write';
    const violations = [];
    violations.push(...validateMermaidCompat(newContent));
    violations.push(...validateClosesSyntactic(newContent));
    if (isFullDoc) {
        violations.push(...validateFullAdr(newContent, basename));
    }
    return violations;
}

function block(filePath, violations) {
    process.stderr.write(`arch-pathways ADR violation in ${filePath}:

${violations.map(v => `  - ${v}`).join('\n')}

ADR contract (docs/adr/<PID>-<slug>.md):
  - filename matches "<PID>-<slug>.md" (e.g. TRAY-42-fold-installs.md)
  - "## Problem" and "## Proposals" sections both present
  - at least one \`\`\`mermaid block
  - smell table rows use sub-IDs "<PID>.N" (e.g. TRAY-42.1, TRAY-42.2)
  - **Closes:** lines reference only sub-IDs declared in the same ADR
  - each "### <proposal>" heading carries \`[cheap|medium|heavy]\`
  - mermaid blocks avoid GitHub-incompat features: \`fa:\` icons, \`click\` directives, HTML inside labels except <br/>

See template.adr.md for the canonical shape.

Bypass for one edit:
  touch .claude/bypass-arch-pathways
`);
}

function main() {
    const raw = readStdin().trim();
    if (!raw) return 0;
    let payload;
    try { payload = JSON.parse(raw); } catch { return 0; }
    const tool = payload.tool_name || payload.tool || '';
    if (!INSPECTED_TOOLS.has(tool)) return 0;
    const input = payload.tool_input || {};
    const filePath = input.file_path || input.notebook_path || '';
    if (!ADR_PATH_RE.test(filePath)) return 0;
    const cwd = payload.cwd || process.cwd();
    if (consumeBypass(cwd)) return 0;
    const violations = validate(tool, input, payload);
    if (violations.length > 0) {
        block(filePath, violations);
        return 2;
    }
    return 0;
}

if (require.main === module) {
    process.exit(main());
}

module.exports = {
    validate,
    validateFullAdr,
    validateMermaidCompat,
    validateClosesSyntactic,
    findSmellTable,
};
