#!/usr/bin/env node
'use strict';

// Deterministic shallow-wrapper detector for the qol-code-review skill.
//
// input : --root <tree> plus --diff <unified diff file | -> (report only functions
//         touched by added lines) or --files <a.rs> <b.rs> ... (report every match);
//         optional --json <path>, --strict (exit 1 when anything is found),
//         --include-tests (also scan #[cfg(test)] regions)
// work  : find Rust functions whose whole body is one call expression, plus renamed
//         re-exports (`pub use a::b as c;`), in the scoped files
// output: one line per entry on stdout, optional JSON report; exit 0 (or 1 with --strict)

const fs = require('node:fs');
const path = require('node:path');

const FN_HEADER = /^(\s*)(?:pub(?:\([^)]*\))?\s+)?(?:(?:const|async|unsafe|extern\s+"[^"]*")\s+)*fn\s+([A-Za-z_]\w*)\s*[(<]/;
const CALL_BODY = /^\s*(?:return\s+)?([A-Za-z_][\w:.]*(?:::<[^>]*>)?)\s*\((.*)\)\s*\??\s*;?\s*$/;
const REEXPORT = /^\s*pub(?:\([^)]*\))?\s+use\s+([\w:]+)\s+as\s+(\w+)\s*;/;
const IMPL_HEADER = /^(\s*)impl\b(.*)\{\s*$/;

function parseArgs(argv) {
    const options = { root: process.cwd(), diff: null, files: [], json: null, strict: false, includeTests: false };
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--root') options.root = path.resolve(argv[++i]);
        else if (arg === '--diff') options.diff = argv[++i];
        else if (arg === '--json') options.json = argv[++i];
        else if (arg === '--strict') options.strict = true;
        else if (arg === '--include-tests') options.includeTests = true;
        else if (arg === '--files') {
            while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) options.files.push(argv[++i]);
        } else throw new Error(`unknown argument: ${arg}`);
    }
    if (!options.diff && options.files.length === 0) throw new Error('pass --diff <file|-> or --files <paths>');
    return options;
}

// Map of new-file path -> Set of added line numbers (post-image numbering).
function addedLinesFromDiff(text) {
    const added = new Map();
    let file = null;
    let line = 0;
    for (const raw of text.split('\n')) {
        if (raw.startsWith('+++ ')) {
            const target = raw.slice(4).trim();
            file = target === '/dev/null' ? null : target.replace(/^b\//, '');
            if (file && !added.has(file)) added.set(file, new Set());
            continue;
        }
        if (raw.startsWith('--- ') || raw.startsWith('diff ') || raw.startsWith('index ')) continue;
        const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
        if (hunk) { line = Number(hunk[1]); continue; }
        if (!file) continue;
        if (raw.startsWith('+')) { added.get(file).add(line); line += 1; }
        else if (raw.startsWith('-')) { /* removed line: no post-image number */ }
        else line += 1;
    }
    return added;
}

function testRegionStart(lines) {
    const index = lines.findIndex((l) => /^#\[cfg\(test\)\]/.test(l));
    return index === -1 ? lines.length : index;
}

function enclosingImpl(lines, headerIndex, headerIndent) {
    for (let i = headerIndex - 1; i >= 0; i -= 1) {
        const m = IMPL_HEADER.exec(lines[i]);
        if (m && m[1].length < headerIndent.length) {
            const text = lines[i].trim();
            return { text, traitImpl: /\bfor\b/.test(m[2]) };
        }
        if (/^\S/.test(lines[i]) && !IMPL_HEADER.test(lines[i]) && /^(pub\s+)?(fn|struct|enum|mod|use|const|static)\b/.test(lines[i])) return null;
    }
    return null;
}

function scanFile(relPath, lines, options, addedSet) {
    const limit = options.includeTests ? lines.length : testRegionStart(lines);
    const wrappers = [];
    const reexports = [];
    const touched = (lineNo) => !addedSet || addedSet.has(lineNo);
    for (let i = 0; i < limit; i += 1) {
        const re = REEXPORT.exec(lines[i]);
        if (re && touched(i + 1)) reexports.push({ file: relPath, line: i + 1, path: re[1], alias: re[2] });
        const header = FN_HEADER.exec(lines[i]);
        if (!header) continue;
        const indent = header[1];
        const name = header[2];
        // find the line that opens the body (or a trait declaration ending in ';')
        let open = i;
        let sawSemicolon = false;
        while (open < limit && !/\{\s*$/.test(lines[open])) {
            if (/;\s*$/.test(lines[open])) { sawSemicolon = true; break; }
            open += 1;
        }
        if (sawSemicolon || open >= limit) continue;
        let close = open + 1;
        while (close < limit && lines[close] !== `${indent}}`) close += 1;
        if (close >= limit) continue;
        const body = lines.slice(open + 1, close).filter((l) => l.trim() !== '' && !l.trim().startsWith('//'));
        if (body.length !== 1) continue;
        const call = CALL_BODY.exec(body[0]);
        if (!call || call[1].endsWith('!') || body[0].includes('!(')) continue;
        const lineNos = [];
        for (let n = i + 1; n <= close + 1; n += 1) lineNos.push(n);
        if (!lineNos.some(touched)) continue;
        const impl = enclosingImpl(lines, i, indent);
        wrappers.push({
            file: relPath,
            line: i + 1,
            name,
            callee: call[1],
            body: body[0].trim(),
            impl: impl ? impl.text : null,
            trait_impl: impl ? impl.traitImpl : false,
        });
        i = close;
    }
    return { wrappers, reexports };
}

function run(options) {
    let targets;
    if (options.diff) {
        const text = options.diff === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(options.diff, 'utf8');
        const added = addedLinesFromDiff(text);
        targets = [...added.entries()].filter(([file]) => file.endsWith('.rs')).map(([file, set]) => ({ file, set }));
    } else {
        targets = options.files.map((file) => ({ file: path.relative(options.root, path.resolve(options.root, file)).split(path.sep).join('/'), set: null }));
    }
    const report = { root: options.root, scanned: 0, wrappers: [], reexports: [] };
    for (const target of targets) {
        const abs = path.join(options.root, target.file);
        if (!fs.existsSync(abs)) continue;
        report.scanned += 1;
        const lines = fs.readFileSync(abs, 'utf8').split('\n');
        const found = scanFile(target.file, lines, options, target.set);
        report.wrappers.push(...found.wrappers);
        report.reexports.push(...found.reexports);
    }
    report.count = report.wrappers.length + report.reexports.length;
    return report;
}

function format(report) {
    const out = [];
    for (const w of report.wrappers) {
        const where = w.impl ? `  [${w.impl}${w.trait_impl ? ' (trait impl)' : ''}]` : '';
        out.push(`${w.file}:${w.line}  fn ${w.name} -> ${w.callee}${where}`);
    }
    for (const r of report.reexports) out.push(`${r.file}:${r.line}  pub use ${r.path} as ${r.alias}`);
    out.push(`shallow-wrappers: ${report.count} entr${report.count === 1 ? 'y' : 'ies'} in ${report.scanned} scanned file${report.scanned === 1 ? '' : 's'}`);
    return out.join('\n');
}

function main() {
    const options = parseArgs(process.argv.slice(2));
    const report = run(options);
    process.stdout.write(`${format(report)}\n`);
    if (options.json) {
        fs.mkdirSync(path.dirname(path.resolve(options.json)), { recursive: true });
        fs.writeFileSync(options.json, `${JSON.stringify(report, null, 2)}\n`);
    }
    process.exit(options.strict && report.count > 0 ? 1 : 0);
}

if (require.main === module) {
    try { main(); } catch (error) { process.stderr.write(`shallow-wrappers: ${error.message}\n`); process.exit(2); }
}

module.exports = { parseArgs, addedLinesFromDiff, scanFile, run, format };
