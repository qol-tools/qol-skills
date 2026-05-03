'use strict';

const fs = require('node:fs');
const path = require('node:path');

const PREFIXES_PATH = path.join(__dirname, 'prefixes.json');

const PID_RE = /^([A-Z][A-Z0-9]*)-(\d+)$/;
const BRANCH_RE = /^([a-z][a-z0-9]*)-(\d+)-([a-z0-9]+(?:-[a-z0-9]+)*)$/;
const PR_TITLE_RE = /^([A-Z][A-Z0-9]*)-(\d+) (.+)$/;

const SLUG_MAX = 50;

let prefixCache = null;

function loadPrefixes() {
    if (prefixCache) return prefixCache;
    const raw = fs.readFileSync(PREFIXES_PATH, 'utf8');
    const repoToPrefix = JSON.parse(raw);
    const prefixToRepo = {};
    for (const [repo, prefix] of Object.entries(repoToPrefix)) {
        if (prefixToRepo[prefix]) {
            throw new Error(
                `prefixes.json: prefix "${prefix}" is mapped to both "${prefixToRepo[prefix]}" and "${repo}"`,
            );
        }
        prefixToRepo[prefix] = repo;
    }
    prefixCache = { repoToPrefix, prefixToRepo };
    return prefixCache;
}

function _resetPrefixCache() {
    prefixCache = null;
}

function prefixForRepo(repo) {
    const { repoToPrefix } = loadPrefixes();
    const prefix = repoToPrefix[repo];
    if (!prefix) {
        throw new Error(
            `unknown repo "${repo}". Add it to lib/prefixes.json with an uppercase prefix.`,
        );
    }
    return prefix;
}

function repoForPrefix(prefix) {
    const { prefixToRepo } = loadPrefixes();
    const repo = prefixToRepo[prefix];
    if (!repo) {
        throw new Error(
            `unknown prefix "${prefix}". Add it to lib/prefixes.json mapped to a repo name.`,
        );
    }
    return repo;
}

function parsePid(s) {
    const m = String(s).match(PID_RE);
    if (!m) return null;
    return { prefix: m[1], number: Number(m[2]) };
}

function formatPid(prefix, number) {
    if (typeof prefix !== 'string' || !/^[A-Z][A-Z0-9]*$/.test(prefix)) {
        throw new Error(`invalid prefix "${prefix}" (must be uppercase letters/digits, leading letter)`);
    }
    if (!Number.isInteger(number) || number <= 0) {
        throw new Error(`invalid issue number "${number}" (must be positive integer)`);
    }
    return `${prefix}-${number}`;
}

function parseBranchName(s) {
    const m = String(s).match(BRANCH_RE);
    if (!m) return null;
    return { prefix: m[1].toUpperCase(), number: Number(m[2]), slug: m[3] };
}

function formatBranchName(prefix, number, slug) {
    formatPid(prefix, number);
    if (!isValidSlug(slug)) {
        throw new Error(`invalid slug "${slug}" (must be lowercase kebab, no leading/trailing/double dashes)`);
    }
    return `${prefix.toLowerCase()}-${number}-${slug}`;
}

function parsePrTitle(s) {
    const m = String(s).match(PR_TITLE_RE);
    if (!m) return null;
    const title = m[3].trim();
    if (!title) return null;
    return { pid: `${m[1]}-${m[2]}`, prefix: m[1], number: Number(m[2]), title };
}

function formatPrTitle(prefix, number, title) {
    const pid = formatPid(prefix, number);
    const trimmed = String(title).trim();
    if (!trimmed) throw new Error('PR title cannot be empty');
    return `${pid} ${trimmed}`;
}

function slugify(title) {
    const ascii = String(title)
        .normalize('NFKD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    if (!ascii) throw new Error(`title "${title}" produces empty slug`);
    return ascii.slice(0, SLUG_MAX).replace(/-+$/g, '');
}

function isValidSlug(s) {
    return typeof s === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(s);
}

const TITLE_CASE_LOWER = new Set([
    'a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'in', 'nor', 'of',
    'on', 'or', 'per', 'the', 'to', 'up', 'via', 'vs',
]);

function titleCaseFromSlug(slug) {
    if (!isValidSlug(slug)) {
        throw new Error(`invalid slug "${slug}"`);
    }
    const words = slug.split('-');
    return words
        .map((word, idx) => {
            const isFirstOrLast = idx === 0 || idx === words.length - 1;
            if (!isFirstOrLast && TITLE_CASE_LOWER.has(word)) return word;
            return word.charAt(0).toUpperCase() + word.slice(1);
        })
        .join(' ');
}

function adrPath(repoRoot, pid, slug) {
    const parsed = parsePid(pid);
    if (!parsed) throw new Error(`invalid pid "${pid}"`);
    if (!isValidSlug(slug)) throw new Error(`invalid slug "${slug}"`);
    return path.join(repoRoot, 'docs', 'adr', `${pid}-${slug}.md`);
}

function worktreePath(workspaceRoot, repo, branchName) {
    prefixForRepo(repo);
    if (!parseBranchName(branchName)) {
        throw new Error(`invalid branch name "${branchName}"`);
    }
    return path.join(workspaceRoot, 'worktrees', repo, branchName);
}

function pidFromBranch(branchName) {
    const parsed = parseBranchName(branchName);
    if (!parsed) return null;
    return formatPid(parsed.prefix, parsed.number);
}

function branchFromPid(pid, slug) {
    const parsed = parsePid(pid);
    if (!parsed) throw new Error(`invalid pid "${pid}"`);
    return formatBranchName(parsed.prefix, parsed.number, slug);
}

module.exports = {
    PID_RE,
    BRANCH_RE,
    PR_TITLE_RE,
    SLUG_MAX,
    loadPrefixes,
    _resetPrefixCache,
    prefixForRepo,
    repoForPrefix,
    parsePid,
    formatPid,
    parseBranchName,
    formatBranchName,
    parsePrTitle,
    formatPrTitle,
    slugify,
    isValidSlug,
    titleCaseFromSlug,
    adrPath,
    worktreePath,
    pidFromBranch,
    branchFromPid,
};
