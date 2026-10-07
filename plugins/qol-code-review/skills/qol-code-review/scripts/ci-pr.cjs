#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { save } = require('./save-review.cjs');

const SKILL = path.resolve(__dirname, '..');
const CI = path.join(SKILL, 'ci');
const CONFIG = JSON.parse(fs.readFileSync(path.join(CI, 'config.json'), 'utf8'));
const CONTEXT = '.claude-review';

function parseArgs(argv) {
    const [command, ...rest] = argv;
    const options = { command };
    for (let index = 0; index < rest.length; index += 2) {
        const flag = rest[index];
        if (!flag.startsWith('--') || rest[index + 1] === undefined) {
            throw new Error(`Expected --flag value, got ${flag}`);
        }
        options[flag.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = rest[index + 1];
    }
    return options;
}

function need(options, ...keys) {
    for (const key of keys) {
        if (!options[key]) throw new Error(`${options.command} needs --${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
    }
}

function git(args, opts = {}) {
    const result = spawnSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts });
    if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
    return result.stdout;
}

function claude(prompt, args, env = {}) {
    const result = spawnSync('claude', ['-p', prompt, '--model', CONFIG.model, '--effort', CONFIG.effort, ...args], {
        encoding: 'utf8',
        maxBuffer: 256 * 1024 * 1024,
        stdio: ['ignore', 'pipe', 'inherit'],
        env: { ...process.env, CLAUDE_CODE_SYNC_PLUGIN_INSTALL: '1', DISABLE_AUTOUPDATER: '1', ...env },
    });
    if (result.error) throw result.error;
    return result.stdout;
}

function deniedReads() {
    return ['Read(//proc/**)'];
}

function deniedWrites() {
    const paths = [path.resolve(git(['rev-parse', '--git-dir']).trim()), process.env.RUNNER_TEMP, process.env.CLAUDE_CODE_PLUGIN_SEED_DIR, process.env.CLAUDE_CONFIG_DIR].filter(Boolean);
    return paths.flatMap((dir) => [`Edit(/${path.resolve(dir)}/**)`, `Write(/${path.resolve(dir)}/**)`]);
}

function writeSettings(out) {
    const file = path.join(out, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ enabledPlugins: Object.fromEntries(CONFIG.plugins.map((id) => [id, true])) }));
    return file;
}

function writeAgents(out) {
    const agents = JSON.parse(fs.readFileSync(path.join(CI, 'agents.json'), 'utf8'));
    for (const agent of Object.values(agents)) Object.assign(agent, { model: CONFIG.model, effort: CONFIG.effort });
    const file = path.join(out, 'agents.json');
    fs.writeFileSync(file, JSON.stringify(agents));
    return file;
}

function prepareContext(options) {
    fs.mkdirSync(CONTEXT, { recursive: true });
    fs.appendFileSync(git(['rev-parse', '--git-path', 'info/exclude']).trim(), `\n/${CONTEXT}/\n`);
    fs.cpSync(path.join(SKILL, 'references'), path.join(CONTEXT, 'references'), { recursive: true });
    fs.writeFileSync(path.join(CONTEXT, 'pr.diff'), git(['diff', options.base, options.head]));
    const detector = spawnSync('node', [path.join(__dirname, 'shallow-wrappers.cjs'), '--root', '.', '--diff', path.join(CONTEXT, 'pr.diff'), '--json', path.join(CONTEXT, 'shallow-wrappers.json')], { encoding: 'utf8' });
    if (detector.status !== 0) throw new Error(`shallow-wrappers failed: ${detector.stderr}`);
    fs.writeFileSync(path.join(CONTEXT, 'shallow-wrappers.txt'), detector.stdout);
}

function reviewPrompt(options) {
    return [
        `/qol-code-review:qol-code-review Review pull request #${options.pr} of this repository.`,
        '',
        `- Checkout: ${process.cwd()}, the merge of the pull request into its base. Git history is not available.`,
        `- PR diff: ${CONTEXT}/pr.diff`,
        `- Shallow-wrapper detector output, already run on that diff: ${CONTEXT}/shallow-wrappers.txt and ${CONTEXT}/shallow-wrappers.json`,
        `- Review checklists: ${CONTEXT}/references/review-checklists.md`,
        `- Title: ${options.title || ''}`,
        '- Description:',
        String(options.body || '').slice(0, 20000).split('\n').map((line) => `  > ${line}`).join('\n'),
        '',
        fs.readFileSync(path.join(CI, 'review-prompt.md'), 'utf8'),
    ].join('\n');
}

function reviewReply(stream, key = 'verdict') {
    const events = String(stream || '').split('\n').filter((line) => line.trim()).flatMap((line) => {
        try {
            return [JSON.parse(line)];
        } catch {
            return [];
        }
    });
    const result = events.filter((event) => event.type === 'result').pop() || {};
    if (result.subtype !== 'success' || result.is_error === true) return { result, reply: '' };
    const texts = events
        .filter((event) => event.type === 'assistant' && !event.parent_tool_use_id)
        .map((event) => (event.message?.content || []).filter((block) => block.type === 'text').map((block) => block.text).join('\n'))
        .filter((text) => text.trim());
    const review = texts.filter((text) => reviewJson(text)?.[key]).pop();
    return { result, reply: review || String(result.result || '') };
}

function lastVerdict(markdown) {
    const found = [...markdown.matchAll(/"verdict":\s*"([a-z]+)"/g)];
    return found.length ? found[found.length - 1][1] : 'unknown';
}

function review(options) {
    need(options, 'pr', 'base', 'head', 'out');
    fs.mkdirSync(options.out, { recursive: true });
    prepareContext(options);
    const raw = claude(reviewPrompt(options), [
        '--settings', writeSettings(options.out),
        '--agents', writeAgents(options.out),
        '--dangerously-skip-permissions',
        '--disallowedTools', ...CONFIG.reviewDeniedTools, ...deniedReads(),
        '--output-format', 'stream-json', '--verbose',
    ], { CLAUDE_CODE_SUBAGENT_MODEL: CONFIG.model, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' });
    fs.writeFileSync(path.join(options.out, 'stream.jsonl'), raw);
    const { result, reply } = reviewReply(raw);
    console.log(`permission denials: ${JSON.stringify(result.permission_denials || [])}`);
    if (!reply.trim()) throw new Error(`the review produced no result (${result.subtype || 'no output'})`);
    const replyFile = path.join(options.out, 'reply.md');
    fs.writeFileSync(replyFile, reply);
    const saved = save({ in: replyFile, verdict: lastVerdict(reply), slug: 'pr', outDir: options.out, runId: 'review' }, new Date(), '0000');
    console.log(`verdict: ${saved.verdict}`);
}

function changedFiles(args) {
    return git(['diff', '--no-renames', '--name-only', ...args]).split('\n').filter(Boolean);
}

function refuseOutside(files, options) {
    const allowed = new Set(changedFiles([options.base, options.head]));
    const refused = [...new Set(files)].filter((file) => file.startsWith('.github/') || !allowed.has(file));
    if (refused.length) throw new Error(`the fix touches files outside the pull request diff or under .github/: ${refused.join(', ')}`);
}

function appliedFiles(patchFile, target) {
    const index = path.join(require('node:os').tmpdir(), `ci-pr-index-${process.pid}`);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    try {
        git(['read-tree', target], { env });
        git(['apply', '--cached', patchFile], { env });
        return git(['diff', '--cached', '--no-renames', '--name-only', '-z', target], { env }).split('\0').filter(Boolean);
    } finally {
        fs.rmSync(index, { force: true });
    }
}

function checkPatch(options) {
    need(options, 'patch', 'base', 'head');
    refuseOutside(appliedFiles(options.patch, `${options.head}^2`), options);
    console.log('patch stays inside the pull request diff');
}

function fix(options) {
    need(options, 'base', 'head', 'out');
    const dir = path.join(options.out, 'fix');
    fs.mkdirSync(dir, { recursive: true });
    const reviewDir = path.join(options.out, 'review');
    const verdict = fs.existsSync(path.join(reviewDir, 'report.json')) ? JSON.parse(fs.readFileSync(path.join(reviewDir, 'report.json'), 'utf8')).status : 'missing';
    if (!CONFIG.fixVerdicts.includes(verdict)) {
        console.log(`verdict is ${verdict}, nothing to fix`);
        return;
    }
    if (git(['log', '-1', '--format=%s', `${options.head}^2`]).trim() === CONFIG.fixSubject) {
        console.log('head is the review fix commit, nothing to fix');
        return;
    }
    const prompt = `${fs.readFileSync(path.join(reviewDir, 'review.md'), 'utf8')}\n${fs.readFileSync(path.join(CI, 'fix-prompt.md'), 'utf8')}`;
    const { reply } = reviewReply(claude(prompt, [
        '--settings', writeSettings(options.out),
        '--dangerously-skip-permissions',
        '--disallowedTools', ...CONFIG.fixDeniedTools, ...deniedReads(), ...deniedWrites(),
        '--output-format', 'stream-json', '--verbose',
    ]), 'fixes');
    fs.writeFileSync(path.join(dir, 'reply.md'), reply);
    console.log(reply);
    git(['add', '-A']);
    refuseOutside(changedFiles(['--cached']), options);
    const patch = git(['diff', '--cached', '--binary', '--no-renames']);
    if (!patch) return;
    fs.writeFileSync(path.join(dir, 'fix.patch'), patch);
    fs.writeFileSync(path.join(dir, 'message.txt'), `${CONFIG.fixSubject}\n`);
    console.log(`patch: ${path.join(dir, 'fix.patch')}`);
}

function reviewJson(markdown) {
    const blocks = [...markdown.matchAll(/^```json[ \t]*\n([\s\S]*?)^```[ \t]*$/gm)];
    if (!blocks.length) return null;
    try {
        return JSON.parse(blocks[blocks.length - 1][1]);
    } catch {
        return null;
    }
}

function withoutJson(markdown) {
    return markdown.replace(/^```json[ \t]*\n[\s\S]*?^```[ \t]*$\n?/gm, '').trimEnd();
}

const VERDICTS = { pass: '✅ Pass', conditional: '⚠️ Conditional', block: '⛔ Block' };
const LANES = [['blocker', '⛔', 'Blocker'], ['high', '🔴', 'High'], ['medium', '🟠', 'Medium'], ['low', '🟡', 'Low'], ['note', '⚪', 'Note']];
const STATUS = { fixed: '✅', skipped: '⏭️' };
const DIFF_LINES = 40;
const COMMENT_LIMIT = 60000;

function fixStatuses(fixReply) {
    const listed = reviewJson(fixReply || '')?.fixes;
    if (Array.isArray(listed)) return new Map(listed.filter((f) => f && f.id).map((f) => [f.id, { status: f.status, note: f.note }]));
    const found = [...String(fixReply || '').matchAll(/([a-z][a-z-]*-\d+)\W+(fixed|skipped)\b[.,:;\s-]*(.*)$/gm)];
    return new Map(found.map(([, id, status, note]) => [id, { status, note: note.trim() }]));
}

function patchHunks(patch) {
    const hunks = [];
    let file = null;
    for (const line of String(patch || '').split('\n')) {
        const header = line.match(/^diff --git a\/.+? b\/(.+)$/);
        if (header) {
            file = header[1];
            continue;
        }
        const start = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (start && file) {
            hunks.push({ file, line: Number(start[1]), lines: [] });
            continue;
        }
        const hunk = hunks[hunks.length - 1];
        if (hunk && hunk.file === file && /^[-+ ]/.test(line) && !/^(---|\+\+\+) /.test(line)) hunk.lines.push(line);
    }
    return hunks;
}

function assignHunks(hunks, fixedFindings) {
    const byId = new Map(fixedFindings.map((f) => [f.id, []]));
    const other = [];
    for (const hunk of hunks) {
        const owners = fixedFindings.filter((f) => f.file === hunk.file);
        if (!owners.length) {
            other.push(hunk);
            continue;
        }
        const owner = owners.reduce((best, f) => (Math.abs((f.line || 0) - hunk.line) < Math.abs((best.line || 0) - hunk.line) ? f : best));
        byId.get(owner.id).push(hunk);
    }
    return { byId, other };
}

function diffBlock(hunks) {
    if (!hunks.length) return '';
    const lines = hunks.flatMap((h) => [`@@ ${h.file.split('/').pop()}:${h.line} @@`, ...h.lines]);
    const shown = lines.slice(0, DIFF_LINES);
    if (lines.length > shown.length) shown.push(`@@ ${lines.length - shown.length} more lines in the fix commit @@`);
    return ['```diff', ...shown, '```'].join('\n');
}

function renderComment({ markdown, headSha, runUrl, repoUrl, fixSha, fixOutcome, fixReply, patch, withDiffs = true }) {
    const short = (sha) => String(sha).slice(0, 7);
    const data = markdown ? reviewJson(markdown) : null;
    if (!data || !data.verdict) {
        const text = markdown && markdown.trim()
            ? `Reviewed head: ${headSha}\n\n${markdown.trim()}`
            : `## ❌ Review failed\n\nThe review of \`${short(headSha)}\` failed before it produced a result. See [the run](${runUrl}).`;
        return `${CONFIG.commentMarker}\n${text}\n`;
    }
    const seen = new Set();
    const findings = [...(data.must_fix || []), ...(data.deferred_followups || [])].filter((f) => f && f.id && !seen.has(f.id) && seen.add(f.id));
    const statuses = fixSha ? fixStatuses(fixReply) : new Map();
    const statusOf = (f) => statuses.get(f.id) || {};
    const fixed = findings.filter((f) => statusOf(f).status === 'fixed');
    const left = findings.filter((f) => statusOf(f).status !== 'fixed' && ['blocker', 'high', 'medium'].includes(f.severity));
    const { byId, other } = assignHunks(withDiffs ? patchHunks(patch) : [], fixSha ? fixed : []);
    const commit = fixSha ? `[\`${short(fixSha)}\`](${repoUrl}/commit/${fixSha})` : '';
    const counts = LANES.filter(([key]) => data.counts?.[key] > 0).map(([key]) => `${data.counts[key]} ${key}`).join(' · ') || 'no findings';
    const outcome = fixSha
        ? `${fixed.length} fixed in ${commit}, ${left.length} left for you.`
        : fixOutcome === 'failure'
            ? `Fixing failed, nothing was pushed. See [the run](${runUrl}).`
            : CONFIG.fixVerdicts.includes(data.verdict) ? `Nothing was fixed, ${left.length} left for you.` : 'Nothing to fix.';
    const where = (f) => (f.file ? `[\`${String(f.file).split('/').pop()}${f.line ? `:${f.line}` : ''}\`](${repoUrl}/blob/${headSha}/${f.file}${f.line ? `#L${f.line}` : ''}) · ` : '');
    const item = (f) => {
        const { status, note } = statusOf(f);
        const body = [`${where(f)}\`${f.id}\``, `**Action:** ${f.required_action || ''}`, note ? `**Fix:** ${note}` : ''].filter(Boolean).join('\n\n');
        const summary = `${STATUS[status] ? `${STATUS[status]} ` : ''}${String(f.title || f.required_action || f.id).replace(/\s+/g, ' ')}`;
        return [`<details><summary>${summary.replace(/</g, '&lt;')}</summary>\n\n${body}\n\n</details>`, diffBlock(byId.get(f.id) || [])];
    };
    const parts = [CONFIG.commentMarker, `## ${VERDICTS[data.verdict] || `❔ ${data.verdict}`}`, `${counts} · ${outcome}`];
    for (const [key, dot, label] of LANES) {
        const lane = findings.filter((f) => f.severity === key);
        if (lane.length) parts.push(`#### ${dot} ${label}`, ...lane.flatMap(item));
    }
    if (other.length) parts.push('#### Other changes in the fix', diffBlock(other));
    parts.push(`<details><summary>Full review</summary>\n\n${withoutJson(markdown)}\n\n</details>`);
    parts.push(`<sub>qol-code-review · ${CONFIG.model} · head \`${short(headSha)}\` · [run](${runUrl})</sub>`);
    const body = `${parts.filter(Boolean).join('\n\n')}\n`;
    return body.length > COMMENT_LIMIT && withDiffs ? renderComment({ markdown, headSha, runUrl, repoUrl, fixSha, fixOutcome, fixReply, patch, withDiffs: false }) : body;
}

function comment(options) {
    need(options, 'out', 'headSha', 'runUrl', 'repoUrl');
    const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    const markdown = read(path.join(options.out, 'review', 'review.md')) || read(path.join(options.out, 'reply.md'));
    const body = renderComment({
        markdown,
        headSha: options.headSha,
        runUrl: options.runUrl,
        repoUrl: options.repoUrl,
        fixSha: options.fixSha,
        fixOutcome: options.fixOutcome,
        fixReply: read(path.join(options.out, 'fix', 'reply.md')),
        patch: read(path.join(options.out, 'fix', 'fix.patch')),
    });
    const file = path.join(options.out, 'comment.md');
    fs.writeFileSync(file, body);
    console.log(file);
    if (!markdown.trim()) process.exitCode = 1;
}

function run(argv) {
    const options = parseArgs(argv);
    const commands = {
        plugins: () => console.log(CONFIG.plugins.join('\n')),
        marker: () => console.log(CONFIG.commentMarker),
        review,
        fix,
        'check-patch': checkPatch,
        comment,
    };
    if (!commands[options.command]) throw new Error(`usage: ci-pr.cjs ${Object.keys(commands).join('|')} [--flag value ...]`);
    commands[options.command](options);
}

if (require.main === module) {
    try {
        run(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = { reviewReply, appliedFiles, refuseOutside, deniedReads, deniedWrites, parseArgs, lastVerdict, reviewJson, withoutJson, fixStatuses, patchHunks, renderComment, CONFIG };
