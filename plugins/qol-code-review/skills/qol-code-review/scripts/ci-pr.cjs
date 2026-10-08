#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const readline = require('node:readline');
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

const TOOL_TEXT = 200;

function oneLine(value) {
    const text = (typeof value === 'string' ? value : JSON.stringify(value) ?? '').replace(/\s+/g, ' ').trim();
    return text.length > TOOL_TEXT ? `${text.slice(0, TOOL_TEXT)}...` : text;
}

function narrate(line) {
    let event;
    try {
        event = JSON.parse(line);
    } catch {
        return [line];
    }
    const prefix = event.parent_tool_use_id ? '  [agent] ' : '';
    const blocks = Array.isArray(event.message?.content) ? event.message.content : [];
    if (event.type === 'system' && event.subtype === 'init') return [`session ${event.session_id} on ${event.model}`];
    if (event.type === 'assistant') {
        return blocks.flatMap((block) => {
            if (block.type === 'text' && block.text.trim()) return block.text.trim().split('\n').map((text) => `${prefix}${text}`);
            if (block.type === 'tool_use') return [`${prefix}> ${block.name} ${oneLine(block.input)}`];
            return [];
        });
    }
    if (event.type === 'user') {
        return blocks.filter((block) => block.type === 'tool_result').map((block) => {
            const content = Array.isArray(block.content) ? block.content.map((part) => part.text || '').join(' ') : block.content;
            return `${prefix}  ${block.is_error ? 'error: ' : ''}${oneLine(content)}`;
        });
    }
    if (event.type === 'result') return [`result: ${event.subtype}, ${event.num_turns} turns, ${Math.round((event.duration_ms || 0) / 1000)} s, $${(event.total_cost_usd || 0).toFixed(2)}`];
    return [];
}

async function claude(prompt, args, { env = {}, model = CONFIG.model, effort = CONFIG.effort } = {}) {
    const child = spawn('claude', ['-p', prompt, '--model', model, '--effort', effort, ...args], {
        stdio: ['ignore', 'pipe', 'inherit'],
        env: { ...process.env, CLAUDE_CODE_SYNC_PLUGIN_INSTALL: '1', DISABLE_AUTOUPDATER: '1', ...env },
    });
    const lines = [];
    const reader = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    reader.on('line', (line) => {
        lines.push(line);
        for (const text of narrate(line)) console.log(text);
    });
    const failed = once(child, 'error').then(([error]) => {
        throw error;
    });
    await Promise.race([Promise.all([once(reader, 'close'), once(child, 'close')]), failed]);
    return lines.join('\n');
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
    options.followUp = writeFollowUp(options);
}

function writeFollowUp(options) {
    if (!isSha(options.since) || !options.previous || !fs.existsSync(options.previous)) return false;
    try {
        const files = changedFiles([options.base, options.head]);
        fs.writeFileSync(path.join(CONTEXT, 'since-last-review.diff'), git(['diff', options.since, `${options.head}^2`, '--', ...files]));
    } catch (error) {
        console.log(`full review: ${error.message}`);
        return false;
    }
    fs.copyFileSync(options.previous, path.join(CONTEXT, 'last-review.md'));
    return true;
}

function isSha(value) {
    return /^[0-9a-f]{40}$/.test(String(value || ''));
}

function sinceLines(options) {
    if (!options.followUp) return [];
    return [
        `- Changes since the last review of \`${options.since.slice(0, 7)}\`: ${CONTEXT}/since-last-review.diff`,
        `- The last review comment: ${CONTEXT}/last-review.md`,
        '- This is a follow-up review. Report a new finding only on code those changes add or alter, or on code they break. Carry every finding of the last review that the changes do not fix into this review with its id, severity, file, line and title unchanged, and drop the ones they fix. A finding the last review marked fixed stays dropped. The verdict counts the carried findings, so it is pass only when no blocker, high or medium finding is left.',
    ];
}

function reviewPrompt(options) {
    return [
        `/qol-code-review:qol-code-review Review pull request #${options.pr} of this repository.`,
        '',
        `- Checkout: ${process.cwd()}, the merge of the pull request into its base. Git history is not available.`,
        `- PR diff: ${CONTEXT}/pr.diff`,
        `- Shallow-wrapper detector output, already run on that diff: ${CONTEXT}/shallow-wrappers.txt and ${CONTEXT}/shallow-wrappers.json`,
        `- Review checklists: ${CONTEXT}/references/review-checklists.md`,
        ...sinceLines(options),
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

async function review(options) {
    need(options, 'pr', 'base', 'head', 'out');
    fs.mkdirSync(options.out, { recursive: true });
    prepareContext(options);
    const raw = await claude(reviewPrompt(options), [
        '--settings', writeSettings(options.out),
        '--agents', writeAgents(options.out),
        '--dangerously-skip-permissions',
        '--disallowedTools', ...CONFIG.reviewDeniedTools, ...deniedReads(),
        '--output-format', 'stream-json', '--verbose',
    ], { env: { CLAUDE_CODE_SUBAGENT_MODEL: CONFIG.model, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' } });
    fs.writeFileSync(path.join(options.out, 'stream.jsonl'), raw);
    const { result, reply } = reviewReply(raw);
    console.log(`permission denials: ${JSON.stringify(result.permission_denials || [])}`);
    if (!reply.trim()) throw new Error(`the review produced no result (${result.subtype || 'no output'})`);
    const replyFile = path.join(options.out, 'reply.md');
    fs.writeFileSync(replyFile, reply);
    const saved = save({ in: replyFile, verdict: lastVerdict(reply), slug: 'pr', outDir: options.out, runId: 'review' }, new Date(), '0000');
    console.log(`verdict: ${saved.verdict}`);
    if (options.followUp) fs.writeFileSync(path.join(options.out, 'review', 'since.txt'), `${options.since}\n`);
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

async function fix(options) {
    need(options, 'base', 'head', 'out');
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
    await fixSession(options, prompt, { subject: CONFIG.fixSubject });
}

async function fixSession(options, prompt, { subject, model, effort }) {
    const dir = path.join(options.out, 'fix');
    fs.mkdirSync(dir, { recursive: true });
    const { reply } = reviewReply(await claude(prompt, [
        '--settings', writeSettings(options.out),
        '--dangerously-skip-permissions',
        '--disallowedTools', ...CONFIG.fixDeniedTools, ...deniedReads(), ...deniedWrites(),
        '--output-format', 'stream-json', '--verbose',
    ], { model, effort }), 'fixes');
    fs.writeFileSync(path.join(dir, 'reply.md'), reply);
    git(['add', '-A']);
    try {
        refuseOutside(changedFiles(['--cached']), options);
    } catch (error) {
        fs.writeFileSync(path.join(dir, 'refused.txt'), `${error.message}\n`);
        console.log(error.message);
        return;
    }
    const patch = git(['diff', '--cached', '--binary', '--no-renames']);
    if (!patch) return;
    fs.writeFileSync(path.join(dir, 'fix.patch'), patch);
    fs.writeFileSync(path.join(dir, 'message.txt'), `${subject}\n`);
    console.log(`patch: ${path.join(dir, 'fix.patch')}`);
}

const QUEUE_BRANCH = /\/pr-(\d+)-[0-9a-f]{40}$/;
const LOG_LINES = 120;
const FAILURES_LIMIT = 60000;

function gh(args) {
    const call = (extra) => spawnSync('gh', ['api', ...extra, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    let result = call([]);
    if (result.status !== 0 && result.stderr.includes('--allow-escape-sequences')) result = call(['--allow-escape-sequences']);
    if (result.status !== 0) throw new Error(`gh api ${args[0]} failed: ${result.stderr}`);
    return result.stdout;
}

function logTail(log) {
    const lines = String(log || '').split('\n')
        .map((line) => line.replace(/^\uFEFF?\d{4}-\d\d-\d\dT[\d:.]+Z ?/, '').replace(/\x1b\[[0-9;]*m/g, '').trimEnd())
        .filter((line) => line.trim());
    const error = lines.findIndex((line) => line.startsWith('##[error]'));
    const step = error < 0 ? 0 : lines.slice(0, error).map((line) => line.startsWith('##[group]Run ')).lastIndexOf(true);
    return lines.slice(Math.max(0, step)).slice(-LOG_LINES).join('\n');
}

function jobErrors(annotations) {
    return annotations
        .filter((note) => note.annotation_level === 'failure' && note.message && !/^Process completed with exit code \d+\.$/.test(note.message.trim()))
        .map((note) => `- ${note.path && note.path !== '.github' ? `${note.path}${note.start_line ? `:${note.start_line}` : ''}: ` : ''}${note.message.replace(/\s+/g, ' ').trim()}`);
}

function failuresMarkdown(jobs) {
    const text = jobs.map((job) => [`## ${job.name}`, '', ...job.errors, '', '```text', job.log.replace(/```/g, "'''"), '```'].join('\n')).join('\n\n');
    return text.length > FAILURES_LIMIT ? `${text.slice(0, FAILURES_LIMIT)}\n\n(cut at ${FAILURES_LIMIT} characters)` : text;
}

function queueContext(options) {
    need(options, 'runId', 'repo', 'out');
    const api = (route) => JSON.parse(gh([`repos/${options.repo}/${route}`]));
    const run = api(`actions/runs/${options.runId}`);
    if (run.event !== 'merge_group' || run.conclusion !== 'failure') {
        console.error(`run ${options.runId} is a ${run.event} run that ended ${run.conclusion}, nothing to fix`);
        return;
    }
    const pr = Number(String(run.head_branch || '').match(QUEUE_BRANCH)?.[1]);
    if (!pr) {
        console.error(`no pull request in ${run.head_branch}`);
        return;
    }
    const pull = api(`pulls/${pr}`);
    if (pull.state !== 'open' || pull.head?.repo?.full_name !== options.repo) {
        console.error(`#${pr} is ${pull.state} or comes from another repository, nothing to fix`);
        return;
    }
    const jobs = api(`actions/runs/${options.runId}/jobs?per_page=100`).jobs
        .filter((job) => ['failure', 'timed_out'].includes(job.conclusion))
        .map((job) => ({ name: job.name, url: job.html_url, errors: jobErrors(api(`check-runs/${job.id}/annotations`)), log: logTail(gh([`repos/${options.repo}/actions/jobs/${job.id}/logs`])) }));
    const dir = path.join(options.out, 'queue');
    fs.mkdirSync(dir, { recursive: true });
    const context = { pr, headRef: pull.head.ref, headSha: pull.head.sha, runUrl: run.html_url, jobs: jobs.map(({ name, url }) => ({ name, url })) };
    fs.writeFileSync(path.join(dir, 'context.json'), JSON.stringify(context, null, 2));
    fs.writeFileSync(path.join(dir, 'failures.md'), failuresMarkdown(jobs));
    console.log([`pr=${pr}`, `head-ref=${pull.head.ref}`, `head-sha=${pull.head.sha}`, `merge-ref=refs/pull/${pr}/merge`].join('\n'));
}

function readQueue(out) {
    const file = path.join(out || '', 'queue', 'context.json');
    return out && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
}

async function queueFix(options) {
    need(options, 'base', 'head', 'out');
    const queue = readQueue(options.out);
    if (!queue) throw new Error('queue-fix needs the context queue-context writes');
    if (git(['rev-parse', `${options.head}^2`]).trim() !== queue.headSha) {
        console.log('the pull request moved since the queue run, nothing to fix');
        return;
    }
    if (git(['log', '-1', '--format=%s', `${options.head}^2`]).trim() === CONFIG.queueFixSubject) {
        console.log('head is the queue fix commit, nothing to fix');
        return;
    }
    const prompt = [
        `The merge queue sent pull request #${queue.pr} back: ${queue.runUrl}`,
        '',
        'Files the pull request changes:',
        ...changedFiles([options.base, options.head]).map((file) => `- ${file}`),
        '',
        '# Failed jobs',
        '',
        fs.readFileSync(path.join(options.out, 'queue', 'failures.md'), 'utf8'),
        '',
        fs.readFileSync(path.join(CI, 'queue-fix-prompt.md'), 'utf8'),
    ].join('\n');
    await fixSession(options, prompt, { subject: CONFIG.queueFixSubject, model: CONFIG.queueFixModel, effort: CONFIG.queueFixEffort });
}

const REVIEWED = /^<!-- reviewed ([0-9a-f]{40}) -->\n/;

function reviewedHead(body) {
    const text = String(body || '');
    if (!text.startsWith(`${CONFIG.commentMarker}\n\n`)) return null;
    return text.slice(CONFIG.commentMarker.length + 2).match(REVIEWED)?.[1] || null;
}

function previous(options) {
    need(options, 'out');
    const comments = fs.readFileSync(0, 'utf8').split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
    const last = comments.filter((comment) => reviewedHead(comment.body)).pop();
    if (!last) return;
    fs.mkdirSync(options.out, { recursive: true });
    fs.writeFileSync(path.join(options.out, 'previous.md'), last.body);
    console.log(reviewedHead(last.body));
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

const VERDICTS = { pass: ['TIP', 'Pass'], conditional: ['WARNING', 'Conditional'], block: ['CAUTION', 'Block'] };
const LANES = [['blocker', 'Blocker'], ['high', 'High'], ['medium', 'Medium'], ['low', 'Low']];
const alert = (kind, lines) => [`> [!${kind}]`, ...lines.map((line) => `> ${line}`)].join('\n');
const DIFF_LINES = 40;
const SNIPPET_LINES = 3;
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

function renderComment({ markdown, headSha, runUrl, repoUrl, since, fixSha, fixOutcome, fixRefused, fixReply, patch, withDiffs = true }) {
    const short = (sha) => String(sha).slice(0, 7);
    const data = markdown ? reviewJson(markdown) : null;
    if (!data || !data.verdict) {
        const text = markdown && markdown.trim()
            ? `Reviewed head: ${headSha}\n\n${markdown.trim()}`
            : alert('CAUTION', [`**Review failed.** The review of \`${short(headSha)}\` failed before it produced a result. See [the run](${runUrl}).`]);
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
        : fixRefused
            ? `The fix needed files outside this pull request, so nothing was pushed. See [the run](${runUrl}).`
            : fixOutcome === 'failure'
            ? `Fixing failed, nothing was pushed. See [the run](${runUrl}).`
            : CONFIG.fixVerdicts.includes(data.verdict) ? `Nothing was fixed, ${left.length} left for you.` : 'Nothing to fix.';
    const where = (f) => (f.file ? `[\`${String(f.file).split('/').pop()}${f.line ? `:${f.line}` : ''}\`](${repoUrl}/blob/${headSha}/${f.file}${f.line ? `#L${f.line}` : ''}) · ` : '');
    const snippet = (f) => {
        const line = Number(f.line);
        if (!/^[\w./-]+$/.test(String(f.file || '')) || !Number.isInteger(line) || line < 1) return '';
        return `${repoUrl}/blob/${headSha}/${f.file}#L${Math.max(1, line - SNIPPET_LINES)}-L${line + SNIPPET_LINES}`;
    };
    const item = (f) => {
        const { status, note } = statusOf(f);
        const body = [`${where(f)}\`${f.id}\``, `**Action:** ${f.required_action || ''}`, note ? `**${status === 'fixed' ? 'Fix' : 'Left'}:** ${note}` : ''].filter(Boolean).join('\n\n');
        const title = String(f.title || f.required_action || f.id).replace(/\s+/g, ' ').replace(/</g, '&lt;');
        return [`<details><summary>${title}${['fixed', 'skipped'].includes(status) ? ` <code>${status}</code>` : ''}</summary>\n\n${body}\n\n</details>`, diffBlock(byId.get(f.id) || []) || snippet(f)];
    };
    const [kind, verdict] = VERDICTS[data.verdict] || ['NOTE', data.verdict];
    const scope = isSha(since) ? ` · changes since \`${short(since)}\`` : '';
    const parts = [CONFIG.commentMarker, `<!-- reviewed ${headSha} -->`, alert(kind, [`**${verdict}** · ${counts}${scope}`, outcome])];
    for (const [key, label] of LANES) {
        const lane = findings.filter((f) => f.severity === key);
        if (lane.length) parts.push(`#### ${label} · ${lane.length}`, ...lane.flatMap(item));
    }
    if (other.length) parts.push('#### Other changes in the fix', diffBlock(other));
    parts.push(`<details><summary>Full review</summary>\n\n${withoutJson(markdown)}\n\n</details>`);
    parts.push(`<sub>qol-code-review · ${CONFIG.model} · head \`${short(headSha)}\` · [run](${runUrl})</sub>`);
    const body = `${parts.filter(Boolean).join('\n\n')}\n`;
    return body.length > COMMENT_LIMIT && withDiffs ? renderComment({ markdown, headSha, runUrl, repoUrl, since, fixSha, fixOutcome, fixRefused, fixReply, patch, withDiffs: false }) : body;
}

function renderQueueComment({ queue, runUrl, repoUrl, fixSha, fixOutcome, fixRefused, fixReply, patch }) {
    const short = (sha) => String(sha).slice(0, 7);
    const jobs = queue.jobs.map((job) => `[${job.name}](${job.url})`).join(', ') || 'no job reported';
    const again = 'Push a fix before queueing it again.';
    const outcome = fixSha
        ? `Fixed in [\`${short(fixSha)}\`](${repoUrl}/commit/${fixSha}). Queue it again once its checks pass.`
        : fixRefused
            ? `The fix needed files outside this pull request, so nothing was pushed. ${again}`
            : fixOutcome === 'failure'
                ? `Fixing failed, nothing was pushed. See [the run](${runUrl}). ${again}`
                : `Nothing was changed, so queueing this head again fails the same way unless the failure was flaky. ${again}`;
    const notes = (reviewJson(fixReply || '')?.fixes || []).filter((f) => f && f.note).map((f) => `- **${f.job || f.id}** <code>${f.status}</code> ${String(f.note).replace(/\s+/g, ' ')}`);
    const prose = withoutJson(fixReply || '').trim();
    return `${[
        CONFIG.queueCommentMarker,
        alert(fixSha ? 'TIP' : 'CAUTION', [`**Merge queue failed** · ${jobs}`, outcome]),
        notes.join('\n'),
        fixSha ? diffBlock(patchHunks(patch)) : '',
        prose ? `<details><summary>Fix session</summary>\n\n${prose}\n\n</details>` : '',
        `<sub>qol-code-review · ${CONFIG.queueFixModel} · head \`${short(queue.headSha)}\` · [queue run](${queue.runUrl}) · [run](${runUrl})</sub>`,
    ].filter(Boolean).join('\n\n')}\n`;
}

function comment(options) {
    need(options, 'out', 'headSha', 'runUrl', 'repoUrl');
    const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '');
    const queue = readQueue(options.out);
    if (queue) {
        const file = path.join(options.out, 'comment.md');
        fs.writeFileSync(file, renderQueueComment({
            queue,
            runUrl: options.runUrl,
            repoUrl: options.repoUrl,
            fixSha: options.fixSha,
            fixOutcome: options.fixOutcome,
            fixRefused: read(path.join(options.out, 'fix', 'refused.txt')).trim(),
            fixReply: read(path.join(options.out, 'fix', 'reply.md')),
            patch: read(path.join(options.out, 'fix', 'fix.patch')),
        }));
        console.log(file);
        return;
    }
    const markdown = read(path.join(options.out, 'review', 'review.md')) || read(path.join(options.out, 'reply.md'));
    const body = renderComment({
        markdown,
        headSha: options.headSha,
        since: read(path.join(options.out, 'review', 'since.txt')).trim(),
        runUrl: options.runUrl,
        repoUrl: options.repoUrl,
        fixSha: options.fixSha,
        fixOutcome: options.fixOutcome,
        fixRefused: read(path.join(options.out, 'fix', 'refused.txt')).trim(),
        fixReply: read(path.join(options.out, 'fix', 'reply.md')),
        patch: read(path.join(options.out, 'fix', 'fix.patch')),
    });
    const file = path.join(options.out, 'comment.md');
    fs.writeFileSync(file, body);
    console.log(file);
    if (!markdown.trim()) process.exitCode = 1;
}

async function run(argv) {
    const options = parseArgs(argv);
    const commands = {
        plugins: () => console.log(CONFIG.plugins.join('\n')),
        marker: () => console.log(readQueue(options.out) ? CONFIG.queueCommentMarker : CONFIG.commentMarker),
        review,
        fix,
        'queue-context': queueContext,
        'queue-fix': queueFix,
        'check-patch': checkPatch,
        previous,
        comment,
    };
    if (!commands[options.command]) throw new Error(`usage: ci-pr.cjs ${Object.keys(commands).join('|')} [--flag value ...]`);
    await commands[options.command](options);
}

if (require.main === module) {
    run(process.argv.slice(2)).catch((error) => {
        console.error(error.message);
        process.exitCode = 1;
    });
}

module.exports = { reviewReply, appliedFiles, refuseOutside, deniedReads, deniedWrites, parseArgs, lastVerdict, reviewJson, withoutJson, fixStatuses, patchHunks, renderComment, renderQueueComment, jobErrors, logTail, narrate, claude, CONFIG };
