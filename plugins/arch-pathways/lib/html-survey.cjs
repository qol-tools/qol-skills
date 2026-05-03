'use strict';

const SECTION_RE = /<section\s+class="page"\s+id="([a-zA-Z0-9_-]+)"[\s\S]*?<\/section>/g;
const H2_RE = /<h2\b[^>]*>([\s\S]*?)<\/h2>/i;
const PROBLEM_HEADER_RE = /<h3\b[^>]*>\s*Problem\s*<\/h3>/i;
const PROPOSALS_HEADER_RE = /<h3\b[^>]*>\s*Proposals\s*<\/h3>/i;
const MERMAID_RE = /<pre\s+class="mermaid"[^>]*>([\s\S]*?)<\/pre>/gi;
const TABLE_RE = /<table[\s\S]*?<\/table>/gi;
const TR_RE = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
const CELL_RE = /<(?:th|td)\b[^>]*>([\s\S]*?)<\/(?:th|td)>/gi;
const PROPOSAL_OPEN_RE = /<div\s+class="proposal"[^>]*>/gi;
const H4_RE = /<h4\b[^>]*>([\s\S]*?)<\/h4>/i;
const BADGE_RE = /<span\s+class="badge\s+(cheap|medium|heavy)"[^>]*>[\s\S]*?<\/span>/i;
const TRADEOFFS_OPEN_RE = /<div\s+class="tradeoffs"[^>]*>/i;
const CLOSES_RE = /<p\s+class="closes"[^>]*>([\s\S]*?)<\/p>/i;
const PARAGRAPH_RE = /<p\b(?![^>]*\bclass="closes")[^>]*>([\s\S]*?)<\/p>/gi;
const PID_RE = /\b([A-Z][A-Z0-9_]*)-(\d+)\b/g;
const TRADEOFF_DIV_RE = /<div[^>]*>([\s\S]*?)<\/div>/gi;
const H5_HEADER_RE = /<h5\b[^>]*>\s*(pros|cons)\s*<\/h5>/i;
const H5_STRIP_RE = /<h5\b[^>]*>[\s\S]*?<\/h5>/i;

function stripHtml(s) {
    return s
        .replace(/<br\s*\/?>(?!\s*$)/gi, '\n')
        .replace(/<[^>]+>/g, '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&mdash;/g, '—')
        .replace(/&ndash;/g, '–')
        .replace(/&rarr;/g, '→')
        .replace(/&hellip;/g, '…')
        .replace(/&nbsp;/g, ' ')
        .trim();
}

function unindentMermaid(body) {
    const lines = body.split('\n');
    while (lines.length && !lines[0].trim()) lines.shift();
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    if (lines.length === 0) return '';
    const indents = lines
        .filter(l => l.trim())
        .map(l => l.match(/^\s*/)[0].length);
    const minIndent = Math.min(...indents);
    return lines.map(l => l.slice(minIndent)).join('\n');
}

function parseAreas(html) {
    const areas = new Map();
    for (const m of html.matchAll(SECTION_RE)) {
        areas.set(m[1], m[0]);
    }
    return areas;
}

function parseSection(sectionHtml) {
    const titleMatch = sectionHtml.match(H2_RE);
    const title = titleMatch ? stripHtml(titleMatch[1]) : '';
    const probIdx = sectionHtml.search(PROBLEM_HEADER_RE);
    const propIdx = sectionHtml.search(PROPOSALS_HEADER_RE);
    const endIdx = sectionHtml.lastIndexOf('</section>');
    const problem = probIdx === -1 ? '' :
        sectionHtml.slice(probIdx, propIdx === -1 ? endIdx : propIdx);
    const proposals = propIdx === -1 ? '' :
        sectionHtml.slice(propIdx, endIdx === -1 ? sectionHtml.length : endIdx);
    return { title, problem, proposals };
}

function parseSmellTable(problemHtml) {
    const tables = problemHtml.match(TABLE_RE) || [];
    const smellTable = tables.find(t => /<th[^>]*>\s*Smell\s*<\/th>/i.test(t));
    if (!smellTable) return [];
    const rows = [];
    for (const m of smellTable.matchAll(TR_RE)) {
        const inner = m[1];
        if (/<th\b/i.test(inner)) continue;
        const cells = [];
        for (const c of inner.matchAll(CELL_RE)) cells.push(stripHtml(c[1]));
        if (cells.length > 0) rows.push(cells);
    }
    return rows;
}

function parseMermaidBlocks(html) {
    const blocks = [];
    for (const m of html.matchAll(MERMAID_RE)) {
        blocks.push(unindentMermaid(m[1]));
    }
    return blocks;
}

function splitProposalBlocks(proposalsHtml) {
    const positions = [];
    for (const m of proposalsHtml.matchAll(PROPOSAL_OPEN_RE)) positions.push(m.index);
    const blocks = [];
    for (let i = 0; i < positions.length; i++) {
        const start = positions[i];
        const end = i + 1 < positions.length ? positions[i + 1] : proposalsHtml.length;
        blocks.push(proposalsHtml.slice(start, end));
    }
    return blocks;
}

function extractBalanced(html, openRe) {
    const m = html.match(openRe);
    if (!m) return null;
    const start = html.indexOf(m[0]);
    let i = start + m[0].length;
    let depth = 1;
    while (i < html.length && depth > 0) {
        const open = html.indexOf('<div', i);
        const close = html.indexOf('</div>', i);
        if (close === -1) return null;
        if (open !== -1 && open < close) {
            depth++;
            const closeBracket = html.indexOf('>', open);
            if (closeBracket === -1) return null;
            i = closeBracket + 1;
        } else {
            depth--;
            i = close + '</div>'.length;
        }
    }
    return { start, end: i, inner: html.slice(start + m[0].length, i - '</div>'.length) };
}

function findTradeoffs(block) {
    const found = extractBalanced(block, TRADEOFFS_OPEN_RE);
    return found ? found.inner : null;
}

function splitTradeoffCells(tradeoffsInner) {
    let pros = [], cons = [];
    for (const m of tradeoffsInner.matchAll(TRADEOFF_DIV_RE)) {
        const inner = m[1];
        const headerMatch = inner.match(H5_HEADER_RE);
        if (!headerMatch) continue;
        const kind = headerMatch[1].toLowerCase();
        const body = stripHtml(inner.replace(H5_STRIP_RE, '')).trim();
        const items = body.split(/\n+/).map(s => s.trim()).filter(Boolean);
        if (kind === 'pros') pros = items;
        else cons = items;
    }
    return { pros, cons };
}

function extractDescription(proposalBlock) {
    let stripped = proposalBlock
        .replace(H4_RE, '')
        .replace(MERMAID_RE, '')
        .replace(CLOSES_RE, '');
    const tradeoffs = extractBalanced(stripped, TRADEOFFS_OPEN_RE);
    if (tradeoffs) stripped = stripped.slice(0, tradeoffs.start) + stripped.slice(tradeoffs.end);
    const paragraphs = [];
    for (const m of stripped.matchAll(PARAGRAPH_RE)) {
        const text = stripHtml(m[1]).trim();
        if (text) paragraphs.push(text);
    }
    return paragraphs.join('\n\n');
}

function parseProposalCards(proposalsHtml) {
    const cards = [];
    for (const block of splitProposalBlocks(proposalsHtml)) {
        const titleMatch = block.match(H4_RE);
        let titleRaw = titleMatch ? titleMatch[1] : '';
        const badgeMatch = titleRaw.match(BADGE_RE);
        const cost = badgeMatch ? badgeMatch[1] : null;
        const titleText = stripHtml(titleRaw.replace(BADGE_RE, ''));
        const mermaid = parseMermaidBlocks(block);
        const tradeoffsInner = findTradeoffs(block);
        let pros = [], cons = [];
        if (tradeoffsInner) {
            ({ pros, cons } = splitTradeoffCells(tradeoffsInner));
        }
        const closesMatch = block.match(CLOSES_RE);
        const closes = closesMatch
            ? (closesMatch[1].match(PID_RE) || [])
            : [];
        const description = extractDescription(block);
        cards.push({ title: titleText, cost, description, mermaid, pros, cons, closes });
    }
    return cards;
}

function buildPidMap(rows, targetPid) {
    const map = new Map();
    let counter = 1;
    for (const row of rows) {
        const cell = row[0] || '';
        const m = cell.match(/^([A-Z][A-Z0-9_]*-\d+)$/);
        if (m) map.set(m[1], `${targetPid}.${counter++}`);
    }
    return map;
}

function rewritePidsInString(s, pidMap) {
    return s.replace(PID_RE, (full, prefix, num) => {
        const oldPid = `${prefix}-${num}`;
        return pidMap.get(oldPid) || full;
    });
}

module.exports = {
    parseAreas,
    parseSection,
    parseSmellTable,
    parseMermaidBlocks,
    parseProposalCards,
    splitProposalBlocks,
    splitTradeoffCells,
    findTradeoffs,
    extractBalanced,
    extractDescription,
    buildPidMap,
    rewritePidsInString,
    stripHtml,
    unindentMermaid,
};
