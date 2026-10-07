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
        '--output-format', 'json',
    ], { CLAUDE_CODE_SUBAGENT_MODEL: CONFIG.model, CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' });
    fs.writeFileSync(path.join(options.out, 'result.json'), raw);
    const result = JSON.parse(raw || '{}');
    console.log(`permission denials: ${JSON.stringify(result.permission_denials || [])}`);
    const reply = result.subtype === 'success' && result.is_error !== true ? String(result.result || '') : '';
    if (!reply.trim()) throw new Error(`the review produced no result (${result.subtype || 'no output'})`);
    const replyFile = path.join(options.out, 'reply.md');
    fs.writeFileSync(replyFile, reply);
    const saved = save({ in: replyFile, verdict: lastVerdict(reply), slug: 'pr', outDir: options.out, runId: 'review' }, new Date(), '0000');
    console.log(`verdict: ${saved.verdict}`);
}

function changedFiles(args) {
    return git(['diff', '--no-renames', '--name-only', ...args]).split('\n').filter(Boolean);
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
    const reply = claude(prompt, [
        '--settings', writeSettings(options.out),
        '--dangerously-skip-permissions',
        '--disallowedTools', ...CONFIG.fixDeniedTools, ...deniedReads(), ...deniedWrites(),
    ]);
    fs.writeFileSync(path.join(dir, 'reply.md'), reply);
    console.log(reply);
    git(['add', '-A']);
    const touched = changedFiles(['--cached']);
    const allowed = new Set(changedFiles([options.base, options.head]));
    const refused = touched.filter((file) => file.startsWith('.github/') || !allowed.has(file));
    if (refused.length) throw new Error(`the fix touches files outside the pull request diff or under .github/: ${refused.join(', ')}`);
    const patch = git(['diff', '--cached', '--binary']);
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

const ICONS = { pass: '✅', conditional: '⚠️', block: '⛔' };
const SEVERITIES = ['blocker', 'high', 'medium', 'low', 'note'];

function renderComment({ markdown, headSha, runUrl, repoUrl, fixSha, fixOutcome, fixReply }) {
    const short = (sha) => sha.slice(0, 7);
    const lines = [CONFIG.commentMarker];
    const data = markdown ? reviewJson(markdown) : null;
    if (!data || !data.verdict) {
        lines.push(markdown && markdown.trim() ? `Reviewed head: ${headSha}\n\n${markdown.trim()}` : `The review of \`${short(headSha)}\` failed before it produced a result. See [the run](${runUrl}).`);
        return `${lines.join('\n')}\n`;
    }
    const counts = SEVERITIES.filter((key) => data.counts?.[key] > 0).map((key) => `${data.counts[key]} ${key}`).join(' · ') || 'no findings';
    lines.push(`## ${ICONS[data.verdict] || '❔'} Code review: ${data.verdict}`, '', `Head \`${short(headSha)}\` · ${counts} · [run](${runUrl})`);
    const where = (f) => {
        const at = f.line ? `:${f.line}` : '';
        return `[\`${String(f.file).split('/').pop()}${at}\`](${repoUrl}/blob/${headSha}/${f.file}${f.line ? `#L${f.line}` : ''})`;
    };
    const cell = (text) => String(text || '').replace(/\n/g, ' ').replace(/\|/g, '\\|');
    for (const [title, key] of [['Must fix', 'must_fix'], ['Deferred', 'deferred_followups']]) {
        const rows = data[key] || [];
        if (!rows.length) continue;
        lines.push('', `### ${title}`, '', '| Severity | Finding | Where | Action |', '|---|---|---|---|');
        for (const f of rows) lines.push(`| ${cell(f.severity)} | ${cell(f.id)} | ${where(f)} | ${cell(f.required_action)} |`);
    }
    const fixes = fixSha
        ? `Pushed [\`${short(fixSha)}\`](${repoUrl}/commit/${fixSha}).`
        : fixOutcome === 'failure'
            ? `Fixing failed, nothing was pushed. See [the run](${runUrl}).`
            : fixReply
                ? 'No changes were needed.'
                : '';
    if (fixes) {
        lines.push('', '### Fixes', '', fixes);
        if (fixReply) lines.push('', '<details><summary>Fix notes</summary>', '', fixReply.trim(), '', '</details>');
    }
    lines.push('', '<details><summary>Full review</summary>', '', withoutJson(markdown), '', '</details>');
    return `${lines.join('\n')}\n`;
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

module.exports = { deniedReads, deniedWrites, parseArgs, lastVerdict, reviewJson, withoutJson, renderComment, CONFIG };
