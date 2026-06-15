#!/usr/bin/env node
/*
 * Workflow node: persist a finished code review to a temp markdown file.
 *
 * input : review markdown via --in <file> or piped on stdin, plus
 *         --verdict / --slug / optional --json / --out-dir / --run-id modifiers
 * work  : compute a stable temp run dir, write review.md (+ optional summary.json),
 *         and a machine-readable report.json
 * output: the canonical review.md path printed to stdout, the report path, and
 *         the next useful command
 *
 * The script owns the path convention so callers never hand-invent a temp path.
 * Fails early when the review content is empty or required inputs are missing.
 */

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const VERDICTS = new Set(['pass', 'conditional', 'block', 'invalid', 'unknown']);

function sanitizeSlug(value) {
    const slug = String(value || 'review')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 48);
    return slug || 'review';
}

function timestamp(date) {
    const pad = (value) => String(value).padStart(2, '0');
    return (
        `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
        `-${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
    );
}

function buildRunId(slug, now, suffix) {
    return `${timestamp(now)}-${sanitizeSlug(slug)}-${suffix}`;
}

function assertSafeSegment(value, label) {
    if (value.includes('/') || value.includes('\\') || value.split(/[\\/]/).includes('..') || value.includes('..')) {
        throw new Error(`${label} must not contain path separators or '..'`);
    }
}

function parseArgs(argv) {
    const options = {
        in: null,
        verdict: 'unknown',
        slug: 'review',
        title: null,
        json: null,
        outDir: process.env.CODE_REVIEW_OUT_DIR || null,
        runId: null,
        help: false,
    };

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index];

        if (arg === '-h' || arg === '--help') {
            options.help = true;
            continue;
        }

        const value = argv[index + 1];
        const requireValue = () => {
            if (value === undefined) {
                throw new Error(`${arg} requires a value`);
            }
            index += 1;
            return value;
        };

        switch (arg) {
            case '--in':
                options.in = requireValue();
                break;
            case '--verdict':
                options.verdict = requireValue().toLowerCase();
                break;
            case '--slug':
                options.slug = requireValue();
                break;
            case '--title':
                options.title = requireValue();
                break;
            case '--json':
                options.json = requireValue();
                break;
            case '--out-dir':
                options.outDir = requireValue();
                break;
            case '--run-id':
                options.runId = requireValue();
                break;
            default:
                throw new Error(`Unknown argument: ${arg}`);
        }
    }

    return options;
}

function readInput(options) {
    if (options.in) {
        return fs.readFileSync(options.in, 'utf8');
    }
    return fs.readFileSync(0, 'utf8');
}

function baseDir(options) {
    if (options.outDir) {
        return path.resolve(options.outDir);
    }
    return path.join(os.tmpdir(), 'code-review');
}

function save(options, now, suffix) {
    const markdown = readInput(options);
    if (!markdown.trim()) {
        throw new Error('Review content is empty; nothing to save');
    }

    const verdict = VERDICTS.has(options.verdict) ? options.verdict : 'unknown';

    let runId;
    if (options.runId) {
        assertSafeSegment(options.runId, '--run-id');
        runId = options.runId;
    } else {
        runId = buildRunId(options.slug, now, suffix);
    }

    const dir = path.join(baseDir(options), runId);
    fs.mkdirSync(dir, { recursive: true });

    const reviewPath = path.join(dir, 'review.md');
    fs.writeFileSync(reviewPath, markdown.endsWith('\n') ? markdown : `${markdown}\n`);

    const artifacts = { review: reviewPath };
    let summaryWarning = null;
    if (options.json) {
        try {
            const parsed = JSON.parse(fs.readFileSync(options.json, 'utf8'));
            const summaryPath = path.join(dir, 'summary.json');
            fs.writeFileSync(summaryPath, `${JSON.stringify(parsed, null, 2)}\n`);
            artifacts.summary = summaryPath;
        } catch (error) {
            summaryWarning = `Could not persist --json summary: ${error.message}`;
        }
    }

    const iso = now.toISOString();
    const reportPath = path.join(dir, 'report.json');
    const report = {
        name: 'code-review',
        started_at: iso,
        finished_at: iso,
        status: verdict,
        inputs: {
            slug: sanitizeSlug(options.slug),
            verdict,
            title: options.title || null,
            source: options.in ? path.resolve(options.in) : 'stdin',
        },
        artifacts,
        commands: [],
        next: [`open ${reviewPath}`],
    };
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

    return { dir, reviewPath, reportPath, verdict, artifacts, summaryWarning };
}

function printHelp() {
    process.stdout.write(
        [
            'save-review - persist a finished code review to a temp markdown file',
            '',
            'Usage:',
            '  node save-review.cjs --verdict <v> --slug <slug> --in <review.md>',
            '  cat review.md | node save-review.cjs --verdict <v> --slug <slug>',
            '',
            'Flags:',
            '  --in <file>      review markdown source (default: stdin)',
            '  --verdict <v>    pass|conditional|block|invalid (default: unknown)',
            '  --slug <slug>    short scope slug for the run id (default: review)',
            '  --title <text>   human label stored in report.json',
            '  --json <file>    persist a machine-parseable block as summary.json',
            '  --out-dir <dir>  base dir override (default: $CODE_REVIEW_OUT_DIR or os tmp)',
            '  --run-id <id>    run id override',
            '',
        ].join('\n'),
    );
}

function run(argv) {
    const options = parseArgs(argv);
    if (options.help) {
        printHelp();
        return;
    }

    if (!options.in && process.stdin.isTTY) {
        throw new Error('No review content: pass --in <file> or pipe markdown on stdin');
    }

    const now = new Date();
    const suffix = crypto.randomBytes(2).toString('hex');
    const result = save(options, now, suffix);

    if (result.summaryWarning) {
        console.warn(result.summaryWarning);
    }

    process.stdout.write(
        'code-review saved\n' +
        `  review:  ${result.reviewPath}\n` +
        `  report:  ${result.reportPath}\n` +
        (result.artifacts.summary ? `  summary: ${result.artifacts.summary}\n` : '') +
        `  verdict: ${result.verdict}\n` +
        `Next: open ${JSON.stringify(result.reviewPath)}\n`,
    );
}

if (require.main === module) {
    try {
        run(process.argv.slice(2));
    } catch (error) {
        console.error(error.message);
        process.exitCode = 1;
    }
}

module.exports = {
    sanitizeSlug,
    timestamp,
    buildRunId,
    assertSafeSegment,
    parseArgs,
    save,
    run,
};
