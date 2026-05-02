#!/usr/bin/env node
/*
 * SubagentStop hook: after a qol-host agent finishes, ask Claude (Opus, via
 * the local `claude` CLI so no API key is required) to propose durable
 * lessons for MEMORY.md based on the transcript. Append + auto-commit any
 * accepted bullets.
 *
 * Runs headlessly. All errors are silent — a failing hook must never block
 * the user's session.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ELIGIBLE_AGENTS = new Set([
    'qol-tray-frontend',
    'qol-tray-backend',
    'qol-host:qol-tray-frontend',
    'qol-host:qol-tray-backend',
]);

const TRANSCRIPT_BYTE_CAP = 120_000;
const MEMORY_LINE_CAP = 200;
const MAX_RESPONSE_BYTES = 1500;
const CLI_TIMEOUT_SECONDS = 120;

const PROMPT_HEADER = `You are harvesting durable lessons from a Claude Code subagent run for the agent's persistent MEMORY.md. The agent WILL see this memory on its next run in a fresh context — your job is to make sure the things that surprised it this time don't surprise it again.`;

const PROMPT_RULES = [
    "Scan the transcript for signals worth remembering, then emit 0-3 bullets. Bias toward emitting — a mediocre bullet is better than losing a real lesson. Filter the output yourself; don't refuse the whole set because one candidate is borderline.",
    '',
    'STRONG SIGNALS (emit these):',
    "- User corrections: 'no', 'stop doing X', 'I told you already', 'why did you' — the correction rule itself is gold.",
    "- User preferences expressed with reasons: 'we do X because Y', 'always', 'never', 'ask first before'.",
    '- Gotchas the agent discovered the hard way: CSS transform breaks getBoundingClientRect, ResizeObserver doesn\'t fire on transformed parents, bash 3 array-expansion under set -u, hook dir name vs agent dir name, etc. Non-obvious cross-component coupling.',
    "- Repeat-offender failure modes: 'the agent tried N before realizing M'.",
    '- Tool/CLI quirks that cost the agent time: flag that doesn\'t exist on macOS, subcommand that silently swallows errors.',
    '',
    'WEAK SIGNALS (skip these):',
    '- Descriptions of what the agent built this session (that\'s in the PR/commit).',
    '- File paths, line numbers, specific function names (they rot).',
    '- Things already in existing_memory (verbatim or paraphrased).',
    '- Generic best-practice platitudes the agent would know anyway.',
    '',
    'FORMAT: markdown bullets starting with \'- \'. Each bullet ≤150 chars. Lead with the rule, then a short \'because …\' clause if the reason matters. No preamble, no headings, no trailing prose.',
    '',
    'If the transcript genuinely contains zero durable signals, output the single word NONE. But do not output NONE just because each candidate has a minor flaw — emit the best 1-3 you can.',
    '',
    'Output now.',
].join('\n');

const STOP_WORDS = new Set([
    'always', 'never', 'should', 'would', 'could', 'really', 'still', 'plugin', 'plugins',
]);

function readStdin() {
    try {
        return fs.readFileSync(0, 'utf8');
    } catch {
        return '';
    }
}

function log(msg) {
    process.stderr.write(`[reflect-agent] ${msg}\n`);
}

function readTranscriptTail(filePath, byteCap) {
    if (!filePath || !fs.existsSync(filePath)) return '';
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size === 0) return '';
    const fd = fs.openSync(filePath, 'r');
    try {
        const start = Math.max(0, stat.size - byteCap);
        const len = stat.size - start;
        const buf = Buffer.alloc(len);
        fs.readSync(fd, buf, 0, len, start);
        return buf.toString('utf8');
    } finally {
        fs.closeSync(fd);
    }
}

function isCliTruncation(text) {
    if (!text) return false;
    const t = text.toLowerCase();
    return (
        t.startsWith('prompt is too long') ||
        t.includes('prompt is too long') ||
        t.includes('maximum context length')
    );
}

function isCliError(text) {
    if (!text) return false;
    return /^(error:|invalid|api error)/i.test(text);
}

function extractBullets(response) {
    if (!response) return '';
    return response
        .split(/\r?\n/)
        .filter(line => /^\s*-\s/.test(line))
        .join('\n');
}

function normalizeForDedup(text) {
    return text
        .toLowerCase()
        .replace(/[^a-z0-9 ]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function isParaphraseOfExisting(line, memoryNorm) {
    const lineNorm = normalizeForDedup(line);
    let total = 0;
    let hits = 0;
    const memoryPadded = ` ${memoryNorm} `;
    for (const word of lineNorm.split(' ')) {
        if (word.length < 5) continue;
        if (STOP_WORDS.has(word)) continue;
        total++;
        if (memoryPadded.includes(` ${word} `)) hits++;
    }
    return total >= 4 && (hits * 100) / total >= 60;
}

function filterAgainstExisting(bullets, memoryContent) {
    const memoryNorm = normalizeForDedup(memoryContent || '');
    const out = [];
    for (const line of bullets.split(/\r?\n/)) {
        if (!line.trim()) continue;
        const body = line.replace(/^\s*-\s*/, '').trim();
        if (!body) continue;
        if (isParaphraseOfExisting(body, memoryNorm)) continue;
        out.push(line);
    }
    return out.join('\n');
}

function truncateToLastN(content, n) {
    const lines = content.split(/\r?\n/);
    if (lines.length <= n) return content;
    return lines.slice(lines.length - n).join('\n');
}

function buildPrompt({ agentType, existingMemory, transcript }) {
    const memoryBlock = existingMemory && existingMemory.trim() ? existingMemory : '(empty)';
    return `${PROMPT_HEADER}\n\nThe agent ran as: ${agentType}\n\n<existing_memory>\n${memoryBlock}\n</existing_memory>\n\n<transcript_tail>\n${transcript}\n</transcript_tail>\n\n${PROMPT_RULES}\n`;
}

function runClaude(prompt) {
    const args = [
        '-p',
        '--model',
        'claude-opus-4-7',
        '--permission-mode',
        'bypassPermissions',
    ];
    const wrapped = wrapWithTimeout('claude', args);
    const r = spawnSync(wrapped.cmd, wrapped.args, {
        input: prompt,
        encoding: 'utf8',
    });
    return {
        stdout: (r.stdout || '').replace(/[ \t]+$/gm, '').trim(),
        stderr: (r.stderr || '').replace(/\n+/g, ' ').slice(0, 400),
    };
}

function wrapWithTimeout(cmd, args) {
    if (which('timeout')) return { cmd: 'timeout', args: [String(CLI_TIMEOUT_SECONDS), cmd, ...args] };
    if (which('gtimeout')) return { cmd: 'gtimeout', args: [String(CLI_TIMEOUT_SECONDS), cmd, ...args] };
    return { cmd, args };
}

function which(bin) {
    const r = spawnSync('command', ['-v', bin], { encoding: 'utf8', shell: '/bin/sh' });
    return r.status === 0 && (r.stdout || '').trim() !== '';
}

function ensureMemoryDir(memoryDir, memoryFile) {
    fs.mkdirSync(memoryDir, { recursive: true });
    if (!fs.existsSync(memoryFile)) fs.writeFileSync(memoryFile, '');
}

function appendToMemory(memoryFile, dateStamp, bullets) {
    const block = `\n## ${dateStamp}\n${bullets}\n`;
    fs.appendFileSync(memoryFile, block);
    const truncated = truncateToLastN(fs.readFileSync(memoryFile, 'utf8'), MEMORY_LINE_CAP);
    fs.writeFileSync(memoryFile, truncated);
}

function commitMemory(memoryDir, memoryFile, agentDirName) {
    const repoRoot = spawnSync('git', ['-C', memoryDir, 'rev-parse', '--show-toplevel'], {
        encoding: 'utf8',
    });
    if (repoRoot.status !== 0) return;
    const root = (repoRoot.stdout || '').trim();
    if (!root) return;
    spawnSync('git', ['-C', root, 'add', memoryFile], { stdio: 'ignore' });
    spawnSync(
        'git',
        [
            '-C',
            root,
            '-c',
            'commit.gpgsign=false',
            'commit',
            '--only',
            memoryFile,
            '-m',
            `agent-memory(${agentDirName}): auto-append lessons`,
        ],
        { stdio: 'ignore' },
    );
}

function utcDateStamp() {
    return new Date().toISOString().slice(0, 10);
}

function utcTimestamp() {
    return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function trace(traceFile, msg) {
    try {
        fs.appendFileSync(traceFile, `[${utcTimestamp()}] ${msg}\n`);
    } catch {
        // ignore
    }
}

function main() {
    const raw = readStdin();
    if (!raw) return 0;

    let payload;
    try {
        payload = JSON.parse(raw);
    } catch {
        return 0;
    }

    if (!which('claude')) {
        log('claude CLI missing — skipping');
        return 0;
    }

    const agentType = payload.agent_type || '';
    const transcriptPath = payload.agent_transcript_path || payload.transcript_path || '';
    const cwd = payload.cwd || process.cwd();

    if (!ELIGIBLE_AGENTS.has(agentType)) return 0;

    if (!transcriptPath || !fs.existsSync(transcriptPath)) {
        log(`no transcript at '${transcriptPath}'`);
        return 0;
    }

    const agentDirName = agentType.replace(/:/g, '-');
    const memoryDir = path.join(cwd, '.claude', 'agent-memory', agentDirName);
    const memoryFile = path.join(memoryDir, 'MEMORY.md');
    const traceFile = path.join(memoryDir, '.reflect-last.log');
    ensureMemoryDir(memoryDir, memoryFile);
    trace(traceFile, `fired for agent_type=${agentType} dir=${agentDirName}`);

    let transcriptTail = readTranscriptTail(transcriptPath, TRANSCRIPT_BYTE_CAP);
    if (!transcriptTail) return 0;

    const existingMemory = fs.readFileSync(memoryFile, 'utf8');
    let prompt = buildPrompt({ agentType, existingMemory, transcript: transcriptTail });
    let result = runClaude(prompt);

    if (isCliTruncation(result.stdout)) {
        trace(traceFile, 'cli truncation on first attempt; retrying with half transcript');
        transcriptTail = transcriptTail.slice(transcriptTail.length / 2);
        prompt = buildPrompt({ agentType, existingMemory, transcript: transcriptTail });
        result = runClaude(prompt);
        if (isCliTruncation(result.stdout)) {
            trace(traceFile, 'cli truncation on retry too; giving up (transcript still exceeds limit)');
            return 0;
        }
    }

    if (!result.stdout) {
        trace(traceFile, `claude returned empty; stderr: ${result.stderr}`);
        return 0;
    }
    if (isCliError(result.stdout)) {
        trace(traceFile, `cli error: ${result.stdout.slice(0, 200)}`);
        return 0;
    }
    if (result.stdout === 'NONE') {
        trace(traceFile, 'claude returned NONE (no lessons proposed)');
        return 0;
    }

    const bullets = extractBullets(result.stdout);
    if (!bullets) {
        trace(
            traceFile,
            `model returned prose, not bullets (first 200 chars: ${result.stdout
                .replace(/\n/g, ' ')
                .slice(0, 200)})`,
        );
        return 0;
    }

    if (Buffer.byteLength(bullets, 'utf8') > MAX_RESPONSE_BYTES) {
        trace(traceFile, `rejected: ${Buffer.byteLength(bullets, 'utf8')} bytes exceeds ${MAX_RESPONSE_BYTES}`);
        return 0;
    }

    const filtered = filterAgainstExisting(bullets, existingMemory);
    if (!filtered) {
        trace(traceFile, 'all proposed bullets were duplicates of existing memory');
        return 0;
    }

    appendToMemory(memoryFile, utcDateStamp(), filtered);
    commitMemory(memoryDir, memoryFile, agentDirName);

    const appended = filtered.split(/\r?\n/).filter(l => /^\s*-\s/.test(l)).length;
    trace(traceFile, `appended ${appended} lesson(s) to ${memoryFile}`);
    log(`appended lessons to ${memoryFile}`);
    return 0;
}

module.exports = {
    isCliTruncation,
    isCliError,
    extractBullets,
    normalizeForDedup,
    isParaphraseOfExisting,
    filterAgainstExisting,
    truncateToLastN,
    buildPrompt,
    readTranscriptTail,
    ELIGIBLE_AGENTS,
};

if (require.main === module) {
    process.exit(main());
}
